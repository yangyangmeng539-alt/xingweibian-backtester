const {
  syncFullMarketHistory,
  normalizeSyncSymbols,
  loadSyncState,
  getSyncStatePath
} = require('../src/data/fullMarketSyncService');
const {
  cacheIndexExists,
  getCacheIndexPath
} = require('../src/data/cacheIndexService');
const {
  getCacheBackend
} = require('../src/core/localCache');

const RETRY_STATUSES = new Set(['FAILED', 'PARTIAL_DONE']);

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
      appendArg(args, part.slice(2, eqIndex), part.slice(eqIndex + 1));
      continue;
    }

    const key = part.slice(2);
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

function parseList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseList(item));
  }

  return String(value || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return value === true || value === 'true' || value === '1';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeConcurrency(value, fallback = 3) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  const concurrency = Math.floor(num);
  return concurrency >= 1 && concurrency <= 8 ? concurrency : fallback;
}

function getRequestedStatuses(args) {
  const requested = parseList(args.statuses || args.status)
    .map((status) => status.toUpperCase())
    .filter((status) => RETRY_STATUSES.has(status));

  return new Set(requested.length > 0 ? requested : Array.from(RETRY_STATUSES));
}

function getRequestedSymbolSet(args) {
  const symbols = normalizeSyncSymbols(args.symbols || args.symbol || '');
  return symbols.length > 0 ? new Set(symbols) : null;
}

function getRequestedMarketSet(args) {
  const markets = parseList(args.markets || args.market)
    .map((market) => market.toUpperCase());

  return markets.length > 0 ? new Set(markets) : null;
}

function selectRetryItems(state, args) {
  const statuses = getRequestedStatuses(args);
  const symbolSet = getRequestedSymbolSet(args);
  const marketSet = getRequestedMarketSet(args);
  const maxCount = toNumber(firstDefined(args.max, args.maxCount, args.limit), 0);
  const items = Object.values(state.items || {})
    .filter((item) => item && statuses.has(String(item.status || '').toUpperCase()))
    .filter((item) => !symbolSet || symbolSet.has(item.symbol))
    .filter((item) => !marketSet || marketSet.has(String(item.market || '').toUpperCase()))
    .sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));

  return maxCount > 0 ? items.slice(0, maxCount) : items;
}

function buildOptions(args, symbols) {
  return {
    mode: 'symbols',
    symbols,
    markets: [],
    startDate: args.start || args.startDate || '19900101',
    endDate: args.end || args.endDate || '',
    batchSize: toNumber(args.batch || args.batchSize, 10),
    force: toBoolean(args.force, false),
    retryFailed: true,
    maxCount: 0,
    throttleMs: toNumber(args.throttle || args.throttleMs, 200),
    batchPauseMs: toNumber(args['batch-pause'] || args.batchPauseMs, 300),
    failPauseMs: toNumber(args['fail-pause'] || args.failPauseMs, 300),
    maxRetriesPerSymbol: toNumber(args.retries || args.maxRetriesPerSymbol, 2),
    concurrency: normalizeConcurrency(args.concurrency, 3)
  };
}

function formatMs(ms) {
  const value = Number(ms);

  if (!Number.isFinite(value) || value <= 0) {
    return '0s';
  }

  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m${String(restSeconds).padStart(2, '0')}s` : `${restSeconds}s`;
}

function printProgress(progress) {
  const parts = [
    `${progress.percent.toFixed(2)}%`,
    `${progress.completed}/${progress.total}`,
    `done=${progress.done}`,
    `skip=${progress.skipped}`,
    `fail=${progress.failed}`,
    `active=${progress.activeWorkers || 0}`,
    `current=${progress.currentSymbol || '-'}`,
    `status=${progress.currentStatus || '-'}`,
    `elapsed=${formatMs(progress.elapsedMs)}`
  ];

  console.log(`[sync-failed-a] ${parts.join(' ')} ${progress.lastMessage || ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadSyncState();
  const retryItems = selectRetryItems(state, args);
  const symbols = retryItems.map((item) => item.symbol);

  console.log('[sync-failed-a] start');
  console.log(`statePath: ${getSyncStatePath()}`);
  console.log(`cacheBackend: ${getCacheBackend()}`);
  console.log(`targets: ${symbols.length}`);

  if (!cacheIndexExists()) {
    console.log(`缓存索引不存在，建议先运行 node .\\scripts\\build-cache-index.js。当前路径：${getCacheIndexPath()}`);
  }

  if (symbols.length === 0) {
    console.log('[sync-failed-a] no FAILED/PARTIAL_DONE symbols to retry');
    return;
  }

  const options = buildOptions(args, symbols);
  console.log(JSON.stringify(options, null, 2));

  const finalProgress = await syncFullMarketHistory(options, printProgress);

  console.log('[sync-failed-a] final');
  console.log(JSON.stringify({
    total: finalProgress.total,
    done: finalProgress.done,
    skipped: finalProgress.skipped,
    failed: finalProgress.failed,
    completed: finalProgress.completed,
    currentStatus: finalProgress.currentStatus,
    elapsedMs: finalProgress.elapsedMs,
    cacheBackend: finalProgress.cacheBackend,
    statePath: finalProgress.statePath,
    lastMessage: finalProgress.lastMessage
  }, null, 2));

  if (finalProgress.failed > 0 || finalProgress.currentStatus === 'FAILED') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[sync-failed-a] failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  selectRetryItems,
  buildOptions,
  main
};
