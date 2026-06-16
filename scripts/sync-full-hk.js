const fs = require('fs');
const path = require('path');
const { getHongKongDailyBars } = require('../src/data/hkDataService');
const { spawn } = require('child_process');
const { getPythonChildEnv } = require('../src/workers/pythonWorker');
const { upsertDailyBars } = require('../src/core/localCache');
const { runSqliteDiskCacheBridge } = require('../src/core/sqliteDiskCacheBridge');
const {
  refreshHongKongStockUniverse,
  selectHongKongStocksForSync,
  normalizeSymbolList,
  getHongKongStockUniversePath
} = require('../src/data/hkStockUniverseService');
const {
  getSymbolDateRange,
  setCacheBackendPreference
} = require('../src/core/localCache');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SYNC_DIR = path.join(PROJECT_ROOT, 'data', 'sync');
const HK_SYNC_STATE_PATH = path.join(SYNC_DIR, 'full-hk-sync-state.json');
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;
const DEFAULT_CHUNK_YEARS = 5;
const HK_BATCH_INCREMENTAL_ADAPTER_PATH = path.join(
  PROJECT_ROOT,
  'src',
  'adapters',
  'hkIncrementalBatchAdapter.py'
);

const DEFAULT_DAILY_BATCH_SIZE = 120;
const DEFAULT_DAILY_BATCH_CONCURRENCY = 8;
const HK_SYNC_END_DATE_PROBE_SYMBOLS = ['HK:00700', 'HK:09988', 'HK:03690', 'HK:00005'];
const HK_SYNC_END_DATE_PROBE_LOOKBACK_DAYS = 14;
const HK_SUSPENDED_FILTER_LAG_DAYS = 30;

function ensureSyncDir() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function compactError(error, limit = 260) {
  const text = String(error && error.message ? error.message : error || '未知错误')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function isNoDailyBarsError(error) {
  const text = String(error && error.message ? error.message : error || '');

  return text.includes('东方财富港股直连与腾讯港股直连均失败')
    || text.includes('港股日线拉取失败')
    || text.includes('返回空数据');
}

function appendArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
    return;
  }

  if (Array.isArray(args[key])) {
    args[key].push(value);
    return;
  }

  args[key] = [args[key], value];
}

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];

    if (!part.startsWith('--')) {
      args._.push(part);
      continue;
    }

    const eqIndex = part.indexOf('=');

    if (eqIndex >= 0) {
      const key = part.slice(2, eqIndex);
      appendArg(args, key, part.slice(eqIndex + 1));
      continue;
    }

    const key = part.slice(2);

    if (key === 'symbols') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        appendArg(args, key, argv[index + 1]);
        index += 1;
      }

      if (args[key] === undefined) {
        args[key] = '';
      }

      continue;
    }

    const next = argv[index + 1];

    if (next && !next.startsWith('--')) {
      appendArg(args, key, next);
      index += 1;
    } else {
      appendArg(args, key, true);
    }
  }

  return args;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return value === true || value === 'true' || value === '1';
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
  const num = Math.floor(toNumber(value, fallback));
  return num >= 1 && num <= MAX_CONCURRENCY ? num : fallback;
}

function normalizeDateText(value, fallback) {
  const text = String(value || fallback || '').trim().replace(/-/g, '');

  if (!/^\d{8}$/.test(text)) {
    throw new Error(`日期格式必须是 YYYYMMDD，例如 20200101。当前输入：${value}`);
  }

  return text;
}

function getTodayDateText() {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatDateText(date) {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function dateTextToDate(value) {
  const text = normalizeDateText(value, '19700101');
  const date = new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(4, 6)) - 1,
    Number(text.slice(6, 8))
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(value, days) {
  const date = dateTextToDate(value);
  date.setDate(date.getDate() + days);
  return formatDateText(date);
}

function getChunkEndDate(startDate, requestedEndDate, chunkYears) {
  const start = dateTextToDate(startDate);
  const endText = normalizeDateText(requestedEndDate, getTodayDateText());
  const chunkEnd = new Date(start.getTime());
  chunkEnd.setFullYear(chunkEnd.getFullYear() + chunkYears);
  chunkEnd.setDate(chunkEnd.getDate() - 1);
  const chunkEndText = formatDateText(chunkEnd);
  return chunkEndText > endText ? endText : chunkEndText;
}

function buildChunks(startDate, endDate, chunkYears = DEFAULT_CHUNK_YEARS) {
  const chunks = [];
  let currentStart = normalizeDateText(startDate, '20180101');
  const endText = normalizeDateText(endDate, getTodayDateText());
  let guard = 0;

  while (currentStart <= endText && guard < 80) {
    const currentEnd = getChunkEndDate(currentStart, endText, chunkYears);
    chunks.push({ startDate: currentStart, endDate: currentEnd });
    currentStart = addDays(currentEnd, 1);
    guard += 1;
  }

  return chunks;
}

function getLatestBarDateFromBars(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let latest = '';

  for (const bar of list) {
    const dateText = normalizeDateText(bar && bar.date, '');

    if (dateText && dateText > latest) {
      latest = dateText;
    }
  }

  return latest;
}

async function probeHkLatestTradingDate(options) {
  const requestedEndDate = normalizeDateText(options.endDate, getTodayDateText());
  const probeStartDate = addDays(requestedEndDate, -HK_SYNC_END_DATE_PROBE_LOOKBACK_DAYS) || requestedEndDate;
  const errors = [];

  for (const symbol of HK_SYNC_END_DATE_PROBE_SYMBOLS) {
    try {
      const result = await getHongKongDailyBars({
        symbol,
        startDate: probeStartDate,
        endDate: requestedEndDate,
        refresh: true,
        cacheOnly: false,
        networkMode: options.networkMode,
        adjust: 'qfq'
      });

      const latestDate = getLatestBarDateFromBars(result && result.bars);

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
      errors.push(`${symbol} ${compactError(error)}`);
    }
  }

  return {
    ok: false,
    latestDate: '',
    requestedEndDate,
    error: errors.slice(-4).join('；')
  };
}

async function resolveHkSyncTargetEndDate(options, state) {
  const requestedEndDate = normalizeDateText(options.endDate, getTodayDateText());

  options.requestedCalendarEndDate = requestedEndDate;
  options.resolvedTargetEndDate = requestedEndDate;

  state.requestedCalendarEndDate = requestedEndDate;
  state.resolvedTargetEndDate = requestedEndDate;

  const shouldProbeTradingDate = !options.endDateExplicit
    || (options.fastDaily && !options.force);

  if (options.endDateExplicit && !shouldProbeTradingDate) {
    saveState(state);
    return requestedEndDate;
  }

  state.currentSymbol = '-';
  state.currentStatus = 'PROBING';
  state.lastMessage = `正在探测港股最新可用交易日，当前日历目标 ${requestedEndDate}。`;
  saveState(state);
  printProgress(state, '-', state.lastMessage);

  const probe = await probeHkLatestTradingDate(options);

  console.log('[sync-full-hk][probe-debug]', JSON.stringify({
    requestedEndDate,
    ok: probe.ok,
    latestDate: probe.latestDate || '',
    source: probe.source || '',
    error: probe.error || '',
    endDateBeforeResolve: options.endDate,
    endDateExplicit: options.endDateExplicit,
    fastDaily: options.fastDaily,
    force: options.force
  }, null, 2));

  if (!probe.ok || !probe.latestDate) {
    state.currentSymbol = '-';
    state.currentStatus = 'PROBE_FALLBACK';
    state.lastMessage = `港股最新交易日探测失败，继续使用日历目标 ${requestedEndDate}。${probe.error || ''}`;
    saveState(state);
    printProgress(state, '-', state.lastMessage);
    return requestedEndDate;
  }

  const resolvedDate = probe.latestDate > requestedEndDate
    ? requestedEndDate
    : probe.latestDate;

  options.endDate = resolvedDate;
  options.resolvedTargetEndDate = resolvedDate;

  state.requestedCalendarEndDate = requestedEndDate;
  state.resolvedTargetEndDate = resolvedDate;
  state.currentSymbol = probe.symbol || '-';
  state.currentStatus = 'PROBED';
  state.lastMessage = resolvedDate === requestedEndDate
    ? `港股最新可用交易日：${resolvedDate}，source=${probe.source || '-'}。`
    : `港股日历目标 ${requestedEndDate} 修正为最新可用交易日 ${resolvedDate}，source=${probe.source || '-'}。`;

  saveState(state);
  printProgress(state, probe.symbol || '-', state.lastMessage);

  return resolvedDate;
}

function isShortDailyIncremental(startDate, endDate) {
  const start = dateTextToDate(startDate);
  const end = dateTextToDate(endDate);

  if (!start || !end) {
    return false;
  }

  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 10;
}

function chunkArray(items, size) {
  const result = [];
  const step = Math.max(1, Number(size) || DEFAULT_DAILY_BATCH_SIZE);

  for (let index = 0; index < items.length; index += step) {
    result.push(items.slice(index, index + step));
  }

  return result;
}

function parseAdapterJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`港股批量增量 Worker 没有返回 JSON：${text.slice(0, 300)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function runHkIncrementalBatchAdapter(payload, networkMode) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON || 'python',
      [HK_BATCH_INCREMENTAL_ADAPTER_PATH],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: getPythonChildEnv(networkMode || 'direct')
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
      reject(new Error('港股批量增量 Worker 超时。'));
    }, 180000);

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

function loadState() {
  if (!fs.existsSync(HK_SYNC_STATE_PATH)) {
    return {
      version: 'dev-0.1.9.1',
      market: 'HK',
      startedAt: '',
      finishedAt: '',
      running: false,
      total: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      items: {},
      lastError: ''
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(HK_SYNC_STATE_PATH, 'utf8'));
    return {
      version: 'dev-0.1.9.1',
      market: 'HK',
      startedAt: state.startedAt || '',
      finishedAt: state.finishedAt || '',
      running: Boolean(state.running),
      total: Number(state.total) || 0,
      done: Number(state.done) || 0,
      skipped: Number(state.skipped) || 0,
      failed: Number(state.failed) || 0,
      items: state.items && typeof state.items === 'object' ? state.items : {},
      lastError: state.lastError || ''
    };
  } catch (error) {
    return {
      version: 'dev-0.1.9.1',
      market: 'HK',
      startedAt: '',
      finishedAt: '',
      running: false,
      total: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      items: {},
      lastError: compactError(error)
    };
  }
}

function saveState(state) {
  ensureSyncDir();
  fs.writeFileSync(HK_SYNC_STATE_PATH, `${JSON.stringify({ ...state, updatedAt: nowIso() }, null, 2)}\n`, 'utf8');
}

function updateCounters(state) {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let noDailyBars = 0;

  for (const item of Object.values(state.items || {})) {
    if (item.status === 'DONE') {
      done += 1;
    } else if (item.status === 'SKIPPED') {
      skipped += 1;
    } else if (item.status === 'FAILED') {
      failed += 1;
    } else if (item.status === 'NO_DAILY_BARS') {
      noDailyBars += 1;
    }
  }

  state.done = done;
  state.skipped = skipped;
  state.failed = failed;
  state.noDailyBars = noDailyBars;
}

function formatMs(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

function printProgress(state, currentSymbol, message) {
  updateCounters(state);
  const completed = state.done + state.skipped + state.failed + (state.noDailyBars || 0);
  const percent = state.total > 0 ? (completed / state.total) * 100 : 0;
  const started = state.startedAt ? Date.parse(state.startedAt) : Date.now();
  console.log(
    `[sync-full-hk] ${percent.toFixed(2)}% ${completed}/${state.total} `
    + `done=${state.done} skip=${state.skipped} nodaily=${state.noDailyBars || 0} fail=${state.failed} `
    + `current=${currentSymbol || '-'} elapsed=${formatMs(Date.now() - started)} ${message || ''}`
  );
}

async function runWorkerPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.min(concurrency, Math.max(1, items.length));

  async function runOne(workerId) {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      await worker(items[index], index, workerId);
    }
  }

  for (let workerId = 1; workerId <= workerCount; workerId += 1) {
    workers.push(runOne(workerId));
  }

  await Promise.all(workers);
}

async function loadCacheRangeIndex() {
  const result = await runSqliteDiskCacheBridge('build-index-summary');
  const items = result && result.items && typeof result.items === 'object'
    ? result.items
    : {};

  const index = new Map();

  for (const [symbol, item] of Object.entries(items)) {
    const cleanSymbol = String(symbol || '').toUpperCase();

    index.set(cleanSymbol, {
      symbol: cleanSymbol,
      count: Number(item && (item.barCount || item.count)) || 0,
      startDate: item && item.startDate || '',
      endDate: item && item.endDate || '',
      backend: 'disk_sqlite_index'
    });
  }

  return index;
}

function getCacheRangeFromIndex(cacheRangeIndex, symbol) {
  const cleanSymbol = String(symbol || '').toUpperCase();
  const range = cacheRangeIndex && cacheRangeIndex.get(cleanSymbol);

  if (range) {
    return range;
  }

  return {
    symbol: cleanSymbol,
    count: 0,
    startDate: '',
    endDate: '',
    backend: 'disk_sqlite_index'
  };
}

function toDisplayDateText(value) {
  const text = String(value || '').replace(/-/g, '');

  if (!/^\d{8}$/.test(text)) {
    return '';
  }

  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function mergeCacheRangeWithBars(range, bars) {
  const list = Array.isArray(bars) ? bars : [];
  let startDate = toDisplayDateText(range && range.startDate);
  let endDate = toDisplayDateText(range && range.endDate);
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
    count: (Number(range && range.count) || 0) + validAdded,
    startDate,
    endDate
  };
}

function getDateLagDays(fromDate, toDate) {
  const fromText = String(fromDate || '').replace(/-/g, '');
  const toText = String(toDate || '').replace(/-/g, '');

  if (!/^\d{8}$/.test(fromText) || !/^\d{8}$/.test(toText)) {
    return null;
  }

  const from = dateTextToDate(fromText);
  const to = dateTextToDate(toText);

  if (!from || !to) {
    return null;
  }

  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function isLikelySuspendedByCache(range, targetEndDate) {
  const cachedEnd = String(range && range.endDate || '').replace(/-/g, '');

  if (Number(range && range.count) <= 0 || !/^\d{8}$/.test(cachedEnd)) {
    return false;
  }

  const lagDays = getDateLagDays(cachedEnd, targetEndDate);

  return Number.isFinite(lagDays) && lagDays >= HK_SUSPENDED_FILTER_LAG_DAYS;
}

function isCacheFreshEnough(range, endDate) {
  const endText = normalizeDateText(endDate, getTodayDateText());
  const cachedEnd = String(range && range.endDate || '').replace(/-/g, '');

  return Number(range && range.count) > 0
    && /^\d{8}$/.test(cachedEnd)
    && cachedEnd >= endText;
}

async function buildIncrementalPlans(stocks, options, state, cacheRangeIndex) {
  const plans = [];
  const targetEndDate = normalizeDateText(options.endDate, getTodayDateText());

  for (let planIndex = 0; planIndex < stocks.length; planIndex += 1) {
    const stock = stocks[planIndex];
    const symbol = stock.symbol;
    if (planIndex === 0 || planIndex % 100 === 0) {
      state.currentSymbol = symbol;
      state.currentStatus = 'PLANNING';
      state.lastMessage = `港股快速日更规划中：${planIndex + 1}/${stocks.length}，正在检查本地缓存日期`;
      saveState(state);
      printProgress(state, symbol, state.lastMessage);
    }
    const beforeRange = getCacheRangeFromIndex(cacheRangeIndex, symbol);
    const cachedEndDate = String(beforeRange && beforeRange.endDate || '').replace(/-/g, '');

    if (!options.force && isLikelySuspendedByCache(beforeRange, targetEndDate)) {
      const lagDays = getDateLagDays(cachedEndDate, targetEndDate);

      state.items[symbol] = {
        symbol,
        name: stock.name || '',
        market: 'HK',
        status: 'SKIPPED',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        barCount: beforeRange.count || 0,
        startDate: beforeRange.startDate || '',
        endDate: beforeRange.endDate || '',
        addedBars: 0,
        source: 'SQLite 本地缓存｜疑似停牌/长期无交易，日更过滤',
        error: `最后日线 ${beforeRange.endDate || cachedEndDate}，距目标 ${targetEndDate} 已 ${lagDays} 天，跳过每日同步`,
        syncMode: 'SUSPENDED_FILTER',
        effectiveStartDate: '',
        targetEndDate,
        staleDays: lagDays
      };

      continue;
    }

    // if (!options.force && options.fastDaily && Number(beforeRange && beforeRange.count) <= 0 && !options.fillMissing) {
    //   state.items[symbol] = {
    //     symbol,
    //     name: stock.name || '',
    //     market: 'HK',
    //     status: 'SKIPPED',
    //     startedAt: nowIso(),
    //     finishedAt: nowIso(),
    //     barCount: 0,
    //     startDate: '',
    //     endDate: '',
    //     addedBars: 0,
    //     source: '无本地缓存基线｜快速日更跳过，交给全量补齐',
    //     error: '快速日更不对无本地缓存股票做全量历史补齐，避免日更任务被拖成数小时',
    //     syncMode: 'NO_LOCAL_CACHE_FAST_DAILY_SKIP',
    //     effectiveStartDate: '',
    //     targetEndDate
    //   };

    //   continue;
    // }

    if (!options.force && isCacheFreshEnough(beforeRange, targetEndDate)) {
      state.items[symbol] = {
        symbol,
        name: stock.name || '',
        market: 'HK',
        status: 'SKIPPED',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        barCount: beforeRange.count || 0,
        startDate: beforeRange.startDate || '',
        endDate: beforeRange.endDate || '',
        addedBars: 0,
        source: 'SQLite 本地缓存｜港股已到目标日期',
        error: '',
        syncMode: 'INCREMENTAL_SKIP',
        effectiveStartDate: '',
        targetEndDate
      };
      continue;
    }

    let effectiveStartDate = options.startDate;
    let syncMode = 'FULL_NO_CACHE';

    if (!options.force && Number(beforeRange && beforeRange.count) > 0 && /^\d{8}$/.test(cachedEndDate)) {
      effectiveStartDate = addDays(cachedEndDate, 1);
      syncMode = 'INCREMENTAL';
    } else if (options.force) {
      effectiveStartDate = options.startDate;
      syncMode = 'FULL_FORCE';
    }

    plans.push({
      stock,
      symbol,
      beforeRange,
      effectiveStartDate,
      targetEndDate,
      syncMode
    });
  }

  state.currentSymbol = '-';
  state.currentStatus = 'PLANNED';
  state.lastMessage = `港股快速日更规划完成：待处理 ${plans.length} 只`;
  saveState(state);
  return plans;
}

async function runFastDailyIncrementalSync(stocks, options, state) {
  state.currentSymbol = '-';
  state.currentStatus = 'INDEXING';
  state.lastMessage = '港股快速日更：正在一次性读取 SQLite 缓存索引';
  saveState(state);
  printProgress(state, '-', state.lastMessage);

  const cacheRangeIndex = await loadCacheRangeIndex();

  state.currentSymbol = '-';
  state.currentStatus = 'PLANNING';
  state.lastMessage = `港股快速日更：缓存索引读取完成，indexed=${cacheRangeIndex.size}，开始生成批量计划`;
  saveState(state);
  printProgress(state, '-', state.lastMessage);

  const plans = await buildIncrementalPlans(stocks, options, state, cacheRangeIndex);
  const dailyPlans = plans.filter((plan) => {
    return plan.syncMode === 'INCREMENTAL'
      && isShortDailyIncremental(plan.effectiveStartDate, plan.targetEndDate);
  });

  const fallbackPlans = plans.filter((plan) => !dailyPlans.includes(plan));
  const batchFallbackPlans = [];

  printProgress(
    state,
    '-',
    `港股快速日更：已最新 ${state.skipped || 0}，批量增量 ${dailyPlans.length}，常规补齐 ${fallbackPlans.length}`
  );

  const batches = chunkArray(dailyPlans, options.dailyBatchSize || DEFAULT_DAILY_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const startDate = batch.reduce((min, item) => {
      return !min || item.effectiveStartDate < min ? item.effectiveStartDate : min;
    }, '');
    const endDate = batch.reduce((max, item) => {
      return !max || item.targetEndDate > max ? item.targetEndDate : max;
    }, '');

    batch.forEach((plan) => {
      state.items[plan.symbol] = {
        symbol: plan.symbol,
        name: plan.stock.name || '',
        market: 'HK',
        status: 'RUNNING',
        startedAt: nowIso(),
        finishedAt: '',
        barCount: plan.beforeRange.count || 0,
        startDate: plan.beforeRange.startDate || '',
        endDate: plan.beforeRange.endDate || '',
        addedBars: 0,
        source: '港股批量日更',
        error: '',
        syncMode: 'BATCH_INCREMENTAL',
        effectiveStartDate: plan.effectiveStartDate,
        targetEndDate: plan.targetEndDate
      };
    });

    saveState(state);
    printProgress(
      state,
      batch[0] ? batch[0].symbol : '-',
      `批量日更 ${batchIndex + 1}/${batches.length}：本批 ${batch.length} 只，worker内部并发=${options.dailyBatchConcurrency || DEFAULT_DAILY_BATCH_CONCURRENCY}，${startDate} → ${endDate}`
    );

    let response = null;

    try {
      response = await runHkIncrementalBatchAdapter({
        symbols: batch.map((plan) => plan.symbol),
        startDate,
        endDate,
        adjust: 'qfq',
        networkMode: options.networkMode,
        concurrency: options.dailyBatchConcurrency || DEFAULT_DAILY_BATCH_CONCURRENCY
      }, options.networkMode);
    } catch (error) {
      response = {
        ok: false,
        error: compactError(error),
        results: []
      };
    }

    const resultMap = new Map();

    for (const result of Array.isArray(response && response.results) ? response.results : []) {
      resultMap.set(String(result.symbol || '').toUpperCase(), result);
    }

    for (const plan of batch) {
      const result = resultMap.get(plan.symbol);
      const bars = result && Array.isArray(result.bars) ? result.bars : [];

      if (result && result.ok && bars.length) {
        await upsertDailyBars(plan.symbol, bars);

        const range = mergeCacheRangeWithBars(plan.beforeRange, bars);

        state.items[plan.symbol] = {
          ...state.items[plan.symbol],
          status: 'DONE',
          finishedAt: nowIso(),
          barCount: range.count || 0,
          startDate: range.startDate || '',
          endDate: range.endDate || '',
          addedBars: bars.length,
          source: result.source || '港股批量日更',
          costMs: 0,
          error: ''
        };
      } else {
        const hasExistingCache = Number(plan.beforeRange && plan.beforeRange.count) > 0;

        if (hasExistingCache && plan.syncMode === 'INCREMENTAL') {
          state.items[plan.symbol] = {
            ...state.items[plan.symbol],
            status: 'SKIPPED',
            finishedAt: nowIso(),
            addedBars: 0,
            barCount: plan.beforeRange.count || 0,
            startDate: plan.beforeRange.startDate || '',
            endDate: plan.beforeRange.endDate || '',
            source: 'SQLite 本地缓存｜本轮无新增日线',
            error: `本轮增量区间 ${plan.effectiveStartDate} → ${plan.targetEndDate} 无新增日线，不进入重试`,
            syncMode: 'INCREMENTAL_NO_NEW_DATA'
          };
          continue;
        }

        batchFallbackPlans.push(plan);

        state.items[plan.symbol] = {
          ...state.items[plan.symbol],
          status: 'BATCH_RETRY_PENDING',
          finishedAt: '',
          addedBars: 0,
          source: '港股批量日更未取到数据｜等待低并发批量重试',
          error: result && result.error
            ? String(result.error).slice(0, 300)
            : '港股批量日更返回空数据，转入低并发批量重试'
        };
      }
    }

    saveState(state);
    printProgress(state, batch[0] ? batch[0].symbol : '-', `批量日更 ${batchIndex + 1}/${batches.length} 完成`);
  }

  const finalFallbackPlans = fallbackPlans.slice();

  if (batchFallbackPlans.length > 0) {
    printProgress(
      state,
      '-',
      `港股低并发批量重试：${batchFallbackPlans.length} 只。`
    );

    const retryBatches = chunkArray(
      batchFallbackPlans,
      Math.min(20, options.dailyBatchSize || DEFAULT_DAILY_BATCH_SIZE)
    );

    for (let retryIndex = 0; retryIndex < retryBatches.length; retryIndex += 1) {
      const retryBatch = retryBatches[retryIndex];

      const startDate = retryBatch.reduce((min, item) => {
        return !min || item.effectiveStartDate < min ? item.effectiveStartDate : min;
      }, '');

      const endDate = retryBatch.reduce((max, item) => {
        return !max || item.targetEndDate > max ? item.targetEndDate : max;
      }, '');

      retryBatch.forEach((plan) => {
        state.items[plan.symbol] = {
          ...state.items[plan.symbol],
          status: 'BATCH_RETRY_RUNNING',
          finishedAt: '',
          addedBars: 0,
          source: '港股低并发批量重试中',
          error: ''
        };
      });

      saveState(state);

      printProgress(
        state,
        retryBatch[0] ? retryBatch[0].symbol : '-',
        `低并发批量重试 ${retryIndex + 1}/${retryBatches.length}：本批 ${retryBatch.length} 只，worker内部并发=1，${startDate} → ${endDate}`
      );

      let retryResponse = null;

      try {
        retryResponse = await runHkIncrementalBatchAdapter({
          symbols: retryBatch.map((plan) => plan.symbol),
          startDate,
          endDate,
          adjust: 'qfq',
          networkMode: options.networkMode,
          concurrency: 1
        }, options.networkMode);
      } catch (error) {
        retryResponse = {
          ok: false,
          error: compactError(error),
          results: []
        };
      }

      const retryResultMap = new Map();

      for (const result of Array.isArray(retryResponse && retryResponse.results) ? retryResponse.results : []) {
        retryResultMap.set(String(result.symbol || '').toUpperCase(), result);
      }

      for (const plan of retryBatch) {
        const retryResult = retryResultMap.get(plan.symbol);
        const retryBars = retryResult && Array.isArray(retryResult.bars) ? retryResult.bars : [];

        if (retryResult && retryResult.ok && retryBars.length) {
          await upsertDailyBars(plan.symbol, retryBars);

          const range = mergeCacheRangeWithBars(plan.beforeRange, retryBars);

          state.items[plan.symbol] = {
            ...state.items[plan.symbol],
            status: 'DONE',
            finishedAt: nowIso(),
            barCount: range.count || 0,
            startDate: range.startDate || '',
            endDate: range.endDate || '',
            addedBars: retryBars.length,
            source: retryResult.source || '港股低并发批量重试',
            costMs: 0,
            error: ''
          };
        } else {
          const hasExistingCache = Number(plan.beforeRange && plan.beforeRange.count) > 0;

          if (hasExistingCache && plan.syncMode === 'INCREMENTAL') {
            state.items[plan.symbol] = {
              ...state.items[plan.symbol],
              status: 'SKIPPED',
              finishedAt: nowIso(),
              addedBars: 0,
              barCount: plan.beforeRange.count || 0,
              startDate: plan.beforeRange.startDate || '',
              endDate: plan.beforeRange.endDate || '',
              source: 'SQLite 本地缓存｜低并发重试后仍无新增日线',
              error: `本轮增量区间 ${plan.effectiveStartDate} → ${plan.targetEndDate} 无新增日线，不进入单股兜底`,
              syncMode: 'INCREMENTAL_NO_NEW_DATA'
            };
            continue;
          }

          finalFallbackPlans.push(plan);

          state.items[plan.symbol] = {
            ...state.items[plan.symbol],
            status: 'FALLBACK_PENDING',
            finishedAt: '',
            addedBars: 0,
            source: '港股低并发批量重试仍为空｜等待单股兜底',
            error: retryResult && retryResult.error
              ? String(retryResult.error).slice(0, 300)
              : '港股低并发批量重试仍返回空数据'
          };
        }
      }

      saveState(state);
      printProgress(
        state,
        retryBatch[0] ? retryBatch[0].symbol : '-',
        `低并发批量重试 ${retryIndex + 1}/${retryBatches.length} 完成`
      );
    }
  }

  if (finalFallbackPlans.length > 0) {
    printProgress(
      state,
      '-',
      `港股单股兜底同步：${finalFallbackPlans.length} 只。`
    );

    await runWorkerPool(finalFallbackPlans, options.concurrency, async (plan, index, workerId) => {
      await syncOneStock(plan.stock, options, state, index, workerId);
    });
  }
}

async function syncOneStock(stock, options, state, index, workerId) {
  const symbol = stock.symbol;
  const itemStart = Date.now();
  let chunks = [];
  let addedBars = 0;
  let lastSource = '';
  let beforeRange = null;
  let effectiveStartDate = options.startDate;
  let syncMode = 'FULL_NO_CACHE';
  const targetEndDate = normalizeDateText(options.endDate, getTodayDateText());

  state.items[symbol] = {
    symbol,
    name: stock.name || '',
    market: 'HK',
    status: 'RUNNING',
    startedAt: nowIso(),
    finishedAt: '',
    barCount: 0,
    startDate: '',
    endDate: '',
    addedBars: 0,
    source: '',
    error: '',
    syncMode: '',
    effectiveStartDate: '',
    targetEndDate
  };
  saveState(state);
  printProgress(state, symbol, `worker ${workerId} 同步 ${symbol}${stock.name ? ` ${stock.name}` : ''}`);

  try {
    beforeRange = await getSymbolDateRange(symbol);
    const cachedEndDate = String(beforeRange && beforeRange.endDate || '').replace(/-/g, '');

    if (!options.force && isCacheFreshEnough(beforeRange, targetEndDate)) {
      state.items[symbol] = {
        ...state.items[symbol],
        status: 'SKIPPED',
        finishedAt: nowIso(),
        barCount: beforeRange.count || 0,
        startDate: beforeRange.startDate || '',
        endDate: beforeRange.endDate || '',
        addedBars: 0,
        source: 'SQLite 本地缓存｜港股已接近最新',
        costMs: Date.now() - itemStart,
        syncMode: 'INCREMENTAL_SKIP',
        effectiveStartDate: '',
        targetEndDate
      };
      saveState(state);
      printProgress(state, symbol, `[incremental] ${symbol} last=${beforeRange.endDate || '-'} target=${targetEndDate} skip=up_to_date`);
      return;
    }

    if (!options.force && Number(beforeRange && beforeRange.count) > 0 && /^\d{8}$/.test(cachedEndDate)) {
      effectiveStartDate = addDays(cachedEndDate, 1);
      syncMode = 'INCREMENTAL';
    } else if (options.force) {
      effectiveStartDate = options.startDate;
      syncMode = 'FULL_FORCE';
    } else {
      effectiveStartDate = options.startDate;
      syncMode = 'FULL_NO_CACHE';
    }

    if (effectiveStartDate > targetEndDate) {
      state.items[symbol] = {
        ...state.items[symbol],
        status: 'SKIPPED',
        finishedAt: nowIso(),
        barCount: beforeRange.count || 0,
        startDate: beforeRange.startDate || '',
        endDate: beforeRange.endDate || '',
        addedBars: 0,
        source: 'SQLite 本地缓存｜港股已接近最新',
        costMs: Date.now() - itemStart,
        syncMode: 'INCREMENTAL_SKIP',
        effectiveStartDate,
        targetEndDate
      };
      saveState(state);
      printProgress(state, symbol, `[incremental] ${symbol} last=${beforeRange.endDate || '-'} target=${targetEndDate} skip=up_to_date`);
      return;
    }

    chunks = buildChunks(effectiveStartDate, targetEndDate, options.chunkYears);

    state.items[symbol] = {
      ...state.items[symbol],
      barCount: beforeRange.count || 0,
      startDate: beforeRange.startDate || '',
      endDate: beforeRange.endDate || '',
      syncMode,
      effectiveStartDate,
      targetEndDate,
      totalChunks: chunks.length,
      source: beforeRange.count > 0 ? 'SQLite 本地缓存｜港股增量基线' : ''
    };
    saveState(state);

    printProgress(
      state,
      symbol,
      syncMode === 'INCREMENTAL'
        ? `[incremental] ${symbol} last=${beforeRange.endDate || '-'} start=${effectiveStartDate} end=${targetEndDate}`
        : `[${syncMode.toLowerCase()}] ${symbol} start=${effectiveStartDate} end=${targetEndDate}`
    );

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      printProgress(state, symbol, `${symbol} 分段 ${chunkIndex + 1}/${chunks.length} ${chunk.startDate} → ${chunk.endDate}`);

      const result = await getHongKongDailyBars({
        symbol,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        refresh: true,
        cacheOnly: false,
        networkMode: options.networkMode,
        adjust: 'qfq'
      });

      const chunkBars = Array.isArray(result.bars) ? result.bars.length : 0;
      addedBars += chunkBars;
      lastSource = result.source || lastSource;

      state.items[symbol] = {
        ...state.items[symbol],
        currentChunk: `${chunk.startDate}-${chunk.endDate}`,
        currentChunkIndex: chunkIndex + 1,
        totalChunks: chunks.length,
        syncMode,
        effectiveStartDate,
        targetEndDate,
        addedBars,
        source: lastSource,
        error: ''
      };
      saveState(state);
    }

    const range = await getSymbolDateRange(symbol);
    state.items[symbol] = {
      ...state.items[symbol],
      status: 'DONE',
      finishedAt: nowIso(),
      barCount: range.count || 0,
      startDate: range.startDate || '',
      endDate: range.endDate || '',
      addedBars,
      source: lastSource,
      costMs: Date.now() - itemStart,
      syncMode,
      effectiveStartDate,
      targetEndDate,
      error: ''
    };
    saveState(state);
    printProgress(state, symbol, `${symbol} ${syncMode} DONE，缓存 ${range.count || 0} 条，${range.startDate || ''} → ${range.endDate || ''}。`);
  } catch (error) {
const noDailyBars = isNoDailyBarsError(error);
const message = compactError(error);
const hasExistingCache = Number(beforeRange && beforeRange.count) > 0;

if (noDailyBars && hasExistingCache) {
  state.items[symbol] = {
    ...state.items[symbol],
    status: 'SKIPPED',
    finishedAt: nowIso(),
    barCount: beforeRange.count || 0,
    startDate: beforeRange.startDate || '',
    endDate: beforeRange.endDate || '',
    addedBars: 0,
    source: 'SQLite 本地缓存｜本轮无新增日线',
    costMs: Date.now() - itemStart,
    error: '本轮增量区间无新增日线，不视为无日线'
  };

  saveState(state);
  printProgress(state, symbol, `${symbol} NO_NEW_DATA：本轮增量区间无新增日线，保留本地缓存 ${beforeRange.endDate || ''}。`);
  return;
}

const status = noDailyBars ? 'NO_DAILY_BARS' : 'FAILED';

state.items[symbol] = {
  ...state.items[symbol],
  status,
  finishedAt: nowIso(),
  costMs: Date.now() - itemStart,
  error: noDailyBars ? '无可用历史日线' : message,
  rawError: error && error.stack ? String(error.stack).slice(0, 1000) : ''
};

if (!noDailyBars) {
  state.lastError = message;
}

saveState(state);
printProgress(state, symbol, noDailyBars ? `${symbol} NO_DAILY_BARS：无可用历史日线。` : `${symbol} FAILED：${message}`);
  }
}

function buildOptions(args) {
  const rawEndDate = args.endDate || args.end || args['end-date'] || '';
  const startDate = normalizeDateText(args.start || args.startDate || '20180101', '20180101');
  const endDate = args.end || args.endDate
    ? normalizeDateText(args.end || args.endDate, getTodayDateText())
    : getTodayDateText();

  return {
    symbols: normalizeSymbolList(args.symbols || ''),
    startDate,
    endDate,
    endDateExplicit: Boolean(rawEndDate),
    requestedCalendarEndDate: '',
    resolvedTargetEndDate: '',
    maxCount: toNumber(args.max || args.maxCount || args.limit, 0),
    concurrency: normalizeConcurrency(args.concurrency, DEFAULT_CONCURRENCY),
    force: toBoolean(args.force, false),
    refreshList: toBoolean(args['refresh-list'] || args.refreshList, false),
    networkMode: String(args.networkMode || args.network || 'direct').trim() || 'direct',
    chunkYears: toNumber(args.chunkYears || args['chunk-years'], DEFAULT_CHUNK_YEARS),
    fastDaily: toBoolean(args.fastDaily || args['fast-daily'], true),
    fillMissing: toBoolean(args.fillMissing || args['fill-missing'], false),
    dailyBatchSize: toNumber(args.dailyBatchSize || args['daily-batch-size'], DEFAULT_DAILY_BATCH_SIZE),
    dailyBatchConcurrency: toNumber(args.dailyBatchConcurrency || args['daily-batch-concurrency'], DEFAULT_DAILY_BATCH_CONCURRENCY)
  };
}

async function main() {
  setCacheBackendPreference('disk_sqlite');
  const args = parseArgs(process.argv.slice(2));
  const options = buildOptions(args);

  console.log('[sync-full-hk] start');
  console.log(JSON.stringify({
    ...options,
    universePath: getHongKongStockUniversePath(),
    statePath: HK_SYNC_STATE_PATH
  }, null, 2));

  if (options.refreshList) {
    const universe = await refreshHongKongStockUniverse({ networkMode: options.networkMode });
    console.log(`[sync-full-hk] refreshed universe: ${universe.filteredCount}/${universe.rawCount} ${universe.path}`);
  }

  const stocks = await selectHongKongStocksForSync(options);
  const state = loadState();
  state.running = true;
  state.startedAt = nowIso();
  state.finishedAt = '';
  state.total = stocks.length;
  state.done = 0;
  state.skipped = 0;
  state.failed = 0;
  state.items = {};
  state.lastError = '';
  saveState(state);

  if (stocks.length === 0) {
    state.running = false;
    state.finishedAt = nowIso();
    saveState(state);
    console.log('[sync-full-hk] 没有匹配到港股。需要先加 --refresh-list，或传 --symbols HK:00700。');
    return;
  }

  if (options.fastDaily && !options.force) {
    options.requestedCalendarEndDate = options.endDate;
    options.resolvedTargetEndDate = options.endDate;

    state.requestedCalendarEndDate = options.endDate;
    state.resolvedTargetEndDate = options.endDate;
    state.currentSymbol = '-';
    state.currentStatus = 'FAST_DAILY_TARGET';
    state.lastMessage = `港股快速日更：使用日历目标 ${options.endDate} 拉取最新增量，空结果按本轮无新增处理。`;
    saveState(state);
    printProgress(state, '-', state.lastMessage);

    await runFastDailyIncrementalSync(stocks, options, state);
  } else {
    await resolveHkSyncTargetEndDate(options, state);
    await runWorkerPool(stocks, options.concurrency, async (stock, index, workerId) => {
      await syncOneStock(stock, options, state, index, workerId);
    });
  }

  updateCounters(state);
  state.running = false;
  state.finishedAt = nowIso();
  saveState(state);

  console.log('[sync-full-hk] final');
  console.log(JSON.stringify({
    total: state.total,
    done: state.done,
    skipped: state.skipped,
    noDailyBars: state.noDailyBars || 0,
    failed: state.failed,
    statePath: HK_SYNC_STATE_PATH,
    lastError: state.lastError
  }, null, 2));

  if (state.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[sync-full-hk] failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  buildOptions,
  buildChunks,
  main
};