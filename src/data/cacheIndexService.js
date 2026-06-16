const fs = require('fs');
const path = require('path');
const { withWriteLock } = require('../core/writeLock');
const { runSqliteDiskCacheBridge } = require('../core/sqliteDiskCacheBridge');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SYNC_DIR = path.join(PROJECT_ROOT, 'data', 'sync');
const CACHE_DB_PATH = path.join(PROJECT_ROOT, 'data', 'cache', 'ashare-cache.sqlite');
const CACHE_INDEX_PATH = path.join(SYNC_DIR, 'cache-index.json');
const CACHE_INDEX_VERSION = 'dev-0.1.9.12';
const CACHE_INDEX_RENAME_RETRY_DELAYS = [100, 200, 300, 500, 800, 1200];

let MEMORY_INDEX = null;
let LAST_INDEX_SAVE_ERROR = '';

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableFileError(error) {
  return Boolean(error && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
}

function ensureSyncDir() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
}

function getCacheIndexPath() {
  return CACHE_INDEX_PATH;
}

function getSourceCachePath() {
  return CACHE_DB_PATH;
}

function makeCacheIndexTempPath() {
  const unique = [
    process.pid,
    Date.now(),
    Math.random().toString(36).slice(2, 10)
  ].join('.');

  return `${CACHE_INDEX_PATH}.${unique}.tmp`;
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
    // 临时文件清理失败不影响缓存索引主体结果。
  }
}

async function renameWithRetry(tempPath, targetPath) {
  let lastError = null;

  for (let attempt = 0; attempt <= CACHE_INDEX_RENAME_RETRY_DELAYS.length; attempt += 1) {
    try {
      fs.renameSync(tempPath, targetPath);
      return {
        ok: true,
        fallback: false
      };
    } catch (error) {
      lastError = error;

      if (!isRetryableFileError(error) || attempt >= CACHE_INDEX_RENAME_RETRY_DELAYS.length) {
        break;
      }

      await sleep(CACHE_INDEX_RENAME_RETRY_DELAYS[attempt]);
    }
  }

  try {
    fs.copyFileSync(tempPath, targetPath);
    removeFileQuietly(tempPath);
    return {
      ok: true,
      fallback: true,
      renameError: lastError ? compactErrorMessage(lastError) : ''
    };
  } catch (fallbackError) {
    return {
      ok: false,
      error: fallbackError,
      renameError: lastError
    };
  }
}

function normalizeSymbol(symbol) {
  const text = String(symbol || '').trim().toUpperCase();

  if (/^\d{6}$/.test(text)) {
    return text;
  }

  if (/^HK:\d{5}$/.test(text)) {
    return text;
  }

  return '';
}

function normalizeDateText(value) {
  const text = String(value || '').trim();

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  return '';
}

function normalizeSummary(symbol, summary = {}) {
  const cleanSymbol = normalizeSymbol(summary.symbol || symbol);

  if (!cleanSymbol) {
    return null;
  }

  const barCount = Number(summary.barCount !== undefined ? summary.barCount : summary.count) || 0;
  const startDate = normalizeDateText(summary.startDate || summary.start_date);
  const endDate = normalizeDateText(summary.endDate || summary.end_date);

  if (barCount <= 0 || !startDate || !endDate) {
    return null;
  }

  return {
    symbol: cleanSymbol,
    barCount,
    startDate,
    endDate,
    lastIndexedAt: summary.lastIndexedAt || nowIso()
  };
}

function createEmptyCacheIndex(overrides = {}) {
  return {
    version: CACHE_INDEX_VERSION,
    generatedAt: overrides.generatedAt || '',
    sourceCachePath: overrides.sourceCachePath || CACHE_DB_PATH,
    lastIndexSaveError: Object.prototype.hasOwnProperty.call(overrides, 'lastIndexSaveError')
      ? String(overrides.lastIndexSaveError || '')
      : LAST_INDEX_SAVE_ERROR || '',
    items: {}
  };
}

function normalizeCacheIndex(rawIndex) {
  const base = createEmptyCacheIndex(rawIndex && typeof rawIndex === 'object' ? rawIndex : {});
  const rawItems = rawIndex && rawIndex.items && typeof rawIndex.items === 'object'
    ? rawIndex.items
    : {};

  for (const [symbol, summary] of Object.entries(rawItems)) {
    const normalized = normalizeSummary(symbol, summary);

    if (normalized) {
      base.items[normalized.symbol] = normalized;
    }
  }

  return base;
}

function cacheIndexExists() {
  return fs.existsSync(CACHE_INDEX_PATH);
}

function loadCacheIndex(options = {}) {
  if (MEMORY_INDEX && !options.reload) {
    return MEMORY_INDEX;
  }

  if (!cacheIndexExists()) {
    MEMORY_INDEX = createEmptyCacheIndex();
    return MEMORY_INDEX;
  }

  try {
    MEMORY_INDEX = normalizeCacheIndex(JSON.parse(fs.readFileSync(CACHE_INDEX_PATH, 'utf8')));
  } catch (error) {
    LAST_INDEX_SAVE_ERROR = `缓存索引读取失败：${compactErrorMessage(error)}`;
    MEMORY_INDEX = createEmptyCacheIndex({
      lastIndexSaveError: LAST_INDEX_SAVE_ERROR
    });
  }

  return MEMORY_INDEX;
}

async function saveCacheIndex(cacheIndex) {
  return withWriteLock(async () => {
    const payload = normalizeCacheIndex({
      ...(cacheIndex || {}),
      version: CACHE_INDEX_VERSION,
      sourceCachePath: CACHE_DB_PATH,
      lastIndexSaveError: ''
    });
    let tempPath = '';

    try {
      ensureSyncDir();
      tempPath = makeCacheIndexTempPath();
      fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');

      const result = await renameWithRetry(tempPath, CACHE_INDEX_PATH);

      if (!result.ok) {
        const renameMessage = result.renameError ? `rename: ${compactErrorMessage(result.renameError)}` : '';
        const fallbackMessage = result.error ? `fallback: ${compactErrorMessage(result.error)}` : '';
        LAST_INDEX_SAVE_ERROR = [renameMessage, fallbackMessage].filter(Boolean).join('；') || '缓存索引保存失败。';
        payload.lastIndexSaveError = LAST_INDEX_SAVE_ERROR;
        MEMORY_INDEX = payload;

        return {
          ok: false,
          error: LAST_INDEX_SAVE_ERROR,
          cacheIndexPath: CACHE_INDEX_PATH
        };
      }

      LAST_INDEX_SAVE_ERROR = '';
      MEMORY_INDEX = payload;
      removeFileQuietly(tempPath);

      return {
        ok: true,
        fallback: result.fallback,
        cacheIndexPath: CACHE_INDEX_PATH
      };
    } catch (error) {
      LAST_INDEX_SAVE_ERROR = compactErrorMessage(error);
      payload.lastIndexSaveError = LAST_INDEX_SAVE_ERROR;
      MEMORY_INDEX = payload;

      return {
        ok: false,
        error: LAST_INDEX_SAVE_ERROR,
        cacheIndexPath: CACHE_INDEX_PATH
      };
    } finally {
      removeFileQuietly(tempPath);
    }
  });
}

function getCachedSymbolSummary(symbol, cacheIndex) {
  const cleanSymbol = normalizeSymbol(symbol);

  if (!cleanSymbol) {
    return null;
  }

  const index = cacheIndex || loadCacheIndex();
  const summary = index && index.items ? index.items[cleanSymbol] : null;
  return normalizeSummary(cleanSymbol, summary);
}

async function updateCachedSymbolSummary(symbol, summary) {
  const normalized = normalizeSummary(symbol, summary);

  if (!normalized) {
    return {
      ok: false,
      skipped: true,
      error: '缓存索引摘要为空或无效。',
      cacheIndexPath: CACHE_INDEX_PATH
    };
  }

  const index = loadCacheIndex();
  index.version = CACHE_INDEX_VERSION;
  index.sourceCachePath = CACHE_DB_PATH;
  index.generatedAt = index.generatedAt || nowIso();
  index.items[normalized.symbol] = {
    ...normalized,
    lastIndexedAt: nowIso()
  };

  return saveCacheIndex(index);
}

function getFileSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString()
  };
}

function assertSnapshotUnchanged(before, after, label) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`${label} 文件大小或修改时间发生变化，已中止。`);
  }
}

async function buildCacheIndexFromSqlite(options = {}) {
  const sqliteBefore = getFileSnapshot(CACHE_DB_PATH);

  if (!sqliteBefore) {
    throw new Error(`SQLite 缓存不存在：${CACHE_DB_PATH}`);
  }

  const items = {};
  const bridgeResult = await runSqliteDiskCacheBridge('build-index-summary');
  const rawItems = bridgeResult && bridgeResult.items && typeof bridgeResult.items === 'object'
    ? bridgeResult.items
    : {};
  let indexedSymbols = 0;
  let totalBars = 0;

  for (const [symbol, rawSummary] of Object.entries(rawItems)) {
    const summary = normalizeSummary(symbol, rawSummary);

    if (!summary) {
      continue;
    }

    items[summary.symbol] = summary;
    indexedSymbols += 1;
    totalBars += summary.barCount;
  }

  const sqliteAfter = getFileSnapshot(CACHE_DB_PATH);
  assertSnapshotUnchanged(sqliteBefore, sqliteAfter, 'SQLite 缓存');

  const index = normalizeCacheIndex({
    version: CACHE_INDEX_VERSION,
    generatedAt: nowIso(),
    sourceCachePath: CACHE_DB_PATH,
    items
  });
  const saveResult = options.save === false
    ? {
      ok: true,
      skipped: true,
      cacheIndexPath: CACHE_INDEX_PATH
    }
    : await saveCacheIndex(index);

  return {
    index,
    indexedSymbols,
    totalBars,
    cacheIndexPath: CACHE_INDEX_PATH,
    sqliteModified: false,
    sqliteBefore,
    sqliteAfter,
    saveResult
  };
}

function getLastIndexSaveError() {
  return LAST_INDEX_SAVE_ERROR;
}

module.exports = {
  CACHE_INDEX_VERSION,
  getCacheIndexPath,
  getSourceCachePath,
  cacheIndexExists,
  loadCacheIndex,
  saveCacheIndex,
  getCachedSymbolSummary,
  updateCachedSymbolSummary,
  buildCacheIndexFromSqlite,
  getFileSnapshot,
  getLastIndexSaveError,
  normalizeSummary
};
