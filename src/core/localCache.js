const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { withWriteLock } = require('./writeLock');
const { runSqliteDiskCacheBridge } = require('./sqliteDiskCacheBridge');
const { updateCachedSymbolSummary } = require('../data/cacheIndexService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(PROJECT_ROOT, 'data', 'cache');
const CACHE_DB_PATH = path.join(CACHE_DIR, 'ashare-cache.sqlite');
const CACHE_BACKEND_SQLJS = 'sqljs';
const CACHE_BACKEND_DISK = 'disk_sqlite';
const SQLJS_EXPORT_SIZE_LIMIT_BYTES = 512 * 1024 * 1024;

let SQL_INSTANCE = null;
let DB_INSTANCE = null;
let DB_DIRTY = false;
let DEFER_SAVE_DEPTH = 0;
let CACHE_BACKEND_PREFERENCE = '';

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function normalizeCacheBackend(value) {
  const text = String(value || '').trim().toLowerCase();

  if (['disk', 'disk_sqlite', 'sqlite', 'sqlite3'].includes(text)) {
    return CACHE_BACKEND_DISK;
  }

  if (['sqljs', 'sql.js'].includes(text)) {
    return CACHE_BACKEND_SQLJS;
  }

  return '';
}

function getCacheFileSize() {
  try {
    return fs.existsSync(CACHE_DB_PATH) ? fs.statSync(CACHE_DB_PATH).size : 0;
  } catch (_error) {
    return 0;
  }
}

function setCacheBackendPreference(value) {
  CACHE_BACKEND_PREFERENCE = normalizeCacheBackend(value);
  return getCacheBackend();
}

function getCacheBackend() {
  const envBackend = normalizeCacheBackend(process.env.XWB_CACHE_BACKEND);

  if (envBackend) {
    return envBackend;
  }

  if (CACHE_BACKEND_PREFERENCE) {
    return CACHE_BACKEND_PREFERENCE;
  }

  if (getCacheFileSize() > SQLJS_EXPORT_SIZE_LIMIT_BYTES) {
    return CACHE_BACKEND_DISK;
  }

  return CACHE_BACKEND_SQLJS;
}

function getCacheBackendInfo() {
  return {
    backend: getCacheBackend(),
    cachePath: CACHE_DB_PATH,
    cacheSizeBytes: getCacheFileSize(),
    sqljsExportLimitBytes: SQLJS_EXPORT_SIZE_LIMIT_BYTES
  };
}

function isDiskCacheBackend() {
  return getCacheBackend() === CACHE_BACKEND_DISK;
}

function createCacheWriteMemoryError(error) {
  const detail = error && error.message ? error.message : String(error || '');
  const message = detail.includes('Array buffer allocation failed')
    ? '缓存写盘内存不足，已停止同步，请切换 disk_sqlite 后端或降低并发后继续。'
    : detail || '缓存写盘失败。';
  const wrapped = new Error(message);
  wrapped.cacheWriteError = true;
  wrapped.rawError = error && error.stack ? error.stack : detail;
  wrapped.lastTransportError = detail || message;
  wrapped.cacheBackend = getCacheBackend();
  return wrapped;
}

function createSqljsExportBlockedError() {
  const error = new Error('缓存写盘内存不足，已停止同步，请切换 disk_sqlite 后端或降低并发后继续。');
  error.cacheWriteError = true;
  error.rawError = `sql.js export blocked for large cache: ${CACHE_DB_PATH}, size=${getCacheFileSize()}`;
  error.lastTransportError = 'Array buffer allocation failed';
  error.cacheBackend = getCacheBackend();
  return error;
}

function isCacheWriteMemoryError(error) {
  const text = [
    error && error.message,
    error && error.rawError,
    error && error.lastTransportError
  ].filter(Boolean).join('\n');

  return Boolean(
    error && error.cacheWriteError
    || /Array buffer allocation failed/i.test(text)
    || /缓存写盘内存不足/.test(text)
  );
}

async function getSqlInstance() {
  if (SQL_INSTANCE) {
    return SQL_INSTANCE;
  }

  SQL_INSTANCE = await initSqlJs({
    locateFile: (file) => path.join(PROJECT_ROOT, 'node_modules', 'sql.js', 'dist', file)
  });

  return SQL_INSTANCE;
}

async function getDb() {
  if (DB_INSTANCE) {
    return DB_INSTANCE;
  }

  ensureCacheDir();

  const SQL = await getSqlInstance();

  const cacheExists = fs.existsSync(CACHE_DB_PATH);

  if (cacheExists) {
    const fileBuffer = fs.readFileSync(CACHE_DB_PATH);
    DB_INSTANCE = new SQL.Database(fileBuffer);
  } else {
    DB_INSTANCE = new SQL.Database();
  }

  ensureSchema(DB_INSTANCE);

  if (!cacheExists) {
    saveDb({ force: true });
  }

  return DB_INSTANCE;
}

function ensureSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_bars (
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      close REAL,
      high REAL,
      low REAL,
      volume REAL,
      amount REAL,
      amplitude REAL,
      pct_change REAL,
      change_amount REAL,
      turnover REAL,
      PRIMARY KEY (symbol, trade_date)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS index_daily_bars (
      index_code TEXT NOT NULL,
      index_name TEXT NOT NULL,
      market TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      amount REAL,
      amplitude REAL,
      pct_change REAL,
      change_amount REAL,
      turnover REAL,
      source TEXT,
      updated_at TEXT,
      PRIMARY KEY (index_code, trade_date)
    );
  `);
}

function saveDb(options = {}) {
  if (isDiskCacheBackend()) {
    DB_DIRTY = false;

    return {
      saved: false,
      dirty: false,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_DISK,
      noOp: true
    };
  }

  if (!DB_INSTANCE) {
    return {
      saved: false,
      dirty: DB_DIRTY,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_SQLJS
    };
  }

  if (!DB_DIRTY && !options.force) {
    return {
      saved: false,
      dirty: false,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_SQLJS
    };
  }

  if (getCacheFileSize() > SQLJS_EXPORT_SIZE_LIMIT_BYTES) {
    throw createSqljsExportBlockedError();
  }

  ensureCacheDir();

  try {
    const exported = DB_INSTANCE.export();
    fs.writeFileSync(CACHE_DB_PATH, Buffer.from(exported));
  } catch (error) {
    throw createCacheWriteMemoryError(error);
  }

  DB_DIRTY = false;

  return {
    saved: true,
    dirty: false,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_SQLJS
  };
}

function markDbDirty() {
  if (isDiskCacheBackend()) {
    DB_DIRTY = false;

    return {
      saved: false,
      dirty: false,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_DISK,
      noOp: true
    };
  }

  DB_DIRTY = true;

  if (DEFER_SAVE_DEPTH > 0) {
    return {
      saved: false,
      dirty: true,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_SQLJS
    };
  }

  return saveDb();
}

function beginDeferredCacheSave() {
  DEFER_SAVE_DEPTH += 1;

  return {
    deferred: true,
    depth: DEFER_SAVE_DEPTH,
    dirty: DB_DIRTY,
    cachePath: CACHE_DB_PATH,
    backend: getCacheBackend()
  };
}

function endDeferredCacheSave(options = {}) {
  const flush = options.flush !== false;

  if (flush) {
    return withWriteLock(() => endDeferredCacheSaveUnlocked(true));
  }

  return endDeferredCacheSaveUnlocked(false);
}

function endDeferredCacheSaveUnlocked(flush) {
  if (DEFER_SAVE_DEPTH > 0) {
    DEFER_SAVE_DEPTH -= 1;
  }

  if (flush && DEFER_SAVE_DEPTH === 0) {
    const result = saveDb();

    return {
      ...result,
      deferred: false,
      depth: DEFER_SAVE_DEPTH
    };
  }

  return {
    saved: false,
    deferred: DEFER_SAVE_DEPTH > 0,
    depth: DEFER_SAVE_DEPTH,
    dirty: DB_DIRTY,
    cachePath: CACHE_DB_PATH,
    backend: getCacheBackend()
  };
}

function flushCacheToDisk() {
  return withWriteLock(() => saveDb());
}

function getCacheSaveState() {
  return {
    dirty: DB_DIRTY,
    deferred: DEFER_SAVE_DEPTH > 0,
    depth: DEFER_SAVE_DEPTH,
    cachePath: CACHE_DB_PATH,
    backend: getCacheBackend(),
    cacheSizeBytes: getCacheFileSize()
  };
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

function normalizeCacheSymbol(value) {
  const text = String(value || '').trim().toUpperCase();

  if (/^\d{6}$/.test(text)) {
    return text;
  }

  if (/^HK:\d{5}$/.test(text)) {
    return text;
  }

  throw new Error(`非法缓存股票代码：${value}`);
}

function normalizeIndexCode(value) {
  const text = String(value || '').trim().toUpperCase();

  if (!text) {
    throw new Error('非法指数代码：空');
  }

  if (!text.includes(':')) {
    throw new Error(`非法指数代码：${value}`);
  }

  const [prefix, code] = text.split(':');

  if (!prefix || !code) {
    throw new Error(`非法指数代码：${value}`);
  }

  if (!/^[A-Z0-9_]+$/.test(prefix)) {
    throw new Error(`非法指数代码：${value}`);
  }

  if (!/^[A-Z0-9._-]+$/.test(code)) {
    throw new Error(`非法指数代码：${value}`);
  }

  return `${prefix}:${code}`;
}

function normalizeDate(value) {
  if (!value) {
    return '';
  }

  const raw = String(value).trim();

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  return raw.slice(0, 10);
}

async function upsertDailyBars(symbol, bars) {
  const cleanSymbol = normalizeCacheSymbol(symbol);

  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      inserted: 0,
      cachePath: CACHE_DB_PATH,
      backend: getCacheBackend()
    };
  }

  return withWriteLock(() => {
    return isDiskCacheBackend()
      ? upsertDailyBarsDisk(cleanSymbol, bars)
      : upsertDailyBarsSqljsUnlocked(cleanSymbol, bars);
  });
}

async function upsertDailyBarsDisk(cleanSymbol, bars) {
  const bridgeResult = await runSqliteDiskCacheBridge('upsert-symbol-bars', {
    payload: {
      symbol: cleanSymbol,
      bars
    }
  });
  const summary = bridgeResult && bridgeResult.summary ? bridgeResult.summary : {};
  let cacheIndexUpdate = null;

  try {
    cacheIndexUpdate = await updateCachedSymbolSummary(cleanSymbol, {
      barCount: summary.barCount,
      startDate: summary.startDate,
      endDate: summary.endDate
    });
  } catch (indexError) {
    cacheIndexUpdate = {
      ok: false,
      error: indexError && indexError.message ? indexError.message : String(indexError || ''),
      cacheIndexPath: ''
    };
  }

  return {
    inserted: Number(bridgeResult && bridgeResult.inserted) || 0,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_DISK,
    cacheIndexUpdate
  };
}

async function upsertDailyBarsSqljsUnlocked(cleanSymbol, bars) {
  const db = await getDb();
  let transactionActive = false;
  let stmt = null;
  let inserted = 0;
  let originalError = null;
  let cacheIndexUpdate = null;

  try {
    db.run('BEGIN TRANSACTION;');
    transactionActive = true;

    stmt = db.prepare(`
      INSERT INTO daily_bars (
        symbol,
        trade_date,
        open,
        close,
        high,
        low,
        volume,
        amount,
        amplitude,
        pct_change,
        change_amount,
        turnover
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, trade_date) DO UPDATE SET
        open = excluded.open,
        close = excluded.close,
        high = excluded.high,
        low = excluded.low,
        volume = excluded.volume,
        amount = COALESCE(excluded.amount, daily_bars.amount),
        amplitude = COALESCE(excluded.amplitude, daily_bars.amplitude),
        pct_change = COALESCE(excluded.pct_change, daily_bars.pct_change),
        change_amount = COALESCE(excluded.change_amount, daily_bars.change_amount),
        turnover = COALESCE(excluded.turnover, daily_bars.turnover);
    `);

    for (const bar of bars) {
      const tradeDate = normalizeDate(bar.date);
      if (!tradeDate) {
        continue;
      }

      stmt.run([
        cleanSymbol,
        tradeDate,
        normalizeNumber(bar.open),
        normalizeNumber(bar.close),
        normalizeNumber(bar.high),
        normalizeNumber(bar.low),
        normalizeNumber(bar.volume),
        normalizeNumber(bar.amount),
        normalizeNumber(bar.amplitude),
        normalizeNumber(bar.pctChange),
        normalizeNumber(bar.changeAmount),
        normalizeNumber(bar.turnover)
      ]);

      inserted += 1;
    }

    if (stmt) {
      stmt.free();
      stmt = null;
    }

    db.run('COMMIT;');
    transactionActive = false;
    markDbDirty();
  } catch (error) {
    originalError = error;

    if (stmt) {
      try {
        stmt.free();
      } catch (freeError) {
        originalError.statementFreeError = freeError && freeError.message
          ? freeError.message
          : String(freeError || '');
      } finally {
        stmt = null;
      }
    }

    if (transactionActive) {
      try {
        db.run('ROLLBACK;');
        transactionActive = false;
      } catch (rollbackError) {
        originalError.rollbackError = rollbackError && rollbackError.message
          ? rollbackError.message
          : String(rollbackError || '');
      }
    }

    throw originalError;
  }

  try {
    const summary = querySymbolDateRange(db, cleanSymbol);
    cacheIndexUpdate = await updateCachedSymbolSummary(cleanSymbol, {
      barCount: summary.count,
      startDate: summary.startDate,
      endDate: summary.endDate
    });
  } catch (indexError) {
    cacheIndexUpdate = {
      ok: false,
      error: indexError && indexError.message ? indexError.message : String(indexError || ''),
      cacheIndexPath: ''
    };
  }

  return {
    inserted,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_SQLJS,
    cacheIndexUpdate
  };
}

async function getDailyBars(symbol, startDate, endDate) {
  const cleanSymbol = normalizeCacheSymbol(symbol);

  if (isDiskCacheBackend()) {
    const result = await runSqliteDiskCacheBridge('read-symbol-bars', {
      args: {
        symbol: cleanSymbol,
        startDate,
        endDate
      }
    });

    return (Array.isArray(result.bars) ? result.bars : []).map((row) => ({
      symbol: row.symbol,
      date: row.date,
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
      volume: toOptionalNumber(row.volume),
      amount: toOptionalNumber(row.amount),
      amplitude: toOptionalNumber(row.amplitude),
      pctChange: toOptionalNumber(row.pctChange),
      changeAmount: toOptionalNumber(row.changeAmount),
      turnover: toOptionalNumber(row.turnover)
    }));
  }

  const db = await getDb();

  const stmt = db.prepare(`
    SELECT
      symbol,
      trade_date,
      open,
      close,
      high,
      low,
      volume,
      amount,
      amplitude,
      pct_change,
      change_amount,
      turnover
    FROM daily_bars
    WHERE symbol = ?
    ORDER BY trade_date ASC;
  `);

  stmt.bind([cleanSymbol]);

  const rows = [];

  while (stmt.step()) {
    const row = stmt.getAsObject();

    rows.push({
      symbol: row.symbol,
      date: row.trade_date,
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),

      // 这些字段数据库允许 NULL，不能用 Number(NULL)，否则会变成 0。
      volume: toOptionalNumber(row.volume),
      amount: toOptionalNumber(row.amount),
      amplitude: toOptionalNumber(row.amplitude),
      pctChange: toOptionalNumber(row.pct_change),
      changeAmount: toOptionalNumber(row.change_amount),
      turnover: toOptionalNumber(row.turnover)
    });
  }

  stmt.free();

  const startIso = startDate ? normalizeDate(startDate) : '';
  const endIso = endDate ? normalizeDate(endDate) : '';

  return rows.filter((row) => {
    if (startIso && row.date < startIso) return false;
    if (endIso && row.date > endIso) return false;
    return true;
  });
}

function normalizeBatchSymbols(symbols) {
  const rawList = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(/[,，\s]+/);

  const seen = new Set();
  const result = [];

  for (const item of rawList) {
    if (!item) {
      continue;
    }

    const cleanSymbol = normalizeCacheSymbol(item);

    if (seen.has(cleanSymbol)) {
      continue;
    }

    seen.add(cleanSymbol);
    result.push(cleanSymbol);
  }

  return result;
}

async function getDailyBarsBySymbols(symbols, startDate, endDate) {
  const cleanSymbols = normalizeBatchSymbols(symbols);

  if (!cleanSymbols.length) {
    return {
      symbols: [],
      symbolCount: 0,
      rowCount: 0,
      barsBySymbol: {},
      cachePath: CACHE_DB_PATH,
      backend: getCacheBackend()
    };
  }

  if (isDiskCacheBackend()) {
    const result = await runSqliteDiskCacheBridge('read-symbols-bars', {
      payload: {
        symbols: cleanSymbols,
        startDate,
        endDate
      }
    });

    const rawBarsBySymbol = result && result.barsBySymbol && typeof result.barsBySymbol === 'object'
      ? result.barsBySymbol
      : {};
    const barsBySymbol = {};

    for (const symbol of cleanSymbols) {
      const rows = Array.isArray(rawBarsBySymbol[symbol]) ? rawBarsBySymbol[symbol] : [];

      barsBySymbol[symbol] = rows.map((row) => ({
        symbol: row.symbol,
        date: row.date,
        open: Number(row.open),
        close: Number(row.close),
        high: Number(row.high),
        low: Number(row.low),
        volume: toOptionalNumber(row.volume),
        amount: toOptionalNumber(row.amount),
        amplitude: toOptionalNumber(row.amplitude),
        pctChange: toOptionalNumber(row.pctChange),
        changeAmount: toOptionalNumber(row.changeAmount),
        turnover: toOptionalNumber(row.turnover)
      }));
    }

    return {
      symbols: cleanSymbols,
      symbolCount: cleanSymbols.length,
      rowCount: Number(result && result.rowCount) || 0,
      startDate: result && result.startDate || '',
      endDate: result && result.endDate || '',
      barsBySymbol,
      cachePath: CACHE_DB_PATH,
      backend: CACHE_BACKEND_DISK
    };
  }

  const barsBySymbol = {};
  let rowCount = 0;

  for (const symbol of cleanSymbols) {
    const bars = await getDailyBars(symbol, startDate, endDate);
    barsBySymbol[symbol] = bars;
    rowCount += Array.isArray(bars) ? bars.length : 0;
  }

  return {
    symbols: cleanSymbols,
    symbolCount: cleanSymbols.length,
    rowCount,
    barsBySymbol,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_SQLJS
  };
}

async function getDailyBarCount(symbol) {
  const cleanSymbol = normalizeCacheSymbol(symbol);

  if (isDiskCacheBackend()) {
    const summary = await getSymbolDateRange(cleanSymbol);
    return Number(summary.count) || 0;
  }

  const db = await getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM daily_bars
    WHERE symbol = ?;
  `);

  stmt.bind([cleanSymbol]);

  let count = 0;

  if (stmt.step()) {
    const row = stmt.getAsObject();
    count = Number(row.count) || 0;
  }

  stmt.free();

  return count;
}

function querySymbolDateRange(db, cleanSymbol) {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS count,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date
    FROM daily_bars
    WHERE symbol = ?;
  `);

  stmt.bind([cleanSymbol]);

  const range = {
    symbol: cleanSymbol,
    count: 0,
    startDate: '',
    endDate: ''
  };

  try {
    if (stmt.step()) {
      const row = stmt.getAsObject();
      range.count = Number(row.count) || 0;
      range.startDate = row.start_date || '';
      range.endDate = row.end_date || '';
    }
  } finally {
    stmt.free();
  }

  return range;
}

async function getSymbolDateRange(symbol) {
  const cleanSymbol = normalizeCacheSymbol(symbol);

  if (isDiskCacheBackend()) {
    const summary = await runSqliteDiskCacheBridge('symbol-summary', {
      args: {
        symbol: cleanSymbol
      }
    });

    return {
      symbol: cleanSymbol,
      count: Number(summary.barCount) || 0,
      startDate: summary.startDate || '',
      endDate: summary.endDate || '',
      backend: CACHE_BACKEND_DISK
    };
  }

  const db = await getDb();
  return querySymbolDateRange(db, cleanSymbol);
}

async function upsertIndexDailyBars(indexInfo, bars) {
  const info = indexInfo && typeof indexInfo === 'object' ? indexInfo : {};
  const cleanIndexCode = normalizeIndexCode(info.indexCode || info.code);
  const indexName = String(info.indexName || info.name || cleanIndexCode);
  const market = String(info.market || 'CN_INDEX');

  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      inserted: 0,
      cachePath: CACHE_DB_PATH,
      backend: getCacheBackend()
    };
  }

  return withWriteLock(() => {
    return isDiskCacheBackend()
      ? upsertIndexDailyBarsDisk({ indexCode: cleanIndexCode, indexName, market }, bars)
      : upsertIndexDailyBarsSqljsUnlocked({ indexCode: cleanIndexCode, indexName, market }, bars);
  });
}

async function upsertIndexDailyBarsDisk(indexInfo, bars) {
  const bridgeResult = await runSqliteDiskCacheBridge('upsert-index-bars', {
    payload: {
      indexCode: indexInfo.indexCode,
      indexName: indexInfo.indexName,
      market: indexInfo.market,
      bars
    }
  });

  return {
    inserted: Number(bridgeResult && bridgeResult.inserted) || 0,
    summary: bridgeResult && bridgeResult.summary ? bridgeResult.summary : null,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_DISK
  };
}

async function upsertIndexDailyBarsSqljsUnlocked(indexInfo, bars) {
  const db = await getDb();
  let transactionActive = false;
  let stmt = null;
  let inserted = 0;
  let originalError = null;

  try {
    db.run('BEGIN TRANSACTION;');
    transactionActive = true;

    stmt = db.prepare(`
      INSERT INTO index_daily_bars (
        index_code,
        index_name,
        market,
        trade_date,
        open,
        high,
        low,
        close,
        volume,
        amount,
        amplitude,
        pct_change,
        change_amount,
        turnover,
        source,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(index_code, trade_date) DO UPDATE SET
        index_name = excluded.index_name,
        market = excluded.market,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = COALESCE(excluded.volume, index_daily_bars.volume),
        amount = COALESCE(excluded.amount, index_daily_bars.amount),
        amplitude = COALESCE(excluded.amplitude, index_daily_bars.amplitude),
        pct_change = COALESCE(excluded.pct_change, index_daily_bars.pct_change),
        change_amount = COALESCE(excluded.change_amount, index_daily_bars.change_amount),
        turnover = COALESCE(excluded.turnover, index_daily_bars.turnover),
        source = COALESCE(NULLIF(excluded.source, ''), index_daily_bars.source),
        updated_at = COALESCE(NULLIF(excluded.updated_at, ''), index_daily_bars.updated_at);
    `);

    for (const bar of bars) {
      const tradeDate = normalizeDate(bar.date);
      if (!tradeDate) {
        continue;
      }

      stmt.run([
        indexInfo.indexCode,
        indexInfo.indexName,
        indexInfo.market,
        tradeDate,
        normalizeNumber(bar.open),
        normalizeNumber(bar.high),
        normalizeNumber(bar.low),
        normalizeNumber(bar.close),
        normalizeNumber(bar.volume),
        normalizeNumber(bar.amount),
        normalizeNumber(bar.amplitude),
        normalizeNumber(bar.pctChange),
        normalizeNumber(bar.changeAmount),
        normalizeNumber(bar.turnover),
        String(bar.source || ''),
        String(bar.updatedAt || '')
      ]);

      inserted += 1;
    }

    if (stmt) {
      stmt.free();
      stmt = null;
    }

    db.run('COMMIT;');
    transactionActive = false;
    markDbDirty();
  } catch (error) {
    originalError = error;

    if (stmt) {
      try {
        stmt.free();
      } catch (freeError) {
        originalError.statementFreeError = freeError && freeError.message
          ? freeError.message
          : String(freeError || '');
      } finally {
        stmt = null;
      }
    }

    if (transactionActive) {
      try {
        db.run('ROLLBACK;');
        transactionActive = false;
      } catch (rollbackError) {
        originalError.rollbackError = rollbackError && rollbackError.message
          ? rollbackError.message
          : String(rollbackError || '');
      }
    }

    throw originalError;
  }

  return {
    inserted,
    cachePath: CACHE_DB_PATH,
    backend: CACHE_BACKEND_SQLJS
  };
}

async function getIndexDailyBars(indexCode, options = {}) {
  const cleanIndexCode = normalizeIndexCode(indexCode);
  const startDate = normalizeDate(options.startDate || '');
  const endDate = normalizeDate(options.endDate || '');

  if (isDiskCacheBackend()) {
    const bridgeResult = await runSqliteDiskCacheBridge('read-index-bars', {
      args: {
        indexCode: cleanIndexCode,
        startDate,
        endDate
      }
    });

    return Array.isArray(bridgeResult && bridgeResult.bars) ? bridgeResult.bars : [];
  }

  const db = await getDb();
  const params = [cleanIndexCode];
  const filters = ['index_code = ?'];

  if (startDate) {
    filters.push('trade_date >= ?');
    params.push(startDate);
  }

  if (endDate) {
    filters.push('trade_date <= ?');
    params.push(endDate);
  }

  const stmt = db.prepare(`
    SELECT
      index_code,
      index_name,
      market,
      trade_date,
      open,
      high,
      low,
      close,
      volume,
      amount,
      amplitude,
      pct_change,
      change_amount,
      turnover,
      source,
      updated_at
    FROM index_daily_bars
    WHERE ${filters.join(' AND ')}
    ORDER BY trade_date ASC;
  `);

  stmt.bind(params);
  const rows = [];

  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        indexCode: row.index_code,
        indexName: row.index_name,
        market: row.market,
        date: row.trade_date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        amount: row.amount,
        amplitude: row.amplitude,
        pctChange: row.pct_change,
        changeAmount: row.change_amount,
        turnover: row.turnover,
        source: row.source,
        updatedAt: row.updated_at
      });
    }
  } finally {
    stmt.free();
  }

  return rows;
}

function queryIndexDateRange(db, cleanIndexCode) {
  const stmt = db.prepare(`
    SELECT
      index_code,
      MAX(index_name) AS index_name,
      MAX(market) AS market,
      COUNT(*) AS count,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date,
      MAX(source) AS source
    FROM index_daily_bars
    WHERE index_code = ?
    GROUP BY index_code;
  `);

  stmt.bind([cleanIndexCode]);

  const range = {
    indexCode: cleanIndexCode,
    indexName: '',
    market: '',
    count: 0,
    startDate: '',
    endDate: '',
    source: ''
  };

  try {
    if (stmt.step()) {
      const row = stmt.getAsObject();
      range.indexName = row.index_name || '';
      range.market = row.market || '';
      range.count = Number(row.count) || 0;
      range.startDate = row.start_date || '';
      range.endDate = row.end_date || '';
      range.source = row.source || '';
    }
  } finally {
    stmt.free();
  }

  return range;
}

async function getIndexDateRange(indexCode) {
  const cleanIndexCode = normalizeIndexCode(indexCode);

  if (isDiskCacheBackend()) {
    const summary = await runSqliteDiskCacheBridge('index-summary', {
      args: {
        indexCode: cleanIndexCode
      }
    });

    return {
      indexCode: cleanIndexCode,
      indexName: summary.indexName || '',
      market: summary.market || '',
      count: Number(summary.barCount) || 0,
      startDate: summary.startDate || '',
      endDate: summary.endDate || '',
      source: summary.source || '',
      backend: CACHE_BACKEND_DISK
    };
  }

  const db = await getDb();
  return queryIndexDateRange(db, cleanIndexCode);
}

function getCachePath() {
  return CACHE_DB_PATH;
}

module.exports = {
  upsertDailyBars,
  getDailyBars,
  getDailyBarsBySymbols,
  getDailyBarCount,
  getSymbolDateRange,
  getCachePath,
  getCacheBackend,
  getCacheBackendInfo,
  setCacheBackendPreference,
  isCacheWriteMemoryError,
  beginDeferredCacheSave,
  endDeferredCacheSave,
  flushCacheToDisk,
  upsertIndexDailyBars,
  getIndexDailyBars,
  getIndexDateRange,
  getCacheSaveState
};
