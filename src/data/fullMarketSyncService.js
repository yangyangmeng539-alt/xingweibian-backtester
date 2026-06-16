const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  fetchDailyBarsFromPython,
  getPythonChildEnv
} = require('../workers/pythonWorker');
const {
  upsertDailyBars,
  getSymbolDateRange,
  beginDeferredCacheSave,
  endDeferredCacheSave,
  flushCacheToDisk,
  getCacheBackend,
  setCacheBackendPreference,
  isCacheWriteMemoryError
} = require('../core/localCache');
const { withWriteLock } = require('../core/writeLock');
const { runSqliteDiskCacheBridge } = require('../core/sqliteDiskCacheBridge');
const {
  CACHE_INDEX_VERSION,
  cacheIndexExists,
  loadCacheIndex,
  getCachedSymbolSummary,
  getCacheIndexPath
} = require('./cacheIndexService');
const {
  loadStockUniverse,
  filterStocksForSync,
  filterStocksForBaoStockAshareSync
} = require('./stockUniverseService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const ASHARE_BATCH_INCREMENTAL_ADAPTER_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'adapters',
  'aShareIncrementalBatchAdapter.py'
);
const SYNC_DIR = path.join(PROJECT_ROOT, 'data', 'sync');
const SYNC_STATE_PATH = path.join(SYNC_DIR, 'full-a-share-sync-state.json');
const SYNC_VERSION = 'dev-0.1.9.13';
const DEFAULT_FULL_CHUNK_YEARS = 30;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DAILY_BATCH_SIZE = 200;
const DEFAULT_ASHARE_FAST_DAILY_BATCH_SIZE = 30;
const DEFAULT_DAILY_BATCH_CONCURRENCY = 1;
const DEFAULT_BATCH_STATE_SAVE_INTERVAL = 100;
const DEFAULT_FAST_DAILY_WINDOW_DAYS = 10;
const ASHARE_SUSPENDED_FILTER_LAG_DAYS = 30;
const ASHARE_SYNC_END_DATE_PROBE_SYMBOLS = ['000001', '600519', '300750', '601318'];
const ASHARE_SYNC_END_DATE_PROBE_LOOKBACK_DAYS = 14;
const MAX_CONCURRENCY = 3;
const RECENT_MESSAGE_LIMIT = 8;
const DIAGNOSTIC_TEXT_LIMIT = 160;
const CACHE_FLUSH_SYMBOL_INTERVAL = 10;
const SKIPPED_SYMBOL_YIELD_INTERVAL = 50;
const SKIPPED_SYMBOL_YIELD_MS = 25;
const SYNC_STATE_RENAME_RETRY_DELAYS = [100, 200, 300, 500, 800, 1200];
const DIAGNOSTIC_KEYS = [
  'rawError',
  'akshareError',
  'eastmoneyError',
  'altDailyError',
  'lastTransportError'
];
const INCREMENTAL_NO_NEW_DATA_STATUS = 'NO_NEW_DATA';
const INCREMENTAL_NO_NEW_DATA_REASON = '增量区间暂无新日线';
const BJ_FALLBACK_START_DATE = '20130101';
const BJ_920_FALLBACK_START_DATE = '20200101';
const DONE_LIKE_STATUSES = new Set([
  'DONE',
  'PARTIAL_DONE',
  'DONE_WITH_GAPS',
  'PARTIAL_DONE_VALID'
]);

const deferredStateSaveRuntime = new WeakMap();

const DEFAULT_SYNC_OPTIONS = {
  mode: 'full',
  currentSymbol: '',
  symbols: [],
  markets: [],
  startDate: '20180101',
  endDate: '',
  batchSize: 20,
  force: false,
  retryFailed: true,
  maxCount: 0,
  throttleMs: 200,
  batchPauseMs: 300,
  failPauseMs: 300,
  maxRetriesPerSymbol: 5,
  fullChunkYears: DEFAULT_FULL_CHUNK_YEARS,
  concurrency: DEFAULT_CONCURRENCY,
  fastDaily: true,
  dailyBatchSize: DEFAULT_DAILY_BATCH_SIZE,
  dailyBatchConcurrency: DEFAULT_DAILY_BATCH_CONCURRENCY,
  fillMissing: false
};

function ensureSyncDir() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
}

function getSyncStatePath() {
  return SYNC_STATE_PATH;
}

function nowIso() {
  return new Date().toISOString();
}

function compactErrorMessage(error, limit = 260) {
  const text = String(error && error.message ? error.message : error || '未知错误')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function isRetryableFileError(error) {
  return Boolean(error && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
}

function makeSyncStateTempPath() {
  const unique = [
    process.pid,
    Date.now(),
    Math.random().toString(36).slice(2, 10)
  ].join('.');

  return `${SYNC_STATE_PATH}.${unique}.tmp`;
}

function removeFileQuietly(filePath) {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_error) {
    // 临时文件清理失败不应中断同步。
  }
}

async function renameWithRetry(tempPath, targetPath) {
  let lastError = null;

  for (let attempt = 0; attempt <= SYNC_STATE_RENAME_RETRY_DELAYS.length; attempt += 1) {
    try {
      fs.renameSync(tempPath, targetPath);
      return {
        ok: true,
        fallback: false
      };
    } catch (error) {
      lastError = error;

      if (!isRetryableFileError(error) || attempt >= SYNC_STATE_RENAME_RETRY_DELAYS.length) {
        break;
      }

      await sleep(SYNC_STATE_RENAME_RETRY_DELAYS[attempt]);
    }
  }

  try {
    fs.copyFileSync(tempPath, targetPath);
    removeFileQuietly(tempPath);
    return {
      ok: true,
      fallback: true
    };
  } catch (fallbackError) {
    return {
      ok: false,
      error: fallbackError,
      renameError: lastError
    };
  }
}

function compactDiagnosticText(value, limit = DIAGNOSTIC_TEXT_LIMIT) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function compactDiagnosticFields(target) {
  if (!target || typeof target !== 'object') {
    return target;
  }

  for (const key of DIAGNOSTIC_KEYS) {
    if (target[key]) {
      target[key] = compactDiagnosticText(target[key]);
    }
  }

  if (target.error) {
    target.error = compactErrorMessage(target.error);
  }

  return target;
}

function compactChunkDiagnostics(chunks) {
  if (!Array.isArray(chunks)) {
    return [];
  }

  return chunks.map((chunk) => compactDiagnosticFields({ ...(chunk || {}) }));
}

function compactSyncStateDiagnostics(state) {
  if (!state || typeof state !== 'object') {
    return state;
  }

  state.lastError = compactDiagnosticText(state.lastError || '');

  for (const item of Object.values(state.items || {})) {
    compactDiagnosticFields(item);
    item.failedChunks = compactChunkDiagnostics(item.failedChunks);
    item.emptyChunks = compactChunkDiagnostics(item.emptyChunks);
  }

  return state;
}

function createEmptySyncState() {
  return {
    version: SYNC_VERSION,
    updatedAt: '',
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    running: false,
    startedAt: '',
    finishedAt: '',
    lastError: '',
    lastSaveError: '',
    cacheBackend: getCacheBackend(),
    concurrency: DEFAULT_CONCURRENCY,
    fastDaily: true,
    dailyBatchSize: DEFAULT_DAILY_BATCH_SIZE,
    dailyBatchConcurrency: DEFAULT_DAILY_BATCH_CONCURRENCY,
    fillMissing: false,
    activeWorkers: 0,
    runningSymbols: [],
    selectedSymbols: [],
    requestedCalendarEndDate: '',
    resolvedTargetEndDate: '',
    recentMessages: [],
    items: {}
  };
}

function normalizeSyncState(rawState) {
  const state = {
    ...createEmptySyncState(),
    ...(rawState && typeof rawState === 'object' ? rawState : {})
  };

  state.version = SYNC_VERSION;
  state.total = Number(state.total) || 0;
  state.done = Number(state.done) || 0;
  state.failed = Number(state.failed) || 0;
  state.skipped = Number(state.skipped) || 0;
  state.running = Boolean(state.running);
  state.lastSaveError = state.lastSaveError ? compactErrorMessage(state.lastSaveError) : '';
  state.cacheBackend = state.cacheBackend ? String(state.cacheBackend) : getCacheBackend();
  state.concurrency = normalizeConcurrency(state.concurrency, DEFAULT_CONCURRENCY);
  state.activeWorkers = Number(state.activeWorkers) || 0;
  state.runningSymbols = Array.isArray(state.runningSymbols) ? state.runningSymbols : [];
  state.selectedSymbols = Array.isArray(state.selectedSymbols) ? state.selectedSymbols : [];
  state.requestedCalendarEndDate = String(state.requestedCalendarEndDate || '');
  state.resolvedTargetEndDate = String(state.resolvedTargetEndDate || '');
  state.recentMessages = Array.isArray(state.recentMessages) ? state.recentMessages.slice(-RECENT_MESSAGE_LIMIT) : [];
  state.items = state.items && typeof state.items === 'object' ? state.items : {};

  return compactSyncStateDiagnostics(state);
}

function loadSyncState() {
  if (!fs.existsSync(SYNC_STATE_PATH)) {
    return createEmptySyncState();
  }

  try {
    return normalizeSyncState(JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8')));
  } catch (error) {
    return {
      ...createEmptySyncState(),
      lastError: `同步状态读取失败：${compactErrorMessage(error)}`
    };
  }
}

function saveSyncState(state) {
  compactSyncStateDiagnostics(state);
  state.version = SYNC_VERSION;
  state.updatedAt = nowIso();

  return withWriteLock(async () => {
    let tempPath = '';

    ensureSyncDir();

    try {
      state.lastSaveError = '';
      const stateText = `${JSON.stringify(state)}\n`;
      tempPath = makeSyncStateTempPath();
      fs.writeFileSync(tempPath, stateText, 'utf8');

      const result = await renameWithRetry(tempPath, SYNC_STATE_PATH);

      if (result.ok) {
        removeFileQuietly(tempPath);
        return {
          ok: true,
          fallback: result.fallback,
          statePath: SYNC_STATE_PATH
        };
      }

      const renameMessage = result.renameError ? `rename: ${compactErrorMessage(result.renameError)}` : '';
      const fallbackMessage = result.error ? `fallback: ${compactErrorMessage(result.error)}` : '';
      state.lastSaveError = [renameMessage, fallbackMessage].filter(Boolean).join('；') || '状态文件保存失败。';

      return {
        ok: false,
        error: state.lastSaveError,
        statePath: SYNC_STATE_PATH
      };
    } catch (error) {
      state.lastSaveError = compactErrorMessage(error);

      return {
        ok: false,
        error: state.lastSaveError,
        statePath: SYNC_STATE_PATH
      };
    } finally {
      removeFileQuietly(tempPath);
    }
  });
}

function getDeferredStateSaveRuntime(state) {
  if (!state || typeof state !== 'object') {
    return {
      enabled: false,
      interval: DEFAULT_BATCH_STATE_SAVE_INTERVAL,
      pending: 0
    };
  }

  let runtime = deferredStateSaveRuntime.get(state);

  if (!runtime) {
    runtime = {
      enabled: false,
      interval: DEFAULT_BATCH_STATE_SAVE_INTERVAL,
      pending: 0
    };
    deferredStateSaveRuntime.set(state, runtime);
  }

  return runtime;
}

function configureDeferredSyncStateSave(state, options = {}) {
  const runtime = getDeferredStateSaveRuntime(state);
  runtime.enabled = Boolean(options.enabled);
  runtime.interval = Math.max(
    1,
    Number(options.interval) || DEFAULT_BATCH_STATE_SAVE_INTERVAL
  );

  if (!runtime.enabled) {
    runtime.pending = 0;
  }

  return runtime;
}

async function saveSyncStateMaybeDeferred(state, options = {}) {
  const runtime = getDeferredStateSaveRuntime(state);

  if (!runtime.enabled || options.force) {
    runtime.pending = 0;
    return saveSyncState(state);
  }

  runtime.pending += 1;

  if (runtime.pending >= runtime.interval) {
    runtime.pending = 0;
    return saveSyncState(state);
  }

  return {
    ok: true,
    deferred: true,
    statePath: SYNC_STATE_PATH
  };
}

async function flushDeferredSyncStateSave(state) {
  const runtime = getDeferredStateSaveRuntime(state);

  if (!runtime.enabled || runtime.pending <= 0) {
    return {
      ok: true,
      skipped: true,
      statePath: SYNC_STATE_PATH
    };
  }

  runtime.pending = 0;
  return saveSyncState(state);
}

function upsertDailyBarsLocked(symbol, bars) {
  return withWriteLock(() => upsertDailyBars(symbol, bars));
}

function beginDeferredCacheSaveLocked() {
  return withWriteLock(() => beginDeferredCacheSave());
}

function flushCacheToDiskLocked() {
  return withWriteLock(() => flushCacheToDisk());
}

function endDeferredCacheSaveLocked(options = {}) {
  return withWriteLock(() => endDeferredCacheSave({ flush: options.flush !== false }));
}

function normalizeDateText(value, fallback) {
  const text = String(value || fallback || '').trim().replace(/-/g, '');

  if (!/^\d{8}$/.test(text)) {
    throw new Error(`日期格式必须是 YYYYMMDD，例如 19900101。当前输入：${value}`);
  }

  return text;
}

function getTodayAkDate() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatAkDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function addDaysToDateText(value, days) {
  const text = compactDateText(value);

  if (!text) {
    return '';
  }

  const date = new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8))
  );

  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  date.setDate(date.getDate() + days);
  return formatAkDate(date);
}

function isBjCandidateSymbol(symbol) {
  const text = String(symbol || '').trim();
  return text.startsWith('8') || text.startsWith('4') || text.startsWith('920');
}

function isBjStock(stock) {
  const market = String(stock && stock.market || '').trim().toUpperCase();
  return market === 'BJ' || isBjCandidateSymbol(stock && stock.symbol);
}

function getMarketFallbackStartDate(stock) {
  const symbol = String(stock && stock.symbol || '').trim();

  if (!isBjStock(stock)) {
    return '';
  }

  return symbol.startsWith('920') ? BJ_920_FALLBACK_START_DATE : BJ_FALLBACK_START_DATE;
}

function maxDateText(...values) {
  return values
    .map((value) => compactDateText(value))
    .filter(Boolean)
    .reduce((max, value) => (value > max ? value : max), '');
}

function getInitialFetchStartDate(stock, fallbackStartDate) {
  const fallbackText = compactDateText(fallbackStartDate);
  const listingText = compactDateText(
    stock && (stock.listDate || stock.listingDate || stock.listedDate || stock.ipoDate)
  );

  if (listingText) {
    return maxDateText(fallbackText, listingText);
  }

  return maxDateText(fallbackText, getMarketFallbackStartDate(stock)) || DEFAULT_SYNC_OPTIONS.startDate;
}

function normalizeInteger(value, fallback, min) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.max(min, Math.floor(num));
}

function normalizeConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  const concurrency = Math.floor(num);
  return Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeSyncSymbol(symbol) {
  const text = String(symbol || '').trim();

  if (!/^\d{1,6}$/.test(text)) {
    throw new Error(`非法 A 股代码：${symbol}。symbols 参数只接受 1-6 位数字。`);
  }

  return text.padStart(6, '0');
}

function normalizeSyncSymbols(symbols) {
  const rawList = [];

  if (Array.isArray(symbols)) {
    for (const item of symbols) {
      rawList.push(...String(item || '').split(/[,，\s]+/));
    }
  } else {
    rawList.push(...String(symbols || '').split(/[,，\s]+/));
  }

  const seen = new Set();
  const cleanSymbols = [];

  for (const symbol of rawList) {
    if (!symbol) {
      continue;
    }

    const cleanSymbol = normalizeSyncSymbol(symbol);

    if (seen.has(cleanSymbol)) {
      continue;
    }

    seen.add(cleanSymbol);
    cleanSymbols.push(cleanSymbol);
  }

  return cleanSymbols;
}

function normalizeSyncOptions(options = {}) {
  const merged = {
    ...DEFAULT_SYNC_OPTIONS,
    ...(options || {})
  };
  const symbols = normalizeSyncSymbols(merged.symbols);
  const requestedMode = String(merged.mode || 'full').trim().toLowerCase();
  const mode = symbols.length > 0 ? 'symbols' : requestedMode;

  return {
    ...merged,
    mode,
    symbols,
    startDate: normalizeDateText(merged.startDate, DEFAULT_SYNC_OPTIONS.startDate),
    endDate: merged.endDate ? normalizeDateText(merged.endDate, getTodayAkDate()) : getTodayAkDate(),
    endDateExplicit: Boolean(merged.endDate),
    requestedCalendarEndDate: '',
    resolvedTargetEndDate: '',
    batchSize: normalizeInteger(merged.batchSize, DEFAULT_SYNC_OPTIONS.batchSize, 1),
    maxCount: mode === 'symbols'
      ? 0
      : normalizeInteger(merged.maxCount, DEFAULT_SYNC_OPTIONS.maxCount, 0),
    throttleMs: normalizeInteger(merged.throttleMs, DEFAULT_SYNC_OPTIONS.throttleMs, 0),
    batchPauseMs: normalizeInteger(merged.batchPauseMs, DEFAULT_SYNC_OPTIONS.batchPauseMs, 0),
    failPauseMs: normalizeInteger(merged.failPauseMs, DEFAULT_SYNC_OPTIONS.failPauseMs, 0),
    maxRetriesPerSymbol: normalizeInteger(merged.maxRetriesPerSymbol, DEFAULT_SYNC_OPTIONS.maxRetriesPerSymbol, 0),
    fullChunkYears: normalizeInteger(merged.fullChunkYears, DEFAULT_SYNC_OPTIONS.fullChunkYears, 1),
    concurrency: normalizeConcurrency(merged.concurrency, DEFAULT_SYNC_OPTIONS.concurrency),
    fastDaily: normalizeBoolean(merged.fastDaily, DEFAULT_SYNC_OPTIONS.fastDaily),
    dailyBatchSize: normalizeInteger(merged.dailyBatchSize, DEFAULT_SYNC_OPTIONS.dailyBatchSize, 1),
    dailyBatchConcurrency: normalizeConcurrency(merged.dailyBatchConcurrency, DEFAULT_SYNC_OPTIONS.dailyBatchConcurrency),
    fillMissing: normalizeBoolean(merged.fillMissing, DEFAULT_SYNC_OPTIONS.fillMissing),
    force: normalizeBoolean(merged.force, DEFAULT_SYNC_OPTIONS.force),
    retryFailed: normalizeBoolean(merged.retryFailed, DEFAULT_SYNC_OPTIONS.retryFailed)
  };
}

function formatElapsedMs(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`;
  }

  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }

  return `${seconds}秒`;
}

function getStateElapsedText(state) {
  const startedAtMs = state && state.startedAt ? Date.parse(state.startedAt) : NaN;
  const finishedAtMs = state && state.finishedAt ? Date.parse(state.finishedAt) : Date.now();

  if (!Number.isFinite(startedAtMs)) {
    return '';
  }

  return formatElapsedMs(Math.max(0, finishedAtMs - startedAtMs));
}


function sleep(ms) {
  const waitMs = Number(ms) || 0;

  if (waitMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

function compactDateText(value) {
  const text = String(value || '').trim().replace(/-/g, '');
  return /^\d{8}$/.test(text) ? text : '';
}

function dateTextToTime(value) {
  const text = compactDateText(value);

  if (!text) {
    return NaN;
  }

  return new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8))
  ).getTime();
}

function dateTextToDate(value) {
  const text = compactDateText(value);

  if (!text) {
    return null;
  }

  const date = new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8))
  );

  return Number.isFinite(date.getTime()) ? date : null;
}

function getChunkEndDate(startDate, requestedEndDate, chunkYears) {
  const start = dateTextToDate(startDate);
  const requestedEndText = compactDateText(requestedEndDate);

  if (!start || !requestedEndText) {
    return '';
  }

  const chunkEnd = new Date(start.getTime());
  chunkEnd.setFullYear(chunkEnd.getFullYear() + chunkYears);
  chunkEnd.setDate(chunkEnd.getDate() - 1);

  const chunkEndText = formatAkDate(chunkEnd);
  return chunkEndText > requestedEndText ? requestedEndText : chunkEndText;
}

function buildFullChunks(startDate, endDate, chunkYears = DEFAULT_FULL_CHUNK_YEARS) {
  const chunks = [];
  const endText = compactDateText(endDate);
  let currentStart = compactDateText(startDate);
  let guard = 0;

  while (currentStart && endText && currentStart <= endText && guard < 200) {
    const currentEnd = getChunkEndDate(currentStart, endText, chunkYears);

    if (!currentEnd) {
      break;
    }

    chunks.push({
      startDate: currentStart,
      endDate: currentEnd
    });

    currentStart = addDaysToDateText(currentEnd, 1);
    guard += 1;
  }

  return chunks;
}

function getLatestBarDateFromBars(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let latest = '';

  for (const bar of list) {
    const dateText = compactDateText(bar && bar.date);

    if (dateText && dateText > latest) {
      latest = dateText;
    }
  }

  return latest;
}

async function probeAshareLatestTradingDate(syncOptions) {
  const requestedEndDate = compactDateText(syncOptions.endDate) || getTodayAkDate();
  const probeStartDate = addDaysToDateText(
    requestedEndDate,
    -ASHARE_SYNC_END_DATE_PROBE_LOOKBACK_DAYS
  ) || requestedEndDate;

  const errors = [];

  for (const symbol of ASHARE_SYNC_END_DATE_PROBE_SYMBOLS) {
    try {
      const result = await fetchDailyBarsFromPython({
        symbol,
        startDate: probeStartDate,
        endDate: requestedEndDate,
        adjust: 'qfq'
      });

      const bars = result && Array.isArray(result.bars) ? result.bars : [];
      const latestDate = getLatestBarDateFromBars(bars);

      if (latestDate) {
        return {
          ok: true,
          symbol,
          latestDate,
          requestedEndDate,
          source: result.source || ''
        };
      }

      errors.push(`${symbol} 探测返回空日线`);
    } catch (error) {
      errors.push(`${symbol} ${compactErrorMessage(error)}`);
    }
  }

  return {
    ok: false,
    latestDate: '',
    requestedEndDate,
    error: errors.slice(-4).join('；')
  };
}

async function resolveAshareSyncTargetEndDate(syncOptions, state, stocks, onProgress) {
  const requestedEndDate = compactDateText(syncOptions.endDate) || getTodayAkDate();

  syncOptions.requestedCalendarEndDate = requestedEndDate;
  syncOptions.resolvedTargetEndDate = requestedEndDate;

  state.requestedCalendarEndDate = requestedEndDate;
  state.resolvedTargetEndDate = requestedEndDate;

  if (syncOptions.endDateExplicit) {
    await saveSyncState(state);
    return requestedEndDate;
  }

  emitProgress(onProgress, state, stocks, {
    currentSymbol: '-',
    currentStatus: 'PROBING',
    lastMessage: `正在探测 A股最新可用交易日，当前日历目标 ${requestedEndDate}。`
  });

  const probe = await probeAshareLatestTradingDate(syncOptions);

  if (!probe.ok || !probe.latestDate) {
    await saveSyncState(state);

    emitProgress(onProgress, state, stocks, {
      currentSymbol: '-',
      currentStatus: 'PROBE_FALLBACK',
      lastMessage: `A股最新交易日探测失败，继续使用日历目标 ${requestedEndDate}。${probe.error || ''}`
    });

    return requestedEndDate;
  }

  const resolvedDate = probe.latestDate > requestedEndDate
    ? requestedEndDate
    : probe.latestDate;

  syncOptions.resolvedTargetEndDate = resolvedDate;
  syncOptions.endDate = resolvedDate;

  state.requestedCalendarEndDate = requestedEndDate;
  state.resolvedTargetEndDate = resolvedDate;

  await saveSyncState(state);

  emitProgress(onProgress, state, stocks, {
    currentSymbol: probe.symbol || '-',
    currentStatus: 'PROBED',
    lastMessage: resolvedDate === requestedEndDate
      ? `A股最新可用交易日：${resolvedDate}，source=${probe.source || '-'}。`
      : `A股日历目标 ${requestedEndDate} 修正为最新可用交易日 ${resolvedDate}，source=${probe.source || '-'}。`
  });

  return resolvedDate;
}

function isShortDailyIncremental(startDate, endDate) {
  const startTime = dateTextToTime(startDate);
  const endTime = dateTextToTime(endDate);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return false;
  }

  const diffDays = Math.floor((endTime - startTime) / 86400000);
  return diffDays >= 0 && diffDays <= DEFAULT_FAST_DAILY_WINDOW_DAYS;
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const step = Math.max(1, Number(size) || DEFAULT_DAILY_BATCH_SIZE);
  const result = [];

  for (let index = 0; index < list.length; index += step) {
    result.push(list.slice(index, index + step));
  }

  return result;
}

function parseAdapterJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`A股批量日更 Worker 没有返回 JSON：${text.slice(0, 300)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function runAshareIncrementalBatchAdapter(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON || 'python',
      [ASHARE_BATCH_INCREMENTAL_ADAPTER_PATH],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: getPythonChildEnv('direct')
      }
    );

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;
      child.kill('SIGKILL');
      reject(new Error('A股批量日更 Worker 超时。'));
    }, 300000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      try {
        const data = parseAdapterJson(stdout);

        if (!data.ok) {
          throw new Error([data.error || '', data.traceback || '', stderr || ''].filter(Boolean).join('\n'));
        }

        resolve(data);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function loadAshareCacheRangeIndex() {
  const result = await runSqliteDiskCacheBridge('build-index-summary');
  const items = result && result.items && typeof result.items === 'object'
    ? result.items
    : {};

  const index = new Map();

  for (const [symbol, item] of Object.entries(items)) {
    const cleanSymbol = String(symbol || '').trim().toUpperCase();

    index.set(cleanSymbol, {
      symbol: cleanSymbol,
      count: Number(item && (item.barCount || item.count)) || 0,
      startDate: item && item.startDate || '',
      endDate: item && item.endDate || '',
      source: 'disk_sqlite_index',
      indexHit: true
    });
  }

  return index;
}

function getCacheSnapshotFromRangeIndex(cacheRangeIndex, symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  const range = cacheRangeIndex && cacheRangeIndex.get(cleanSymbol);

  if (range) {
    return range;
  }

  return {
    symbol: cleanSymbol,
    count: 0,
    startDate: '',
    endDate: '',
    source: 'disk_sqlite_index',
    indexHit: false
  };
}

function getDateLagDays(fromDate, toDate) {
  const fromText = compactDateText(fromDate);
  const toText = compactDateText(toDate);

  if (!fromText || !toText) {
    return null;
  }

  const fromTime = dateTextToTime(fromText);
  const toTime = dateTextToTime(toText);

  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
    return null;
  }

  return Math.floor((toTime - fromTime) / 86400000);
}

function isLikelySuspendedByCache(cache, targetEndDate) {
  const cachedEnd = compactDateText(cache && cache.endDate);

  if (Number(cache && cache.count) <= 0 || !cachedEnd) {
    return false;
  }

  const lagDays = getDateLagDays(cachedEnd, targetEndDate);

  return Number.isFinite(lagDays) && lagDays >= ASHARE_SUSPENDED_FILTER_LAG_DAYS;
}

function toDisplayDateText(value) {
  const text = compactDateText(value);

  if (!text) {
    return '';
  }

  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function mergeCacheSnapshotWithBars(cache, bars) {
  const list = Array.isArray(bars) ? bars : [];
  let startDate = toDisplayDateText(cache && cache.startDate);
  let endDate = toDisplayDateText(cache && cache.endDate);
  let validAdded = 0;

  for (const bar of list) {
    const date = toDisplayDateText(bar && bar.date);

    if (!date) {
      continue;
    }

    validAdded += 1;

    if (!startDate || date < startDate) {
      startDate = date;
    }

    if (!endDate || date > endDate) {
      endDate = date;
    }
  }

  return {
    count: (Number(cache && cache.count) || 0) + validAdded,
    startDate,
    endDate,
    source: 'memory_merged_after_batch',
    indexHit: true
  };
}

function isCacheCloseToRequestedEnd(cachedEndDate, requestedEndDate) {
  const cachedText = compactDateText(cachedEndDate);
  const requestedText = compactDateText(requestedEndDate);

  return Boolean(cachedText && requestedText && cachedText >= requestedText);
}

async function getCacheSnapshot(symbol, options = {}) {
  const summary = options.preferSqlite
    ? null
    : getCachedSymbolSummary(symbol, options.cacheIndex);

  if (summary) {
    return {
      count: Number(summary.barCount) || 0,
      startDate: summary.startDate || '',
      endDate: summary.endDate || '',
      source: 'cache-index',
      indexHit: true
    };
  }

  const sqliteSummaryReader = typeof options.sqliteSummaryReader === 'function'
    ? options.sqliteSummaryReader
    : getSymbolDateRange;
  const range = await sqliteSummaryReader(symbol);

  return {
    count: Number(range.count) || 0,
    startDate: range.startDate || '',
    endDate: range.endDate || '',
    source: 'sqlite-symbol',
    indexHit: false
  };
}

async function buildSyncPlan(stock, syncOptions, cacheIndex) {
  const cache = syncOptions.cacheRangeIndex
    ? getCacheSnapshotFromRangeIndex(syncOptions.cacheRangeIndex, stock.symbol)
    : await getCacheSnapshot(stock.symbol, { preferSqlite: true });
  const hasLocalData = cache.count > 0 && Boolean(compactDateText(cache.endDate));
  const fetchEndDate = syncOptions.endDate;

  if (!syncOptions.force && hasLocalData && isCacheCloseToRequestedEnd(cache.endDate, fetchEndDate)) {
    return {
      syncMode: 'SKIPPED',
      fetchStartDate: '',
      fetchEndDate,
      chunks: [],
      addedBars: 0,
      cache,
      reason: `${stock.symbol} 本地缓存已到目标日期，已跳过。`
    };
  }

  if (!hasLocalData || syncOptions.force) {
    const fetchStartDate = getInitialFetchStartDate(stock, syncOptions.startDate);

    return {
      syncMode: 'FULL_CHUNKED',
      fetchStartDate,
      fetchEndDate,
      chunks: buildFullChunks(fetchStartDate, fetchEndDate, syncOptions.fullChunkYears),
      addedBars: 0,
      cache,
      reason: ''
    };
  }

  return {
    syncMode: 'INCREMENTAL',
    fetchStartDate: addDaysToDateText(cache.endDate, 1),
    fetchEndDate,
    chunks: [],
    addedBars: 0,
    cache,
    reason: ''
  };
}

function isStopRequested(syncOptions) {
  const signal = syncOptions && syncOptions.stopSignal;
  return Boolean(signal && (signal.requested || signal.stopped || signal.stopRequested));
}

function requestStop(syncOptions) {
  if (!syncOptions) {
    return;
  }

  if (!syncOptions.stopSignal) {
    syncOptions.stopSignal = {};
  }

  syncOptions.stopSignal.requested = true;
}

function getCacheWriteStopMessage(error) {
  return error && error.message
    ? compactErrorMessage(error)
    : '缓存写盘内存不足，已停止同步，请切换 disk_sqlite 后端或降低并发后继续。';
}

function getSelectedSymbols(stocks) {
  return stocks.map((stock) => stock.symbol);
}

function isNoNewDataStatus(status) {
  return status === INCREMENTAL_NO_NEW_DATA_STATUS || status === 'SKIPPED_NO_NEW_BAR';
}

function isDoneLikeStatus(status) {
  return DONE_LIKE_STATUSES.has(status);
}

function isSkippedLikeStatus(status) {
  return status === 'SKIPPED' || isNoNewDataStatus(status);
}

function getRunningSymbols(state) {
  return Array.isArray(state && state.runningSymbols) ? state.runningSymbols : [];
}

function setSymbolRunning(state, stock, running) {
  const symbol = String(stock && stock.symbol || '').trim();
  const current = getRunningSymbols(state);
  const nextSymbols = current.filter((item) => item !== symbol);

  if (running && symbol) {
    nextSymbols.push(symbol);
  }

  state.runningSymbols = nextSymbols;
  state.activeWorkers = nextSymbols.length;
}

function pushRecentMessage(state, input = {}) {
  const message = String(input.lastMessage || '').trim();

  if (!message) {
    return;
  }

  const recentMessages = Array.isArray(state.recentMessages) ? state.recentMessages : [];
  recentMessages.push({
    at: nowIso(),
    symbol: input.currentSymbol || '',
    status: input.currentStatus || '',
    message
  });
  state.recentMessages = recentMessages.slice(-RECENT_MESSAGE_LIMIT);
}

function getRecentMessageSymbols(state) {
  const recentMessages = Array.isArray(state && state.recentMessages) ? state.recentMessages : [];
  const seen = new Set();
  const symbols = [];

  for (const item of recentMessages) {
    const symbol = String(item && item.symbol || '').trim();

    if (!symbol || seen.has(symbol)) {
      continue;
    }

    seen.add(symbol);
    symbols.push(symbol);
  }

  return symbols;
}

function createSymbolsScopeError(message) {
  const error = new Error(message || 'symbols 模式未匹配到股票，已阻止全市场同步');
  error.code = 'SYMBOLS_SCOPE_BLOCKED';
  return error;
}

function isSymbolsScopeError(error) {
  return Boolean(error && error.code === 'SYMBOLS_SCOPE_BLOCKED');
}

function selectSymbolStocks(symbols, universeStocks) {
  const requestedSymbols = normalizeSyncSymbols(symbols);
  const activeUniverse = filterStocksForSync({
    mode: 'full',
    universe: Array.isArray(universeStocks) ? universeStocks : []
  });
  const stockBySymbol = new Map();

  for (const stock of activeUniverse) {
    if (requestedSymbols.includes(stock.symbol) && !stockBySymbol.has(stock.symbol)) {
      stockBySymbol.set(stock.symbol, stock);
    }
  }

  const matchedStocks = requestedSymbols
    .map((symbol) => stockBySymbol.get(symbol))
    .filter(Boolean);

  if (matchedStocks.length === 0) {
    throw createSymbolsScopeError('symbols 模式未匹配到股票，已阻止全市场同步');
  }

  if (matchedStocks.length !== requestedSymbols.length) {
    const missingSymbols = requestedSymbols.filter((symbol) => !stockBySymbol.has(symbol));
    throw createSymbolsScopeError(`symbols 模式存在未匹配股票：${missingSymbols.join(',')}，已阻止全市场同步`);
  }

  return matchedStocks;
}

function selectStocksForSync(options = {}, universeStocks = []) {
  const syncOptions = normalizeSyncOptions(options);

  const selectedStocks = syncOptions.mode === 'symbols'
    ? selectSymbolStocks(syncOptions.symbols, universeStocks)
    : filterStocksForSync({
      ...syncOptions,
      universe: Array.isArray(universeStocks) ? universeStocks : []
    });

  return filterStocksForBaoStockAshareSync(selectedStocks, {
    mode: syncOptions.mode
  });
}

function countRunItems(state, selectedSymbols) {
  const symbols = Array.isArray(selectedSymbols) ? selectedSymbols : Object.keys(state.items || {});
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let costSum = 0;
  let costCount = 0;
  let allCostSum = 0;
  let allCostCount = 0;

  for (const symbol of symbols) {
    const item = state.items && state.items[symbol] ? state.items[symbol] : {};

    if (isDoneLikeStatus(item.status)) {
      done += 1;
    } else if (item.status === 'FAILED') {
      failed += 1;
    } else if (isSkippedLikeStatus(item.status)) {
      skipped += 1;
    }

    const costMs = Number(item.costMs);

    if (
      Number.isFinite(costMs)
      && costMs > 0
      && (isDoneLikeStatus(item.status) || item.status === 'FAILED' || isSkippedLikeStatus(item.status))
    ) {
      allCostSum += costMs;
      allCostCount += 1;
    }

    if (
      Number.isFinite(costMs)
      && costMs > 0
      && !isSkippedLikeStatus(item.status)
    ) {
      costSum += costMs;
      costCount += 1;
    }
  }

  return {
    done,
    failed,
    skipped,
    completed: done + failed + skipped,
    costSum,
    costCount,
    allCostSum,
    allCostCount
  };
}

function applyCounters(state, selectedSymbols) {
  const counts = countRunItems(state, selectedSymbols);
  state.total = Array.isArray(selectedSymbols) ? selectedSymbols.length : state.total;
  state.done = counts.done;
  state.failed = counts.failed;
  state.skipped = counts.skipped;
  return counts;
}

function buildProgress(input = {}) {
  const state = normalizeSyncState(input.state || loadSyncState());
  const recentMessageSymbols = getRecentMessageSymbols(state);
  const fallbackSelectedSymbols = state.selectedSymbols.length > 0
    ? state.selectedSymbols
    : (
      state.total > 0 && recentMessageSymbols.length === state.total
        ? recentMessageSymbols
        : Object.keys(state.items || {})
    );
  const selectedSymbols = input.selectedSymbols
    || fallbackSelectedSymbols;
  const counts = countRunItems(state, selectedSymbols);
  const total = Number(input.total !== undefined ? input.total : state.total || selectedSymbols.length) || 0;
  const recentMessages = Array.isArray(state.recentMessages) ? state.recentMessages : [];
  const lastRecentMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : {};
  const completedAll = total > 0 && counts.completed >= total;
  const lastRecentStatus = lastRecentMessage && lastRecentMessage.status ? lastRecentMessage.status : '';
  const derivedStatus = input.currentStatus
    || (state.running ? (state.activeWorkers > 0 ? 'RUNNING' : 'STARTING') : '')
    || (completedAll ? (counts.failed > 0 ? 'DONE_WITH_FAILED' : 'DONE') : '')
    || lastRecentStatus;
  const derivedMessage = input.lastMessage
    || (lastRecentMessage && lastRecentMessage.message ? lastRecentMessage.message : '')
    || state.lastError
    || state.lastSaveError
    || '';
  const warnings = [];

  if (state.lastSaveError) {
    warnings.push(`状态文件保存失败：${state.lastSaveError}`);
  }
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const elapsedMs = state.running && Number.isFinite(startedAtMs)
    ? Math.max(0, Date.now() - startedAtMs)
    : (
      state.finishedAt && Number.isFinite(startedAtMs)
        ? Math.max(0, Date.parse(state.finishedAt) - startedAtMs)
        : 0
    );
  const concurrency = normalizeConcurrency(
    input.concurrency !== undefined ? input.concurrency : state.concurrency,
    DEFAULT_CONCURRENCY
  );
  const activeWorkers = Number(input.activeWorkers !== undefined ? input.activeWorkers : state.activeWorkers) || 0;
  const effectiveConcurrency = Math.max(1, state.running ? (activeWorkers || concurrency) : concurrency);
  const rawAvgCostMs = counts.costCount > 0 ? Math.round(counts.costSum / counts.costCount) : 0;
  const fallbackAvgCostMs = counts.allCostCount > 0 ? Math.round(counts.allCostSum / counts.allCostCount) : 0;
  const avgCostMs = rawAvgCostMs || fallbackAvgCostMs;
  const remaining = Math.max(0, total - counts.completed);
  const estimatedRemainingMs = rawAvgCostMs > 0 ? Math.round((remaining * rawAvgCostMs) / effectiveConcurrency) : 0;

  return {
    running: state.running,
    total,
    done: counts.done,
    skipped: counts.skipped,
    failed: counts.failed,
    completed: counts.completed,
    concurrency,
    activeWorkers,
    runningSymbols: Array.isArray(input.runningSymbols) ? input.runningSymbols : getRunningSymbols(state),
    currentIndex: Number(input.currentIndex) || 0,
    currentSymbol: input.currentSymbol || (lastRecentMessage && lastRecentMessage.symbol ? lastRecentMessage.symbol : ''),
    currentName: input.currentName || '',
    currentStatus: derivedStatus,
    elapsedMs,
    avgCostMs,
    estimatedRemainingMs,
    percent: total > 0 ? Math.round((counts.completed / total) * 10000) / 100 : 0,
    lastMessage: derivedMessage,
    warnings,
    lastSaveError: state.lastSaveError || '',
    cacheBackend: input.cacheBackend || state.cacheBackend || '',
    recentMessages: Array.isArray(input.recentMessages) ? input.recentMessages : recentMessages,
    statePath: input.statePath || SYNC_STATE_PATH
  };
}

function makeStateItem(stock, overrides = {}) {
  return {
    symbol: stock.symbol,
    name: stock.name || '',
    market: stock.market || '',
    status: 'PENDING',
    syncMode: '',
    fetchStartDate: '',
    fetchEndDate: '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: [],
    failedChunks: [],
    emptyChunks: [],
    emptyIncrementalRange: null,
    noNewDataReason: '',
    preferredSource: '',
    chunkSource: '',
    addedBars: 0,
    barCount: 0,
    startDate: '',
    endDate: '',
    lastSyncAt: '',
    costMs: 0,
    error: '',
    rawError: '',
    akshareError: '',
    eastmoneyError: '',
    altDailyError: '',
    lastTransportError: '',
    ...overrides
  };
}

async function prepareStateForRun(state, stocks, syncOptions = {}) {
  const now = nowIso();
  const selectedSymbols = getSelectedSymbols(stocks);

  state.version = SYNC_VERSION;
  state.running = true;
  state.startedAt = now;
  state.finishedAt = '';
  state.lastError = '';
  state.cacheBackend = getCacheBackend();
  state.total = stocks.length;
  state.done = 0;
  state.failed = 0;
  state.skipped = 0;
  state.concurrency = normalizeConcurrency(syncOptions.concurrency, DEFAULT_CONCURRENCY);
  state.activeWorkers = 0;
  state.runningSymbols = [];
  state.selectedSymbols = selectedSymbols;
  state.recentMessages = [];

  for (const stock of stocks) {
    const existing = state.items[stock.symbol] || {};

    state.items[stock.symbol] = makeStateItem(stock, {
      syncMode: '',
      fetchStartDate: '',
      fetchEndDate: '',
      currentChunkStart: '',
      currentChunkEnd: '',
      finishedChunks: [],
      failedChunks: [],
      emptyChunks: [],
      emptyIncrementalRange: null,
      noNewDataReason: '',
      preferredSource: '',
      chunkSource: '',
      addedBars: 0,
      barCount: Number(existing.barCount) || 0,
      startDate: existing.startDate || '',
      endDate: existing.endDate || '',
      lastSyncAt: existing.lastSyncAt || '',
      costMs: 0,
      rawError: '',
      akshareError: '',
      eastmoneyError: '',
      altDailyError: '',
      lastTransportError: ''
    });
  }

  applyCounters(state, selectedSymbols);
  await saveSyncState(state);

  return selectedSymbols;
}

function updateItem(state, stock, updates) {
  const current = state.items[stock.symbol] || makeStateItem(stock);
  state.items[stock.symbol] = {
    ...current,
    symbol: stock.symbol,
    name: stock.name || current.name || '',
    market: stock.market || current.market || '',
    ...updates
  };
}

function getErrorDiagnostics(error) {
  const message = compactErrorMessage(error);

  return {
    rawError: error && error.rawError
      ? compactDiagnosticText(error.rawError)
      : compactDiagnosticText(error && error.stack ? error.stack : error && error.message ? error.message : error || ''),
    akshareError: error && error.akshareError ? compactDiagnosticText(error.akshareError) : '',
    eastmoneyError: error && error.eastmoneyError ? compactDiagnosticText(error.eastmoneyError) : '',
    altDailyError: error && error.altDailyError ? compactDiagnosticText(error.altDailyError) : '',
    lastTransportError: error && error.lastTransportError
      ? compactDiagnosticText(error.lastTransportError)
      : message
  };
}

function getLastFailedChunk(failedChunks) {
  const list = Array.isArray(failedChunks) ? failedChunks : [];
  return list.length > 0 ? list[list.length - 1] : {};
}

function isEmptyChunkError(error) {
  return Boolean(error && error.emptyBars);
}

function getErrorSource(error) {
  return String(error && (error.emptySource || error.adapterSource) || '').trim();
}

function getCacheBarCount(cache) {
  return Number(cache && (cache.count !== undefined ? cache.count : cache.barCount)) || 0;
}

function isCacheValidNearEnd(cache, requestedEndDate) {
  return getCacheBarCount(cache) > 0
    && Boolean(compactDateText(cache && cache.endDate))
    && isCacheCloseToRequestedEnd(cache.endDate, requestedEndDate);
}

function isChunkBeforeCacheStart(chunk, cacheStartDate) {
  const chunkEnd = compactDateText(chunk && chunk.endDate);
  const cacheStart = compactDateText(cacheStartDate);
  return Boolean(chunkEnd && cacheStart && chunkEnd < cacheStart);
}

function areIssueChunksBeforeCacheStart(issueChunks, cacheStartDate) {
  const chunks = Array.isArray(issueChunks) ? issueChunks : [];

  if (chunks.length === 0) {
    return false;
  }

  return chunks.every((chunk) => isChunkBeforeCacheStart(chunk, cacheStartDate));
}

function resolveFullChunkedStatus(input = {}) {
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const finishedChunks = Array.isArray(input.finishedChunks) ? input.finishedChunks : [];
  const failedChunks = Array.isArray(input.failedChunks) ? input.failedChunks : [];
  const emptyChunks = Array.isArray(input.emptyChunks) ? input.emptyChunks : [];
  const addedBars = Number(input.addedBars) || 0;
  const cache = input.cache || {};
  const cacheCount = getCacheBarCount(cache);
  const requestedEndDate = input.requestedEndDate || input.fetchEndDate || input.endDate || '';

  if (addedBars <= 0 && cacheCount <= 0) {
    return 'FAILED';
  }

  const processed = finishedChunks.length + failedChunks.length + emptyChunks.length;
  const incomplete = processed < chunks.length;
  const hasIssues = failedChunks.length > 0 || emptyChunks.length > 0 || incomplete;

  if (!hasIssues) {
    return 'DONE';
  }

  if (isCacheValidNearEnd(cache, requestedEndDate)) {
    const issueChunks = failedChunks.concat(emptyChunks);
    return areIssueChunksBeforeCacheStart(issueChunks, cache.startDate)
      ? 'DONE_WITH_GAPS'
      : 'PARTIAL_DONE_VALID';
  }

  return 'PARTIAL_DONE';
}

function emitProgress(onProgress, state, stocks, progressInput) {
  const selectedSymbols = getSelectedSymbols(stocks);
  applyCounters(state, selectedSymbols);
  pushRecentMessage(state, progressInput);
  const progress = buildProgress({
    state,
    selectedSymbols,
    total: stocks.length,
    ...progressInput
  });

  if (typeof onProgress === 'function') {
    onProgress(progress);
  }

  return progress;
}

async function markSkipped(state, stock, syncPlan, costMs, reason) {
  const cache = syncPlan && syncPlan.cache ? syncPlan.cache : {};
  updateItem(state, stock, {
    status: 'SKIPPED',
    syncMode: 'SKIPPED',
    fetchStartDate: syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : '',
    fetchEndDate: syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: [],
    failedChunks: [],
    emptyChunks: [],
    emptyIncrementalRange: null,
    noNewDataReason: '',
    preferredSource: '',
    chunkSource: '',
    addedBars: 0,
    barCount: cache.count || 0,
    startDate: cache.startDate || '',
    endDate: cache.endDate || '',
    lastSyncAt: nowIso(),
    costMs,
    error: '',
    rawError: '',
    akshareError: '',
    eastmoneyError: '',
    altDailyError: '',
    lastTransportError: ''
  });
  state.lastError = '';
  await saveSyncState(state);

  return reason;
}

function isReconcileCandidateStatus(status) {
  return status === 'FAILED' || status === 'PARTIAL_DONE';
}

function buildFreshCacheFullChunkedResult(previousItem, syncPlan) {
  const item = previousItem || {};
  const plan = syncPlan || {};
  const cache = plan.cache || {};

  if (!isReconcileCandidateStatus(item.status) || item.syncMode !== 'FULL_CHUNKED') {
    return null;
  }

  if (!isCacheValidNearEnd(cache, plan.fetchEndDate)) {
    return null;
  }

  const finishedChunks = Array.isArray(item.finishedChunks) ? item.finishedChunks : [];
  const failedChunks = Array.isArray(item.failedChunks) ? item.failedChunks : [];
  const emptyChunks = Array.isArray(item.emptyChunks) ? item.emptyChunks : [];
  const chunks = finishedChunks.concat(failedChunks, emptyChunks).map((chunk) => ({
    startDate: chunk && chunk.startDate || '',
    endDate: chunk && chunk.endDate || ''
  }));
  const status = resolveFullChunkedStatus({
    chunks,
    finishedChunks,
    failedChunks,
    emptyChunks,
    addedBars: 0,
    cache,
    requestedEndDate: plan.fetchEndDate
  });

  if (!isDoneLikeStatus(status) || status === 'PARTIAL_DONE') {
    return null;
  }

  const lastFailedChunk = getLastFailedChunk(failedChunks);
  return {
    ok: true,
    status,
    addedBars: 0,
    finishedChunks,
    failedChunks,
    emptyChunks,
    preferredSource: item.preferredSource || '',
    chunkSource: item.chunkSource || '',
    error: status === 'PARTIAL_DONE_VALID'
      ? '旧 FULL_CHUNKED 分段存在缺口，但缓存已接近请求结束日。'
      : '',
    rawError: lastFailedChunk.rawError || item.rawError || '',
    akshareError: lastFailedChunk.akshareError || item.akshareError || '',
    eastmoneyError: lastFailedChunk.eastmoneyError || item.eastmoneyError || '',
    altDailyError: lastFailedChunk.altDailyError || item.altDailyError || '',
    lastTransportError: lastFailedChunk.lastTransportError || item.lastTransportError || ''
  };
}

async function markDone(state, stock, cache, costMs, syncPlan, fetchResult = {}) {
  const finishedChunks = Array.isArray(fetchResult.finishedChunks) ? fetchResult.finishedChunks : [];
  const failedChunks = Array.isArray(fetchResult.failedChunks) ? fetchResult.failedChunks : [];
  const emptyChunks = Array.isArray(fetchResult.emptyChunks) ? fetchResult.emptyChunks : [];
  const lastFailedChunk = getLastFailedChunk(failedChunks);
  const status = fetchResult.status || 'DONE';
  const addedBars = Number(fetchResult.addedBars) || 0;

  updateItem(state, stock, {
    status,
    syncMode: syncPlan && syncPlan.syncMode ? syncPlan.syncMode : '',
    fetchStartDate: syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : '',
    fetchEndDate: syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks,
    failedChunks,
    emptyChunks,
    emptyIncrementalRange: null,
    noNewDataReason: '',
    preferredSource: fetchResult.preferredSource || '',
    chunkSource: fetchResult.chunkSource || '',
    addedBars,
    barCount: cache.count || 0,
    startDate: cache.startDate || '',
    endDate: cache.endDate || '',
    lastSyncAt: nowIso(),
    costMs,
    error: (status === 'PARTIAL_DONE' || status === 'PARTIAL_DONE_VALID')
      ? compactErrorMessage(fetchResult.error || lastFailedChunk.error || '部分分段同步失败。')
      : '',
    rawError: fetchResult.rawError || lastFailedChunk.rawError || '',
    akshareError: fetchResult.akshareError || lastFailedChunk.akshareError || '',
    eastmoneyError: fetchResult.eastmoneyError || lastFailedChunk.eastmoneyError || '',
    altDailyError: fetchResult.altDailyError || lastFailedChunk.altDailyError || '',
    lastTransportError: fetchResult.lastTransportError || lastFailedChunk.lastTransportError || ''
  });
  state.lastError = '';
  await saveSyncStateMaybeDeferred(state);
}

async function markFailed(state, stock, error, costMs, syncPlan) {
  const errorMessage = compactErrorMessage(error);
  const diagnostics = getErrorDiagnostics(error);
  updateItem(state, stock, {
    status: 'FAILED',
    syncMode: syncPlan && syncPlan.syncMode ? syncPlan.syncMode : '',
    fetchStartDate: syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : '',
    fetchEndDate: syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: error && Array.isArray(error.finishedChunks) ? error.finishedChunks : [],
    failedChunks: error && Array.isArray(error.failedChunks) ? error.failedChunks : [],
    emptyChunks: error && Array.isArray(error.emptyChunks) ? error.emptyChunks : [],
    emptyIncrementalRange: null,
    noNewDataReason: '',
    preferredSource: error && error.preferredSource ? String(error.preferredSource) : '',
    chunkSource: error && error.chunkSource ? String(error.chunkSource) : '',
    addedBars: 0,
    lastSyncAt: nowIso(),
    costMs,
    error: errorMessage,
    rawError: diagnostics.rawError,
    akshareError: diagnostics.akshareError,
    eastmoneyError: diagnostics.eastmoneyError,
    altDailyError: diagnostics.altDailyError,
    lastTransportError: diagnostics.lastTransportError
  });
  state.lastError = errorMessage;
  await saveSyncState(state);

  return errorMessage;
}

async function markCacheWriteStopped(state, stock, error, costMs, syncPlan) {
  const current = state.items[stock.symbol] || {};
  const cache = syncPlan && syncPlan.cache ? syncPlan.cache : {};
  const errorMessage = getCacheWriteStopMessage(error);

  updateItem(state, stock, {
    status: 'PENDING',
    syncMode: syncPlan && syncPlan.syncMode ? syncPlan.syncMode : current.syncMode || '',
    fetchStartDate: syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : current.fetchStartDate || '',
    fetchEndDate: syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : current.fetchEndDate || '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: current.finishedChunks || [],
    failedChunks: current.failedChunks || [],
    emptyChunks: current.emptyChunks || [],
    emptyIncrementalRange: current.emptyIncrementalRange || null,
    noNewDataReason: current.noNewDataReason || '',
    preferredSource: current.preferredSource || '',
    chunkSource: current.chunkSource || '',
    addedBars: current.addedBars || 0,
    barCount: cache.count || Number(current.barCount) || 0,
    startDate: cache.startDate || current.startDate || '',
    endDate: cache.endDate || current.endDate || '',
    lastSyncAt: current.lastSyncAt || '',
    costMs,
    error: '',
    rawError: '',
    akshareError: '',
    eastmoneyError: '',
    altDailyError: '',
    lastTransportError: ''
  });
  state.lastError = errorMessage;
  await saveSyncState(state);

  return errorMessage;
}

function isIncrementalNoNewDataError(error, syncPlan) {
  return Boolean(
    syncPlan
    && syncPlan.syncMode === 'INCREMENTAL'
    && syncPlan.cache
    && Number(syncPlan.cache.count) > 0
    && isEmptyChunkError(error)
  );
}

async function markIncrementalNoNewData(state, stock, error, costMs, syncPlan) {
  const cache = syncPlan && syncPlan.cache ? syncPlan.cache : {};
  const current = state.items[stock.symbol] || {};
  const fetchStartDate = syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : '';
  const fetchEndDate = syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : '';

  updateItem(state, stock, {
    status: INCREMENTAL_NO_NEW_DATA_STATUS,
    syncMode: 'INCREMENTAL',
    fetchStartDate,
    fetchEndDate,
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: [],
    failedChunks: [],
    emptyChunks: [],
    emptyIncrementalRange: {
      startDate: fetchStartDate,
      endDate: fetchEndDate
    },
    noNewDataReason: INCREMENTAL_NO_NEW_DATA_REASON,
    preferredSource: '',
    chunkSource: '',
    addedBars: 0,
    barCount: cache.count || Number(current.barCount) || 0,
    startDate: cache.startDate || current.startDate || '',
    endDate: cache.endDate || current.endDate || '',
    lastSyncAt: current.lastSyncAt || '',
    costMs,
    error: '',
    rawError: '',
    akshareError: '',
    eastmoneyError: '',
    altDailyError: '',
    lastTransportError: ''
  });
  state.lastError = '';
  await saveSyncStateMaybeDeferred(state);

  return {
    status: INCREMENTAL_NO_NEW_DATA_STATUS,
    reason: INCREMENTAL_NO_NEW_DATA_REASON,
    source: getErrorSource(error)
  };
}

async function fetchAndSaveSymbol(stock, syncOptions, syncPlan, onProgress, state, stocks, index) {
  let lastError = null;
  let bars = [];

  for (let attempt = 0; attempt <= syncOptions.maxRetriesPerSymbol; attempt += 1) {
    try {
      if (attempt > 0) {
        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: 'RUNNING',
          lastMessage: `${stock.symbol} 第 ${attempt + 1} 次尝试拉取。`
        });
      }

      const result = await fetchDailyBarsFromPython({
        symbol: stock.symbol,
        startDate: syncPlan.fetchStartDate,
        endDate: syncPlan.fetchEndDate,
        adjust: 'qfq',
        preferredSource: syncPlan.preferredSource || ''
      });

      bars = result && Array.isArray(result.bars) ? result.bars : [];
      const source = String(result && result.source || bars.source || '').trim();

      if (bars.length === 0) {
        const error = new Error(`${stock.symbol} 没有返回历史日线。`);
        error.emptyBars = true;
        error.emptySource = source;
        throw error;
      }

      const upsertResult = await upsertDailyBarsLocked(stock.symbol, bars);
      return {
        ok: true,
        status: 'DONE',
        source,
        chunkSource: source,
        bars,
        addedBars: Number(upsertResult && upsertResult.inserted) || bars.length,
        finishedChunks: [],
        failedChunks: []
      };
    } catch (error) {
      lastError = error;

      if (isCacheWriteMemoryError(error)) {
        throw error;
      }

      if (attempt >= syncOptions.maxRetriesPerSymbol || isStopRequested(syncOptions)) {
        break;
      }

      state.lastError = compactErrorMessage(error);
      await saveSyncState(state);
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'RUNNING',
        lastMessage: `${stock.symbol} 拉取失败，${Math.round(syncOptions.failPauseMs / 1000)} 秒后重试。`
      });
      await sleep(syncOptions.failPauseMs);
    }
  }

  throw lastError || new Error(`${stock.symbol} 历史日线拉取失败。`);
}

async function fetchAndSaveFullChunkedSymbol(stock, syncOptions, syncPlan, onProgress, state, stocks, index) {
  const chunks = Array.isArray(syncPlan.chunks) ? syncPlan.chunks : [];
  const finishedChunks = [];
  const failedChunks = [];
  const emptyChunks = [];
  let preferredSource = String(syncPlan.preferredSource || '').trim();
  let chunkSource = '';
  let addedBars = 0;

  if (!chunks.length) {
    throw new Error(`${stock.symbol} FULL_CHUNKED 没有可同步的日期分段。`);
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
 
    if (isStopRequested(syncOptions)) {
      break;
    }

    updateItem(state, stock, {
      status: 'RUNNING',
      syncMode: 'FULL_CHUNKED',
      currentChunkStart: chunk.startDate,
      currentChunkEnd: chunk.endDate,
      finishedChunks,
      failedChunks,
      emptyChunks,
      preferredSource,
      chunkSource: preferredSource,
      addedBars,
      error: ''
    });
    await saveSyncState(state);

    emitProgress(onProgress, state, stocks, {
      currentIndex: index + 1,
      currentSymbol: stock.symbol,
      currentName: stock.name || '',
      currentStatus: 'FULL_CHUNKED',
      lastMessage: `${stock.symbol} FULL_CHUNKED ${chunkIndex + 1}/${chunks.length}：${chunk.startDate} → ${chunk.endDate}。`
    });

    try {
      const chunkResult = await fetchAndSaveSymbol(
        stock,
        syncOptions,
        {
          ...syncPlan,
          fetchStartDate: chunk.startDate,
          fetchEndDate: chunk.endDate,
          preferredSource
        },
        onProgress,
        state,
        stocks,
        index
      );
      const chunkAddedBars = Number(chunkResult && chunkResult.addedBars) || 0;
      const source = String(chunkResult && (chunkResult.source || chunkResult.chunkSource) || '').trim();

      if (source) {
        preferredSource = source;
        chunkSource = source;
      }

      addedBars += chunkAddedBars;
      finishedChunks.push({
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        source,
        addedBars: chunkAddedBars,
        barCount: Array.isArray(chunkResult.bars) ? chunkResult.bars.length : 0,
        finishedAt: nowIso()
      });

      updateItem(state, stock, {
        status: 'RUNNING',
        syncMode: 'FULL_CHUNKED',
        currentChunkStart: chunk.startDate,
        currentChunkEnd: chunk.endDate,
        finishedChunks,
        failedChunks,
        emptyChunks,
        preferredSource,
        chunkSource,
        addedBars,
        error: '',
        rawError: '',
        akshareError: '',
        eastmoneyError: '',
        altDailyError: '',
        lastTransportError: ''
      });
      await saveSyncState(state);

      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'FULL_CHUNKED',
          lastMessage: `${stock.symbol} 分段成功 ${chunk.startDate} → ${chunk.endDate}，新增 ${chunkAddedBars} 条，source=${source || '-'}。`
      });
    } catch (error) {
      if (isCacheWriteMemoryError(error)) {
        throw error;
      }

      const diagnostics = getErrorDiagnostics(error);

      if (isEmptyChunkError(error)) {
        const source = getErrorSource(error) || preferredSource;

        if (source) {
          chunkSource = source;
        }

        const emptyChunk = {
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          status: 'EMPTY_CHUNK',
          source,
          error: compactErrorMessage(error),
          rawError: diagnostics.rawError,
          akshareError: diagnostics.akshareError,
          eastmoneyError: diagnostics.eastmoneyError,
          altDailyError: diagnostics.altDailyError,
          lastTransportError: diagnostics.lastTransportError,
          emptyAt: nowIso()
        };
        emptyChunks.push(emptyChunk);

        updateItem(state, stock, {
          status: 'RUNNING',
          syncMode: 'FULL_CHUNKED',
          currentChunkStart: chunk.startDate,
          currentChunkEnd: chunk.endDate,
          finishedChunks,
          failedChunks,
          emptyChunks,
          preferredSource,
          chunkSource,
          addedBars,
          error: '',
          rawError: '',
          akshareError: '',
          eastmoneyError: '',
          altDailyError: '',
          lastTransportError: ''
        });
        await saveSyncState(state);

        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: 'EMPTY_CHUNK',
          lastMessage: `${stock.symbol} 分段空日线 ${chunk.startDate} → ${chunk.endDate}，已记为 EMPTY_CHUNK。`
        });
        continue;
      }

      const source = getErrorSource(error) || chunkSource || preferredSource;
      const failedChunk = {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        source,
        error: compactErrorMessage(error),
        rawError: diagnostics.rawError,
        akshareError: diagnostics.akshareError,
        eastmoneyError: diagnostics.eastmoneyError,
        altDailyError: diagnostics.altDailyError,
        lastTransportError: diagnostics.lastTransportError,
        failedAt: nowIso()
      };
      failedChunks.push(failedChunk);

      updateItem(state, stock, {
        status: 'RUNNING',
        syncMode: 'FULL_CHUNKED',
        currentChunkStart: chunk.startDate,
        currentChunkEnd: chunk.endDate,
        finishedChunks,
        failedChunks,
        emptyChunks,
        preferredSource,
        chunkSource: source,
        addedBars,
        error: failedChunk.error,
        rawError: failedChunk.rawError,
        akshareError: failedChunk.akshareError,
        eastmoneyError: failedChunk.eastmoneyError,
        altDailyError: failedChunk.altDailyError,
        lastTransportError: failedChunk.lastTransportError
      });
      state.lastError = failedChunk.error;
      await saveSyncState(state);

      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'FULL_CHUNKED',
        lastMessage: `${stock.symbol} 分段失败 ${chunk.startDate} → ${chunk.endDate}：${failedChunk.error}`
      });
    }
  }

  const finalCache = await getCacheSnapshot(stock.symbol, { preferSqlite: true });
  const status = resolveFullChunkedStatus({
    chunks,
    finishedChunks,
    failedChunks,
    emptyChunks,
    addedBars,
    cache: finalCache,
    requestedEndDate: syncPlan.fetchEndDate
  });

  if (status !== 'FAILED') {
    const lastFailedChunk = getLastFailedChunk(failedChunks);
    return {
      ok: true,
      status,
      addedBars,
      finishedChunks,
      failedChunks,
      emptyChunks,
      preferredSource,
      chunkSource,
      error: status === 'PARTIAL_DONE'
        ? '部分 FULL_CHUNKED 分段同步未完成。'
        : status === 'PARTIAL_DONE_VALID'
          ? '部分 FULL_CHUNKED 分段同步未完成，但缓存已接近请求结束日。'
          : '',
      rawError: lastFailedChunk.rawError || '',
      akshareError: lastFailedChunk.akshareError || '',
      eastmoneyError: lastFailedChunk.eastmoneyError || '',
      altDailyError: lastFailedChunk.altDailyError || '',
      lastTransportError: lastFailedChunk.lastTransportError || ''
    };
  }

  const lastFailedChunk = getLastFailedChunk(failedChunks);
  const error = new Error(
    emptyChunks.length > 0 && failedChunks.length === 0
      ? `${stock.symbol} FULL_CHUNKED 全部分段为空。`
      : `${stock.symbol} FULL_CHUNKED 全部分段失败。`
  );
  error.finishedChunks = finishedChunks;
  error.failedChunks = failedChunks;
  error.emptyChunks = emptyChunks;
  error.preferredSource = preferredSource;
  error.chunkSource = chunkSource;
  error.rawError = lastFailedChunk.rawError || '';
  error.akshareError = lastFailedChunk.akshareError || '';
  error.eastmoneyError = lastFailedChunk.eastmoneyError || '';
  error.altDailyError = lastFailedChunk.altDailyError || '';
  error.lastTransportError = lastFailedChunk.lastTransportError || '';
  throw error;
}

async function runWorkerPool(items, concurrency, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.min(normalizeConcurrency(concurrency, DEFAULT_CONCURRENCY), Math.max(1, list.length));
  const processedSymbols = new Set();
  const results = [];
  let nextIndex = 0;

  async function runWorker(workerId) {
    while (true) {
      if (typeof options.shouldStop === 'function' && options.shouldStop()) {
        break;
      }

      const index = nextIndex;
      nextIndex += 1;

      if (index >= list.length) {
        break;
      }

      const item = list[index];
      const symbol = String(item && item.symbol || index).trim();

      if (processedSymbols.has(symbol)) {
        results[index] = {
          ok: false,
          workerId,
          error: new Error(`worker pool 重复处理 symbol：${symbol}`)
        };
        continue;
      }

      processedSymbols.add(symbol);

      try {
        results[index] = {
          ok: true,
          workerId,
          value: await worker(item, index, workerId)
        };
      } catch (error) {
        results[index] = {
          ok: false,
          workerId,
          error
        };
      }
    }
  }

  const workers = [];

  for (let workerId = 1; workerId <= workerCount; workerId += 1) {
    workers.push(runWorker(workerId));
  }

  await Promise.all(workers);

  return {
    results,
    processedSymbols: Array.from(processedSymbols),
    workerCount
  };
}

async function waitAfterFetchedSymbol(context, stock, index, fetchedThisSymbol) {
  const {
    syncOptions,
    state,
    stocks,
    onProgress,
    runtime
  } = context;

  if (!fetchedThisSymbol || isStopRequested(syncOptions)) {
    return;
  }

  runtime.completedFetches += 1;

  if (runtime.completedFetches - runtime.lastCacheFlushFetches >= CACHE_FLUSH_SYMBOL_INTERVAL) {
    runtime.lastCacheFlushFetches = runtime.completedFetches;
    await flushCacheToDiskLocked();
  }

  if (runtime.completedFetches >= stocks.length) {
    return;
  }

  runtime.fetchedSinceBatchPause += 1;

  if (syncOptions.throttleMs > 0) {
    emitProgress(onProgress, state, stocks, {
      currentIndex: index + 1,
      currentSymbol: stock.symbol,
      currentName: stock.name || '',
      currentStatus: 'WAITING',
      lastMessage: `等待 ${Math.round(syncOptions.throttleMs / 1000)} 秒后同步下一只。`
    });
    await sleep(syncOptions.throttleMs);
  }

  if (runtime.fetchedSinceBatchPause >= syncOptions.batchSize) {
    runtime.fetchedSinceBatchPause = 0;

    if (syncOptions.batchPauseMs > 0) {
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'BATCH_PAUSE',
        lastMessage: `本批 ${syncOptions.batchSize} 只已完成，暂停 ${Math.round(syncOptions.batchPauseMs / 1000)} 秒。`
      });
      await sleep(syncOptions.batchPauseMs);
    }
  }
}

async function waitAfterSkippedSymbol(context, stock, index, status) {
  if (status !== 'SKIPPED') {
    return;
  }

  const {
    syncOptions,
    state,
    stocks,
    onProgress,
    runtime
  } = context;

  if (isStopRequested(syncOptions)) {
    return;
  }

  runtime.skippedSinceYield = (Number(runtime.skippedSinceYield) || 0) + 1;

  if (runtime.skippedSinceYield < SKIPPED_SYMBOL_YIELD_INTERVAL) {
    return;
  }

  runtime.skippedSinceYield = 0;

  emitProgress(onProgress, state, stocks, {
    currentIndex: index + 1,
    currentSymbol: stock.symbol,
    currentName: stock.name || '',
    currentStatus: 'SKIPPED',
    lastMessage: `已连续跳过 ${SKIPPED_SYMBOL_YIELD_INTERVAL} 只本地最新股票，短暂释放界面。`
  });

  await sleep(SKIPPED_SYMBOL_YIELD_MS);
}

function markSkippedInMemory(state, stock, syncPlan, reason) {
  const cache = syncPlan && syncPlan.cache ? syncPlan.cache : {};

  updateItem(state, stock, {
    status: 'SKIPPED',
    syncMode: 'SKIPPED',
    fetchStartDate: syncPlan && syncPlan.fetchStartDate ? syncPlan.fetchStartDate : '',
    fetchEndDate: syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : '',
    currentChunkStart: '',
    currentChunkEnd: '',
    finishedChunks: [],
    failedChunks: [],
    emptyChunks: [],
    emptyIncrementalRange: null,
    noNewDataReason: '',
    preferredSource: '',
    chunkSource: '',
    addedBars: 0,
    barCount: cache.count || 0,
    startDate: cache.startDate || '',
    endDate: cache.endDate || '',
    lastSyncAt: nowIso(),
    costMs: 0,
    error: reason || '',
    rawError: '',
    akshareError: '',
    eastmoneyError: '',
    altDailyError: '',
    lastTransportError: ''
  });
}

async function buildAshareBatchPlans(context) {
  const {
    syncOptions,
    state,
    stocks,
    onProgress
  } = context;

  const plans = [];

  for (let index = 0; index < stocks.length; index += 1) {
    if (isStopRequested(syncOptions)) {
      break;
    }

    const stock = stocks[index];

    if (index === 0 || index % 100 === 0) {
      await saveSyncState(state);
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'PLANNING',
        lastMessage: `A股快速日更规划中：${index + 1}/${stocks.length}，正在检查本地缓存日期。`
      });
    }

    const syncPlan = await buildSyncPlan(stock, syncOptions, context.cacheIndex);
    const cache = syncPlan && syncPlan.cache ? syncPlan.cache : {};
    const targetEndDate = syncPlan && syncPlan.fetchEndDate ? syncPlan.fetchEndDate : syncOptions.endDate;

    if (!syncOptions.force && isLikelySuspendedByCache(cache, targetEndDate)) {
      const lagDays = getDateLagDays(cache.endDate, targetEndDate);

      markSkippedInMemory(
        state,
        stock,
        {
          ...syncPlan,
          syncMode: 'SUSPENDED_FILTER',
          fetchStartDate: '',
          fetchEndDate: targetEndDate,
          cache
        },
        `最后日线 ${cache.endDate || '-'}，距目标 ${targetEndDate} 已 ${lagDays} 天，疑似停牌/长期无交易，跳过快速日更。`
      );

      state.items[stock.symbol].syncMode = 'SUSPENDED_FILTER';
      continue;
    }

    // if (
    //   !syncOptions.force
    //   && syncOptions.fastDaily
    //   && !syncOptions.fillMissing
    //   && Number(cache && cache.count) <= 0
    // ) {
    //   markSkippedInMemory(
    //     state,
    //     stock,
    //     {
    //       ...syncPlan,
    //       syncMode: 'NO_LOCAL_CACHE_FAST_DAILY_SKIP',
    //       fetchStartDate: '',
    //       fetchEndDate: targetEndDate,
    //       cache
    //     },
    //     '无本地缓存基线，快速日更跳过，交给全量补齐任务。'
    //   );

    //   state.items[stock.symbol].syncMode = 'NO_LOCAL_CACHE_FAST_DAILY_SKIP';
    //   continue;
    // }

    if (syncPlan.syncMode === 'SKIPPED') {
      markSkippedInMemory(state, stock, syncPlan, syncPlan.reason);
      continue;
    }

    plans.push({
      index,
      stock,
      syncPlan
    });
  }

  await saveSyncState(state);

  emitProgress(onProgress, state, stocks, {
    currentSymbol: '-',
    currentStatus: 'PLANNED',
    lastMessage: `A股快速日更规划完成：待处理 ${plans.length} 只。`
  });

  return plans;
}

async function runSingleStockFallbackPlans(context, plans) {
  const list = Array.isArray(plans) ? plans : [];

  if (!list.length || isStopRequested(context.syncOptions)) {
    return;
  }

  emitProgress(context.onProgress, context.state, context.stocks, {
    currentSymbol: '-',
    currentStatus: 'FALLBACK',
    lastMessage: `A股常规兜底同步 ${list.length} 只。`
  });

  await runWorkerPool(
    list,
    context.syncOptions.concurrency,
    async (plan, fallbackIndex, workerId) => {
      const result = await syncOneStock(context, plan.stock, plan.index ?? fallbackIndex, workerId);
      await waitAfterFetchedSymbol(context, plan.stock, plan.index ?? fallbackIndex, result && result.fetchedThisSymbol);
      await waitAfterSkippedSymbol(context, plan.stock, plan.index ?? fallbackIndex, result && result.status);
      return result;
    },
    {
      shouldStop: () => isStopRequested(context.syncOptions)
    }
  );
}

async function runFastDailyAshareSync(context) {
  const {
    syncOptions,
    state,
    stocks,
    onProgress
  } = context;

  emitProgress(onProgress, state, stocks, {
    currentSymbol: '-',
    currentStatus: 'INDEXING',
    lastMessage: 'A股快速日更：正在一次性读取 SQLite 缓存索引。'
  });

  syncOptions.cacheRangeIndex = await loadAshareCacheRangeIndex();

  emitProgress(onProgress, state, stocks, {
    currentSymbol: '-',
    currentStatus: 'PLANNING',
    lastMessage: `A股快速日更：缓存索引读取完成，indexed=${syncOptions.cacheRangeIndex.size}，开始生成批量计划。`
  });

  const plans = await buildAshareBatchPlans(context);

  const dailyPlans = plans.filter((plan) => {
    return plan.syncPlan
      && plan.syncPlan.syncMode === 'INCREMENTAL'
      && isShortDailyIncremental(plan.syncPlan.fetchStartDate, plan.syncPlan.fetchEndDate);
  });

  const fallbackPlans = plans.filter((plan) => !dailyPlans.includes(plan));
  const batchFallbackPlans = [];

  const suspendedCount = Object.values(state.items || {})
    .filter((item) => item && item.syncMode === 'SUSPENDED_FILTER')
    .length;

  const noLocalCacheSkipCount = Object.values(state.items || {})
    .filter((item) => item && item.syncMode === 'NO_LOCAL_CACHE_FAST_DAILY_SKIP')
    .length;

  emitProgress(onProgress, state, stocks, {
    currentSymbol: '-',
    currentStatus: 'BATCH_READY',
    lastMessage: `A股快速日更规划完成：已跳过 ${state.skipped || 0}，停牌/长期无交易 ${suspendedCount}，无本地基线 ${noLocalCacheSkipCount}，批量增量 ${dailyPlans.length}，常规补齐 ${fallbackPlans.length}。`
  });

  // A股快速日更不要先跑高并发大批量。
  // BaoStock 对 200只大批量 + 多 worker 不稳定，第一轮经常空跑。
  // 所以 A股增量主路径直接使用“30只小批量 + 批次并发1”。
  const ashareFastDailyBatchSize = DEFAULT_ASHARE_FAST_DAILY_BATCH_SIZE;
  const ashareFastDailyBatchConcurrency = 1;
  const batches = chunkArray(dailyPlans, ashareFastDailyBatchSize);

  configureDeferredSyncStateSave(state, {
    enabled: true,
    interval: DEFAULT_BATCH_STATE_SAVE_INTERVAL
  });

  await runWorkerPool(
    batches,
    ashareFastDailyBatchConcurrency,
    async (batch, batchIndex, workerId) => {
      if (!Array.isArray(batch) || batch.length === 0 || isStopRequested(syncOptions)) {
        return null;
      }

      const startDate = batch.reduce((min, plan) => {
        const value = plan.syncPlan.fetchStartDate;
        return !min || value < min ? value : min;
      }, '');

      const endDate = batch.reduce((max, plan) => {
        const value = plan.syncPlan.fetchEndDate;
        return !max || value > max ? value : max;
      }, '');

      emitProgress(onProgress, state, stocks, {
        currentIndex: batch[0].index + 1,
        currentSymbol: batch[0].stock.symbol,
        currentName: batch[0].stock.name || '',
        currentStatus: 'BATCH_RUNNING',
        lastMessage: `A股稳定批量日更 ${batchIndex + 1}/${batches.length}，symbols=${batch.length}，批次并发=1，${startDate} → ${endDate}。`
      });

      const batchStartedAt = Date.now();
      let response = null;

      try {
        response = await runAshareIncrementalBatchAdapter({
          symbols: batch.map((plan) => plan.stock.symbol),
          startDate,
          endDate,
          adjust: 'qfq'
        });
      } catch (error) {
        response = {
          ok: false,
          error: compactErrorMessage(error),
          results: []
        };
      }

      const batchCostMs = Math.max(1, Date.now() - batchStartedAt);
      const batchPlanCostMs = Math.max(1, Math.round(batchCostMs / Math.max(1, batch.length)));

      const resultMap = new Map();

      for (const result of Array.isArray(response && response.results) ? response.results : []) {
        resultMap.set(String(result.symbol || '').trim(), result);
      }

      for (const plan of batch) {
        if (isStopRequested(syncOptions)) {
          break;
        }

        const symbol = plan.stock.symbol;
        const result = resultMap.get(symbol);
        const bars = result && Array.isArray(result.bars) ? result.bars : [];

        if (result && result.ok && bars.length > 0) {
          const upsertResult = await upsertDailyBarsLocked(symbol, bars);
          const cache = mergeCacheSnapshotWithBars(plan.syncPlan.cache, bars);

          await markDone(
            state,
            plan.stock,
            cache,
            batchPlanCostMs,
            {
              ...plan.syncPlan,
              syncMode: 'BATCH_INCREMENTAL'
            },
            {
              status: 'DONE',
              source: result.source || 'baostock_a_share_batch_incremental',
              chunkSource: result.source || 'baostock_a_share_batch_incremental',
              addedBars: Number(upsertResult && upsertResult.inserted) || bars.length,
              finishedChunks: [],
              failedChunks: []
            }
          );

          emitProgress(onProgress, state, stocks, {
            currentIndex: plan.index + 1,
            currentSymbol: symbol,
            currentName: plan.stock.name || '',
            currentStatus: 'DONE',
            lastMessage: `${symbol} BATCH_INCREMENTAL DONE，新增 ${Number(upsertResult && upsertResult.inserted) || bars.length} 条。`
          });

          continue;
        }

        if (
          result
          && result.ok
          && bars.length === 0
          && plan.syncPlan
          && plan.syncPlan.syncMode === 'INCREMENTAL'
          && plan.syncPlan.cache
          && Number(plan.syncPlan.cache.count) > 0
        ) {
          await markIncrementalNoNewData(
            state,
            plan.stock,
            {
              emptyBars: true,
              emptySource: result.source || 'baostock_a_share_batch_incremental'
            },
            batchPlanCostMs,
            plan.syncPlan
          );

          emitProgress(onProgress, state, stocks, {
            currentIndex: plan.index + 1,
            currentSymbol: symbol,
            currentName: plan.stock.name || '',
            currentStatus: INCREMENTAL_NO_NEW_DATA_STATUS,
            lastMessage: `${symbol} BATCH_INCREMENTAL ${INCREMENTAL_NO_NEW_DATA_STATUS}：本轮批量日更无新增日线。`
          });

          continue;
        }

        batchFallbackPlans.push(plan);

        updateItem(state, plan.stock, {
          status: 'BATCH_RETRY_PENDING',
          syncMode: 'BATCH_INCREMENTAL',
          fetchStartDate: plan.syncPlan.fetchStartDate,
          fetchEndDate: plan.syncPlan.fetchEndDate,
          addedBars: 0,
          barCount: plan.syncPlan.cache.count || 0,
          startDate: plan.syncPlan.cache.startDate || '',
          endDate: plan.syncPlan.cache.endDate || '',
          costMs: batchPlanCostMs,
          error: result && result.error
            ? compactErrorMessage(result.error)
            : 'A股批量日更返回空数据，转入低并发批量重试。'
        });
      }

      await flushDeferredSyncStateSave(state);

      emitProgress(onProgress, state, stocks, {
        currentIndex: batch[batch.length - 1].index + 1,
        currentSymbol: batch[batch.length - 1].stock.symbol,
        currentStatus: 'BATCH_DONE',
        lastMessage: `A股批量日更 ${batchIndex + 1}/${batches.length} 完成。`
      });

      return true;
    },
    {
      shouldStop: () => isStopRequested(syncOptions)
    }
  );

  const finalFallbackPlans = fallbackPlans.slice();

  if (batchFallbackPlans.length > 0 && !isStopRequested(syncOptions)) {
    emitProgress(onProgress, state, stocks, {
      currentSymbol: '-',
      currentStatus: 'BATCH_RETRY',
      lastMessage: `A股低并发批量重试：${batchFallbackPlans.length} 只。`
    });

    const retryBatches = chunkArray(
      batchFallbackPlans,
      DEFAULT_ASHARE_FAST_DAILY_BATCH_SIZE
    );

    for (let retryIndex = 0; retryIndex < retryBatches.length; retryIndex += 1) {
      if (isStopRequested(syncOptions)) {
        break;
      }

      const retryBatch = retryBatches[retryIndex];

      const startDate = retryBatch.reduce((min, plan) => {
        const value = plan.syncPlan.fetchStartDate;
        return !min || value < min ? value : min;
      }, '');

      const endDate = retryBatch.reduce((max, plan) => {
        const value = plan.syncPlan.fetchEndDate;
        return !max || value > max ? value : max;
      }, '');

      retryBatch.forEach((plan) => {
        updateItem(state, plan.stock, {
          status: 'BATCH_RETRY_RUNNING',
          syncMode: 'BATCH_INCREMENTAL',
          fetchStartDate: plan.syncPlan.fetchStartDate,
          fetchEndDate: plan.syncPlan.fetchEndDate,
          error: ''
        });
      });

      await saveSyncState(state);

      emitProgress(onProgress, state, stocks, {
        currentIndex: retryBatch[0].index + 1,
        currentSymbol: retryBatch[0].stock.symbol,
        currentStatus: 'BATCH_RETRY_RUNNING',
        lastMessage: `A股低并发批量重试 ${retryIndex + 1}/${retryBatches.length}，symbols=${retryBatch.length}，${startDate} → ${endDate}。`
      });

      const retryStartedAt = Date.now();
      let retryResponse = null;

      try {
        retryResponse = await runAshareIncrementalBatchAdapter({
          symbols: retryBatch.map((plan) => plan.stock.symbol),
          startDate,
          endDate,
          adjust: 'qfq'
        });
      } catch (error) {
        retryResponse = {
          ok: false,
          error: compactErrorMessage(error),
          results: []
        };
      }

      const retryCostMs = Math.max(1, Date.now() - retryStartedAt);
      const retryPlanCostMs = Math.max(1, Math.round(retryCostMs / Math.max(1, retryBatch.length)));

      const retryResultMap = new Map();

      for (const result of Array.isArray(retryResponse && retryResponse.results) ? retryResponse.results : []) {
        retryResultMap.set(String(result.symbol || '').trim(), result);
      }

      for (const plan of retryBatch) {
        if (isStopRequested(syncOptions)) {
          break;
        }

        const symbol = plan.stock.symbol;
        const retryResult = retryResultMap.get(symbol);
        const retryBars = retryResult && Array.isArray(retryResult.bars) ? retryResult.bars : [];

        if (retryResult && retryResult.ok && retryBars.length > 0) {
          const upsertResult = await upsertDailyBarsLocked(symbol, retryBars);
          const cache = mergeCacheSnapshotWithBars(plan.syncPlan.cache, retryBars);

          await markDone(
            state,
            plan.stock,
            cache,
            retryPlanCostMs,
            {
              ...plan.syncPlan,
              syncMode: 'BATCH_INCREMENTAL'
            },
            {
              status: 'DONE',
              source: retryResult.source || 'baostock_a_share_batch_incremental_retry',
              chunkSource: retryResult.source || 'baostock_a_share_batch_incremental_retry',
              addedBars: Number(upsertResult && upsertResult.inserted) || retryBars.length,
              finishedChunks: [],
              failedChunks: []
            }
          );

          emitProgress(onProgress, state, stocks, {
            currentIndex: plan.index + 1,
            currentSymbol: symbol,
            currentName: plan.stock.name || '',
            currentStatus: 'DONE',
            lastMessage: `${symbol} BATCH_RETRY DONE，新增 ${Number(upsertResult && upsertResult.inserted) || retryBars.length} 条。`
          });

          continue;
        }

        if (
          retryResult
          && retryResult.ok
          && retryBars.length === 0
          && plan.syncPlan
          && plan.syncPlan.syncMode === 'INCREMENTAL'
          && plan.syncPlan.cache
          && Number(plan.syncPlan.cache.count) > 0
        ) {
          await markIncrementalNoNewData(
            state,
            plan.stock,
            {
              emptyBars: true,
              emptySource: retryResult.source || 'baostock_a_share_batch_incremental_retry'
            },
            retryPlanCostMs,
            plan.syncPlan
          );

          emitProgress(onProgress, state, stocks, {
            currentIndex: plan.index + 1,
            currentSymbol: symbol,
            currentName: plan.stock.name || '',
            currentStatus: INCREMENTAL_NO_NEW_DATA_STATUS,
            lastMessage: `${symbol} BATCH_RETRY ${INCREMENTAL_NO_NEW_DATA_STATUS}：低并发重试确认无新增日线。`
          });

          continue;
        }

        finalFallbackPlans.push(plan);

        updateItem(state, plan.stock, {
          status: 'FALLBACK_PENDING',
          syncMode: 'BATCH_INCREMENTAL',
          fetchStartDate: plan.syncPlan.fetchStartDate,
          fetchEndDate: plan.syncPlan.fetchEndDate,
          costMs: retryPlanCostMs,
          error: retryResult && retryResult.error
            ? compactErrorMessage(retryResult.error)
            : 'A股低并发批量重试仍为空，等待最终单股兜底。'
        });
      }

      await saveSyncState(state);

      emitProgress(onProgress, state, stocks, {
        currentIndex: retryBatch[retryBatch.length - 1].index + 1,
        currentSymbol: retryBatch[retryBatch.length - 1].stock.symbol,
        currentStatus: 'BATCH_RETRY_DONE',
        lastMessage: `A股低并发批量重试 ${retryIndex + 1}/${retryBatches.length} 完成。`
      });
    }
  }

  await flushDeferredSyncStateSave(state);
  configureDeferredSyncStateSave(state, { enabled: false });

  await runSingleStockFallbackPlans(context, finalFallbackPlans);
}

async function syncOneStock(context, stock, index, workerId) {
  const {
    syncOptions,
    state,
    previousItems,
    stocks,
    onProgress
  } = context;
  const itemStart = Date.now();
  let syncPlan = null;
  let fetchedThisSymbol = false;

  if (isStopRequested(syncOptions)) {
    emitProgress(onProgress, state, stocks, {
      currentIndex: index,
      currentStatus: 'STOPPING',
      lastMessage: '已停止，未再开始新的股票。'
    });
    return { fetchedThisSymbol, stopped: true };
  }

  setSymbolRunning(state, stock, true);

  try {
    syncPlan = await buildSyncPlan(stock, syncOptions, context.cacheIndex);

    updateItem(state, stock, {
      status: 'RUNNING',
      syncMode: syncPlan.syncMode,
      fetchStartDate: syncPlan.fetchStartDate,
      fetchEndDate: syncPlan.fetchEndDate,
      currentChunkStart: '',
      currentChunkEnd: '',
      finishedChunks: [],
      failedChunks: [],
      emptyChunks: [],
      emptyIncrementalRange: null,
      noNewDataReason: '',
      preferredSource: '',
      chunkSource: '',
      addedBars: 0,
      barCount: syncPlan.cache.count || 0,
      startDate: syncPlan.cache.startDate || '',
      endDate: syncPlan.cache.endDate || '',
      error: '',
      rawError: '',
      akshareError: '',
      eastmoneyError: '',
      altDailyError: '',
      lastTransportError: ''
    });
    await saveSyncState(state);

    emitProgress(onProgress, state, stocks, {
      currentIndex: index + 1,
      currentSymbol: stock.symbol,
      currentName: stock.name || '',
      currentStatus: 'RUNNING',
      lastMessage: `worker ${workerId} 正在同步 ${stock.symbol}${stock.name ? ` ${stock.name}` : ''}，模式 ${syncPlan.syncMode}。`
    });

    const previousItem = previousItems[stock.symbol] || {};

    if (syncPlan.syncMode === 'SKIPPED') {
      const freshCacheResult = buildFreshCacheFullChunkedResult(previousItem, syncPlan);

      if (freshCacheResult) {
        await markDone(
          state,
          stock,
          syncPlan.cache || {},
          Date.now() - itemStart,
          {
            ...syncPlan,
            syncMode: 'FULL_CHUNKED',
            fetchStartDate: previousItem.fetchStartDate || (syncPlan.cache && syncPlan.cache.startDate) || '',
            fetchEndDate: syncPlan.fetchEndDate
          },
          freshCacheResult
        );
        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: freshCacheResult.status,
          lastMessage: `${stock.symbol} 缓存已到目标日期，旧分段缺口已标记为 ${freshCacheResult.status}。`
        });
        return { fetchedThisSymbol, status: freshCacheResult.status };
      }

      const reason = await markSkipped(
        state,
        stock,
        syncPlan,
        Date.now() - itemStart,
        syncPlan.reason
      );
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'SKIPPED',
        lastMessage: reason
      });
      return { fetchedThisSymbol, status: 'SKIPPED' };
    }

    if (!syncOptions.retryFailed) {
      if (previousItem.status === 'FAILED') {
        const reason = await markSkipped(
          state,
          stock,
          syncPlan,
          Date.now() - itemStart,
          `${stock.symbol} 上次失败，retryFailed=false，已跳过。`
        );
        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: 'SKIPPED',
          lastMessage: reason
        });
        return { fetchedThisSymbol, status: 'SKIPPED' };
      }
    }

    try {
      if (!syncPlan.fetchStartDate || !syncPlan.fetchEndDate) {
        throw new Error(`${stock.symbol} 同步日期范围无效。`);
      }

      const fetchResult = syncPlan.syncMode === 'FULL_CHUNKED'
        ? await fetchAndSaveFullChunkedSymbol(stock, syncOptions, syncPlan, onProgress, state, stocks, index)
        : await fetchAndSaveSymbol(stock, syncOptions, syncPlan, onProgress, state, stocks, index);
      fetchedThisSymbol = true;
      const cache = await getCacheSnapshot(stock.symbol, { preferSqlite: true });
      await markDone(state, stock, cache, Date.now() - itemStart, syncPlan, fetchResult);
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: fetchResult.status || 'DONE',
        lastMessage: `${stock.symbol} ${syncPlan.syncMode} ${fetchResult.status || 'DONE'}，新增 ${fetchResult.addedBars} 条，当前缓存 ${cache.count} 条。`
      });
      return { fetchedThisSymbol, status: fetchResult.status || 'DONE' };
    } catch (error) {
      fetchedThisSymbol = true;

      if (isCacheWriteMemoryError(error)) {
        requestStop(syncOptions);
        const stopMessage = await markCacheWriteStopped(
          state,
          stock,
          error,
          Date.now() - itemStart,
          syncPlan
        );
        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: 'STOPPING',
          lastMessage: stopMessage
        });
        return { fetchedThisSymbol, status: 'PENDING', stopped: true };
      }

      if (isIncrementalNoNewDataError(error, syncPlan)) {
        const noNewData = await markIncrementalNoNewData(
          state,
          stock,
          error,
          Date.now() - itemStart,
          syncPlan
        );
        emitProgress(onProgress, state, stocks, {
          currentIndex: index + 1,
          currentSymbol: stock.symbol,
          currentName: stock.name || '',
          currentStatus: noNewData.status,
          lastMessage: `${stock.symbol} INCREMENTAL ${noNewData.status}：${noNewData.reason}。`
        });
        return { fetchedThisSymbol, status: noNewData.status };
      }

      const errorMessage = await markFailed(state, stock, error, Date.now() - itemStart, syncPlan);
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'FAILED',
        lastMessage: `${stock.symbol} 同步失败：${errorMessage}`
      });

      if (!isStopRequested(syncOptions)) {
        await sleep(syncOptions.failPauseMs);
      }

      return { fetchedThisSymbol, status: 'FAILED' };
    }
  } catch (error) {
    fetchedThisSymbol = true;
    const fallbackPlan = syncPlan || {
      syncMode: '',
      fetchStartDate: '',
      fetchEndDate: '',
      cache: {}
    };

    if (isCacheWriteMemoryError(error)) {
      requestStop(syncOptions);
      const stopMessage = await markCacheWriteStopped(
        state,
        stock,
        error,
        Date.now() - itemStart,
        fallbackPlan
      );
      emitProgress(onProgress, state, stocks, {
        currentIndex: index + 1,
        currentSymbol: stock.symbol,
        currentName: stock.name || '',
        currentStatus: 'STOPPING',
        lastMessage: stopMessage
      });
      return { fetchedThisSymbol, status: 'PENDING', stopped: true };
    }

    const errorMessage = await markFailed(state, stock, error, Date.now() - itemStart, fallbackPlan);
    emitProgress(onProgress, state, stocks, {
      currentIndex: index + 1,
      currentSymbol: stock.symbol,
      currentName: stock.name || '',
      currentStatus: 'FAILED',
      lastMessage: `${stock.symbol} 同步失败：${errorMessage}`
    });

    if (!isStopRequested(syncOptions)) {
      await sleep(syncOptions.failPauseMs);
    }

    return { fetchedThisSymbol, status: 'FAILED' };
  } finally {
    setSymbolRunning(state, stock, false);
    await saveSyncState(state);
  }
}

async function syncFullMarketHistory(options = {}, onProgress) {
  setCacheBackendPreference('disk_sqlite');
  const syncOptions = normalizeSyncOptions(options);
  syncOptions.stopSignal = syncOptions.stopSignal || {};
  const cacheBackend = getCacheBackend();
  const state = loadSyncState();
  const previousItems = { ...(state.items || {}) };
  const cacheIndex = loadCacheIndex({ reload: true });
  let stocks = [];
  let selectedSymbols = [];
  let deferredCacheSaveStarted = false;

  try {
    await beginDeferredCacheSaveLocked();
    deferredCacheSaveStarted = true;

    const universe = await loadStockUniverse();
    stocks = selectStocksForSync(syncOptions, universe.stocks);
    selectedSymbols = await prepareStateForRun(state, stocks, syncOptions);

    await resolveAshareSyncTargetEndDate(syncOptions, state, stocks, onProgress);

    emitProgress(onProgress, state, stocks, {
      lastMessage: stocks.length > 0
        ? `同步任务已启动，并发 ${syncOptions.concurrency}，cacheBackend=${cacheBackend}，targetEnd=${syncOptions.endDate}。`
        : '没有匹配到需要同步的股票。'
    });

    if (stocks.length === 0) {
      state.running = false;
      state.finishedAt = nowIso();
      await saveSyncState(state);
      return emitProgress(onProgress, state, stocks, {
        lastMessage: '没有匹配到需要同步的股票。'
      });
    }

    const runtime = {
      completedFetches: 0,
      fetchedSinceBatchPause: 0,
      lastCacheFlushFetches: 0,
      skippedSinceYield: 0
    };
    const context = {
      syncOptions,
      state,
      previousItems,
      stocks,
      onProgress,
      runtime,
      cacheIndex,
      cacheBackend
    };

    if (syncOptions.fastDaily && !syncOptions.force) {
      await runFastDailyAshareSync(context);
    } else {
      await runWorkerPool(
        stocks,
        syncOptions.concurrency,
        async (stock, index, workerId) => {
          const result = await syncOneStock(context, stock, index, workerId);
          await waitAfterFetchedSymbol(context, stock, index, result && result.fetchedThisSymbol);
          await waitAfterSkippedSymbol(context, stock, index, result && result.status);
          return result;
        },
        {
          shouldStop: () => isStopRequested(syncOptions)
        }
      );
    }

    await flushCacheToDiskLocked();
    state.activeWorkers = 0;
    state.runningSymbols = [];
    state.running = false;
    state.finishedAt = nowIso();
    await saveSyncState(state);

    const elapsedText = getStateElapsedText(state);

    const finalProgress = emitProgress(onProgress, state, stocks, {
      currentStatus: isStopRequested(syncOptions) ? 'STOPPED' : 'DONE',
      lastMessage: isStopRequested(syncOptions)
        ? `同步已停止。${elapsedText ? `本次耗时 ${elapsedText}。` : ''}`
        : `同步任务已完成。${elapsedText ? `本次耗时 ${elapsedText}。` : ''}`
    });

    return finalProgress;
  } catch (error) {
    let cacheFlushError = '';

    if (deferredCacheSaveStarted) {
      try {
        await flushCacheToDiskLocked();
      } catch (flushError) {
        cacheFlushError = compactErrorMessage(flushError);
      }
    }

    state.activeWorkers = 0;
    state.runningSymbols = [];
    state.running = false;
    state.finishedAt = nowIso();
    state.lastError = cacheFlushError
      ? `${compactErrorMessage(error)}；缓存落盘失败：${cacheFlushError}`
      : compactErrorMessage(error);
    await saveSyncState(state);

    const elapsedText = getStateElapsedText(state);

    const failedProgress = buildProgress({
      state,
      selectedSymbols,
      total: selectedSymbols.length,
      currentStatus: 'FAILED',
      lastMessage: `同步任务失败：${state.lastError}${elapsedText ? `；本次耗时 ${elapsedText}` : ''}`
    });

    if (typeof onProgress === 'function') {
      onProgress(failedProgress);
    }

    if (isSymbolsScopeError(error)) {
      throw error;
    }

    return failedProgress;
  } finally {
    if (deferredCacheSaveStarted) {
      try {
        await endDeferredCacheSaveLocked();
      } catch (error) {
        state.lastError = compactErrorMessage(error);
      }
    }
  }
}

module.exports = {
  syncFullMarketHistory,
  loadSyncState,
  saveSyncState,
  buildProgress,
  getSyncStatePath,
  normalizeSyncOptions,
  normalizeSyncSymbols,
  selectStocksForSync,
  getCacheSnapshot,
  buildSyncPlan,
  resolveFullChunkedStatus,
  runWorkerPool,
  withWriteLock,
  upsertDailyBarsLocked,
  cacheIndexExists,
  loadCacheIndex,
  getCacheIndexPath,
  DEFAULT_SYNC_OPTIONS,
  CACHE_INDEX_VERSION,
  SYNC_VERSION
};
