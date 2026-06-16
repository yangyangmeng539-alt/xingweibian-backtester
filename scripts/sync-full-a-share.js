const {
  syncFullMarketHistory,
  normalizeSyncSymbols
} = require('../src/data/fullMarketSyncService');
const {
  cacheIndexExists,
  getCacheIndexPath
} = require('../src/data/cacheIndexService');
const {
  getCacheBackend
} = require('../src/core/localCache');

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

      if (key === 'symbols') {
        while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
          appendArg(args, key, argv[index + 1]);
          index += 1;
        }
      }

      continue;
    }

    const key = part.slice(2);
    const next = argv[index + 1];

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
    return value;
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

function normalizeConcurrency(value, fallback = 1) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  const concurrency = Math.floor(num);
  return concurrency >= 1 && concurrency <= 8 ? concurrency : fallback;
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

function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function buildOptions(args) {
  const hasSymbolsArg = hasArg(args, 'symbols');
  const symbols = normalizeSyncSymbols(args.symbols);
  const mode = hasSymbolsArg || symbols.length > 0
    ? 'symbols'
    : String(args.mode || 'limit').trim().toLowerCase();

  return {
    mode,
    currentSymbol: args.current || args.symbol || '',
    symbols,
    markets: parseList(args.markets || args.market),
    startDate: args.start || args.startDate || '19900101',
    endDate: args.end || args.endDate || '',
    batchSize: toNumber(args.batch || args.batchSize, 10),
    force: toBoolean(args.force, false),
    retryFailed: toBoolean(args.retryFailed, true),
    maxCount: mode === 'symbols' ? 0 : toNumber(firstDefined(args.max, args.maxCount, args.limit), 0),
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

  if (minutes > 0) {
    return `${minutes}m${String(restSeconds).padStart(2, '0')}s`;
  }

  return `${restSeconds}s`;
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
    `elapsed=${formatMs(progress.elapsedMs)}`,
    `eta=${formatMs(progress.estimatedRemainingMs)}`
  ];

  console.log(`[sync-full-a] ${parts.join(' ')} ${progress.lastMessage || ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = buildOptions(args);

  if (options.mode === 'symbols') {
    console.log(`symbols: ${JSON.stringify(options.symbols)}`);
    console.log(`total: ${options.symbols.length}`);
    console.log(`mode: ${JSON.stringify(options.mode)}`);
  }

  console.log('[sync-full-a] start');
  console.log(JSON.stringify(options, null, 2));
  console.log(`cacheBackend: ${getCacheBackend()}`);

  if (!cacheIndexExists()) {
    console.log(`缓存索引不存在，建议先运行 node .\\scripts\\build-cache-index.js。当前路径：${getCacheIndexPath()}`);
  }

  const finalProgress = await syncFullMarketHistory(options, printProgress);

  console.log('[sync-full-a] final');
  console.log(JSON.stringify({
    total: finalProgress.total,
    done: finalProgress.done,
    skipped: finalProgress.skipped,
    failed: finalProgress.failed,
    completed: finalProgress.completed,
    currentStatus: finalProgress.currentStatus,
    concurrency: finalProgress.concurrency,
    activeWorkers: finalProgress.activeWorkers,
    elapsedMs: finalProgress.elapsedMs,
    avgCostMs: finalProgress.avgCostMs,
    estimatedRemainingMs: finalProgress.estimatedRemainingMs,
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
    console.error(`[sync-full-a] failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  buildOptions,
  parseList,
  normalizeConcurrency,
  main
};
