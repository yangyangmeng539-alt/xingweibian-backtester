const path = require('path');
const { spawn } = require('child_process');
const { getPythonChildEnv } = require('../workers/pythonWorker');
const {
  upsertIndexDailyBars,
  getIndexDailyBars,
  getIndexDateRange,
  getCachePath,
  getCacheBackend
} = require('../core/localCache');
const {
  listMarketIndexes,
  getMarketIndex,
  normalizeIndexCode
} = require('./marketIndexRegistry');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const INDEX_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'marketIndexDailyAdapter.py');
const DEFAULT_INDEX_START_DATE = '20180101';
const DEFAULT_INDEX_SYNC_TIMEOUT_MS = 120000;
const MARKET_INDEX_CHART_CODES = Object.freeze([
  'SH:000001',
  'SZ:399001',
  'SZ:399006',
  'SH:000688',
  'BJ:899050',
  'CSI:000300',
  'CSI:000905',
  'CSI:000852',
  'CSI:932000',
  'CSI:000985',
  'HK:HSI',
  'HK:HSTECH',
  'HK:HSCEI'
]);

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text.slice(0, 10);
}

function dateToNumberText(value) {
  return normalizeDate(value).replace(/-/g, '');
}

function maxStartDate(globalStartDate, indexStartDate) {
  const globalText = dateToNumberText(globalStartDate);
  const indexText = dateToNumberText(indexStartDate);

  if (!globalText) return normalizeDate(indexText);
  if (!indexText) return normalizeDate(globalText);

  return normalizeDate(globalText > indexText ? globalText : indexText);
}

function compactText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseWorkerJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`指数 Python Worker 没有返回 JSON：${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(jsonStart));
}

function getPythonCommand() {
  return process.env.PYTHON || 'python';
}

function resolveIndexPreferSource(indexInfo, options = {}) {
  const manualPrefer = String(options.preferSource || '').trim();

  if (manualPrefer) {
    return manualPrefer;
  }

  if (indexInfo && indexInfo.preferSource) {
    return String(indexInfo.preferSource).trim();
  }

  if (indexInfo && indexInfo.indexCode === 'CSI:932000') {
    return 'em';
  }

  if (indexInfo && !indexInfo.txSymbol && indexInfo.emSymbol) {
    return 'em';
  }

  return '';
}

function runIndexAdapter(indexInfo, options = {}) {
    const startDate = maxStartDate(
    options.startDate || DEFAULT_INDEX_START_DATE,
    indexInfo && indexInfo.minStartDate
    );
    const endDate = normalizeDate(options.endDate || new Date().toISOString().slice(0, 10));
  const args = [
    INDEX_ADAPTER_PATH,
    '--index-code', indexInfo.indexCode,
    '--index-name', indexInfo.indexName,
    '--start-date', startDate,
    '--end-date', endDate
  ];

  const preferSource = resolveIndexPreferSource(indexInfo, options);

    if (indexInfo.txSymbol) args.push('--tx-symbol', indexInfo.txSymbol);
    if (indexInfo.emSymbol) args.push('--em-symbol', indexInfo.emSymbol);
    if (indexInfo.csindexSymbol) args.push('--csindex-symbol', indexInfo.csindexSymbol);
    if (indexInfo.bsSymbol) args.push('--bs-symbol', indexInfo.bsSymbol);
    if (indexInfo.hkTxSymbol) {
      args.push('--hk-tx-symbol', indexInfo.hkTxSymbol);
    }
    if (preferSource) args.push('--prefer-source', preferSource);

    if (indexInfo.emChunkDays) {
    args.push('--em-chunk-days', String(indexInfo.emChunkDays));
    }

  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_INDEX_SYNC_TIMEOUT_MS;
    const child = spawn(getPythonCommand(), args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: getPythonChildEnv(options.networkMode || 'direct')
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch (_error) {}
      reject(new Error(`${indexInfo.indexName} 指数同步超时`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      try {
        const payload = parseWorkerJson(stdout);
        if (!payload.ok) {
          const attempts = Array.isArray(payload.attempts)
            ? payload.attempts.map((item) => `${item.source}:${item.ok ? 'OK' : item.error}`).join(' | ')
            : '';
          const error = new Error(`${indexInfo.indexName} 指数拉取失败：${attempts || payload.error || stderr || '未知错误'}`);
          error.rawError = stderr || stdout || '';
          error.attempts = payload.attempts || [];
          reject(error);
          return;
        }
        resolve(payload);
      } catch (error) {
        error.rawError = stderr || stdout || '';
        reject(error);
      }
    });
  });
}

function normalizeSyncCodes(value) {
  if (!value) return MARKET_INDEX_CHART_CODES.slice();

  if (Array.isArray(value)) {
    return value.map(normalizeIndexCode).filter(Boolean);
  }

  return String(value)
    .split(/[，,\s]+/)
    .map(normalizeIndexCode)
    .filter(Boolean);
}

function toDisplayPct(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildSeriesStats(indexInfo, bars) {
  const validBars = Array.isArray(bars)
    ? bars.filter((bar) => Number.isFinite(Number(bar.close)))
    : [];

  const first = validBars[0] || null;
  const last = validBars[validBars.length - 1] || null;
  const firstClose = first ? Number(first.close) : null;
  const lastClose = last ? Number(last.close) : null;
  const rangePct = firstClose && lastClose !== null
    ? (lastClose - firstClose) / firstClose * 100
    : null;
  const latestPct = last ? toDisplayPct(last.pctChange) : null;

  return {
    indexCode: indexInfo.indexCode,
    indexName: indexInfo.indexName,
    market: indexInfo.market,
    role: indexInfo.role || '',
    source: last && last.source ? last.source : '',
    barCount: validBars.length,
    startDate: first ? first.date : '',
    endDate: last ? last.date : '',
    firstClose,
    lastClose,
    rangePct,
    latestPct,
    bars: validBars.map((bar) => ({
      date: bar.date,
      close: Number(bar.close),
      pctChange: toDisplayPct(bar.pctChange),
      amount: Number.isFinite(Number(bar.amount)) ? Number(bar.amount) : null,
      source: bar.source || ''
    }))
  };
}

async function syncMarketIndexDailyBars(options = {}) {
  const codes = normalizeSyncCodes(options.codes);
  const targets = listMarketIndexes({ codes });
  const startDate = normalizeDate(options.startDate || DEFAULT_INDEX_START_DATE);
  const endDate = normalizeDate(options.endDate || new Date().toISOString().slice(0, 10));
  const results = [];
  let okCount = 0;
  let failCount = 0;
  let inserted = 0;

  for (const item of targets) {
    try {
      const fetched = await runIndexAdapter(item, {
        startDate,
        endDate,
        preferSource: options.preferSource,
        networkMode: options.networkMode,
        timeoutMs: options.timeoutMs
      });

      const bars = Array.isArray(fetched.bars) ? fetched.bars : [];
      const writeResult = await upsertIndexDailyBars(item, bars);
      const insertedRows = Number(writeResult && writeResult.inserted) || 0;

      inserted += insertedRows;
      okCount += 1;

      results.push({
        ok: true,
        indexCode: item.indexCode,
        indexName: item.indexName,
        source: fetched.source || '',
        fetched: bars.length,
        inserted: insertedRows,
        startDate: fetched.startDate || '',
        endDate: fetched.endDate || '',
        attempts: fetched.attempts || []
      });
    } catch (error) {
      failCount += 1;
      results.push({
        ok: false,
        indexCode: item.indexCode,
        indexName: item.indexName,
        error: compactText(error && error.message ? error.message : error),
        attempts: error && error.attempts ? error.attempts : []
      });
    }
  }

  return {
    ok: failCount === 0 || okCount > 0,
    startDate,
    endDate,
    targetCount: targets.length,
    okCount,
    failCount,
    inserted,
    cachePath: getCachePath(),
    backend: getCacheBackend(),
    results
  };
}

async function getMarketIndexOverview(options = {}) {
  const codes = normalizeSyncCodes(options.codes);
  const startDate = normalizeDate(options.startDate || '');
  const endDate = normalizeDate(options.endDate || '');
  const items = [];

  for (const code of codes) {
    const info = getMarketIndex(code);
    if (!info) continue;

    const bars = await getIndexDailyBars(info.indexCode, { startDate, endDate });
    items.push(buildSeriesStats(info, bars));
  }

  const available = items.filter((item) => item.barCount > 0);
  const latestDates = available.map((item) => item.endDate).filter(Boolean).sort();
  const latestDate = latestDates.length ? latestDates[latestDates.length - 1] : '';
  const positiveCount = available.filter((item) => Number(item.rangePct) > 0).length;
  const negativeCount = available.filter((item) => Number(item.rangePct) < 0).length;

  return {
    ok: true,
    startDate,
    endDate,
    latestDate,
    itemCount: items.length,
    availableCount: available.length,
    missingCount: items.length - available.length,
    positiveCount,
    negativeCount,
    cachePath: getCachePath(),
    backend: getCacheBackend(),
    items
  };
}

async function getMarketIndexSummary(options = {}) {
  const codes = normalizeSyncCodes(options.codes);
  const items = [];

  for (const code of codes) {
    const info = getMarketIndex(code);
    if (!info) continue;
    const range = await getIndexDateRange(info.indexCode);
    items.push({ ...info, ...range });
  }

  return {
    ok: true,
    itemCount: items.length,
    cachePath: getCachePath(),
    backend: getCacheBackend(),
    items
  };
}

module.exports = {
  MARKET_INDEX_CHART_CODES,
  DEFAULT_INDEX_START_DATE,
  syncMarketIndexDailyBars,
  getMarketIndexOverview,
  getMarketIndexSummary
};