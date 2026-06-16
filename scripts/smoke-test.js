const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runModelsOnBars } = require('../src/core/backtestEngine');
const localCache = require('../src/core/localCache');
const cacheIndexService = require('../src/data/cacheIndexService');
const stockUniverseService = require('../src/data/stockUniverseService');
const fullMarketSyncService = require('../src/data/fullMarketSyncService');
const syncFullAShareScript = require('./sync-full-a-share');
const {
  createDetailedFetchError,
  buildAdapterRunOrder,
  getSourceFamily,
  getPythonChildEnv
} = require('../src/workers/pythonWorker');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function makeDate(index) {
  const base = new Date(2020, 0, 1);
  base.setDate(base.getDate() + index);
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
}

function buildSyntheticBars() {
  const bars = [];
  let prevClose = 1480;

  for (let i = 0; i < 430; i += 1) {
    const cycle = i % 72;
    const baseTrend = 1480 + i * 1.15;
    const wave = Math.sin(i / 13) * 18;
    let close = baseTrend + wave;

    if (cycle >= 32 && cycle <= 45) {
      close -= (cycle - 31) * 7;
    }

    if (cycle > 45 && cycle <= 53) {
      close -= (54 - cycle) * 5;
    }

    if (cycle === 54 || cycle === 55) {
      close += 42 + (cycle - 54) * 16;
    }

    if (cycle >= 56 && cycle <= 60) {
      close += 70 - (cycle - 56) * 5;
    }

    close = Math.max(900, close);

    const isBreakout = cycle === 54 || cycle === 55;
    const open = prevClose * (1 + Math.sin(i / 9) * 0.002);
    const high = Math.max(open, close) * (isBreakout ? 1.028 : 1.014);
    const low = Math.min(open, close) * (isBreakout ? 0.992 : 0.988);
    const pctChange = ((close - prevClose) / prevClose) * 100;
    const amplitude = ((high - low) / prevClose) * 100;
    const volume = isBreakout ? 2400000 : 950000 + Math.round(Math.sin(i / 8) * 80000);

    bars.push({
      symbol: '600519',
      date: makeDate(i),
      open,
      close,
      high,
      low,
      volume,
      amount: volume * close,
      amplitude,
      pctChange,
      changeAmount: close - prevClose,
      turnover: 0.9
    });

    prevClose = close;
  }

  return bars;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const originalHttpProxy = process.env.HTTP_PROXY;
process.env.HTTP_PROXY = 'http://127.0.0.1:10809';
const directPythonEnv = getPythonChildEnv();
if (originalHttpProxy === undefined) {
  delete process.env.HTTP_PROXY;
} else {
  process.env.HTTP_PROXY = originalHttpProxy;
}

[
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
].forEach((key) => {
  assert.strictEqual(directPythonEnv[key], '');
});
assert.strictEqual(directPythonEnv.NO_PROXY, '*');
assert.strictEqual(directPythonEnv.no_proxy, '*');
assert.strictEqual(directPythonEnv.XWB_NETWORK_MODE, 'direct');

const detailedFetchError = createDetailedFetchError('adapter failed', {
  akshareError: 'akshare raw',
  eastmoneyError: 'eastmoney raw',
  altDailyError: 'alt raw',
  rawError: 'raw failure',
  lastTransportError: 'curl_cffi_https failed'
});
assert.strictEqual(detailedFetchError.akshareError, 'akshare raw');
assert.strictEqual(detailedFetchError.eastmoneyError, 'eastmoney raw');
assert.strictEqual(detailedFetchError.altDailyError, 'alt raw');
assert.strictEqual(detailedFetchError.rawError, 'raw failure');
assert.strictEqual(detailedFetchError.lastTransportError, 'curl_cffi_https failed');

const emptyBarsError = createDetailedFetchError('empty bars', {
  emptyBars: true,
  emptySource: 'alt_daily'
});
assert.strictEqual(emptyBarsError.emptyBars, true);
assert.strictEqual(emptyBarsError.emptySource, 'alt_daily');
assert.strictEqual(getSourceFamily('tencent_fqkline:qfq:qfqday'), 'alt_daily');
assert.deepStrictEqual(
  buildAdapterRunOrder('').map((adapter) => adapter.source),
  ['akshare', 'eastmoney_direct', 'alt_daily']
);
assert.deepStrictEqual(
  buildAdapterRunOrder('alt_daily').map((adapter) => adapter.source),
  ['alt_daily', 'akshare', 'eastmoney_direct']
);

const eastmoneyAdapterSource = fs.readFileSync(
  path.resolve(__dirname, '../src/adapters/eastmoneyDirectAdapter.py'),
  'utf8'
);
const altDailyAdapterSource = fs.readFileSync(
  path.resolve(__dirname, '../src/adapters/altDailyAdapter.py'),
  'utf8'
);
const fullMarketSyncSource = fs.readFileSync(
  path.resolve(__dirname, '../src/data/fullMarketSyncService.js'),
  'utf8'
);
const localCacheSource = fs.readFileSync(
  path.resolve(__dirname, '../src/core/localCache.js'),
  'utf8'
);
const sqliteDiskBridgeSource = fs.readFileSync(
  path.resolve(__dirname, '../src/core/sqliteDiskCacheBridge.py'),
  'utf8'
);
const mainSource = fs.readFileSync(
  path.resolve(__dirname, '../main.js'),
  'utf8'
);

[
  'push2his.eastmoney.com',
  '82.push2his.eastmoney.com',
  '91.push2his.eastmoney.com',
  '92.push2his.eastmoney.com'
].forEach((host) => {
  assert.ok(eastmoneyAdapterSource.includes(host));
});
[
  '"hostErrors"',
  '"transportErrors"',
  '"triedHosts"',
  '"selectedHost"',
  '"selectedTransport"'
].forEach((field) => {
  assert.ok(eastmoneyAdapterSource.includes(field));
});
assert.ok(eastmoneyAdapterSource.includes('"Connection": "close"'));
assert.ok(eastmoneyAdapterSource.includes('"Host": host'));
assert.ok(eastmoneyAdapterSource.includes('"impersonate": "chrome"'));
assert.ok(eastmoneyAdapterSource.includes('"proxies": {}'));
const curlCffiOptionsMatch = eastmoneyAdapterSource.match(/request_options = \{[\s\S]*?\n    \}/);
assert.ok(curlCffiOptionsMatch);
assert.ok(!curlCffiOptionsMatch[0].includes('trust_env'));

assert.ok(altDailyAdapterSource.includes('web.ifzq.gtimg.cn'));
assert.ok(!altDailyAdapterSource.includes('push2his'));
[
  '"ok"',
  '"source"',
  '"networkMode"',
  '"proxyDisabled"',
  '"bars"',
  '"error"',
  '"traceback"',
  '"rawError"',
  '"change"',
  '"changeAmount"'
].forEach((field) => {
  assert.ok(altDailyAdapterSource.includes(field));
});

assert.strictEqual(typeof stockUniverseService.loadStockUniverse, 'function');
assert.strictEqual(typeof stockUniverseService.refreshStockUniverse, 'function');
assert.strictEqual(typeof stockUniverseService.getActiveStocksOnDate, 'function');
assert.strictEqual(typeof stockUniverseService.filterStocksForSync, 'function');
assert.strictEqual(typeof stockUniverseService.normalizeSymbol, 'function');
assert.strictEqual(typeof localCache.beginDeferredCacheSave, 'function');
assert.strictEqual(typeof localCache.endDeferredCacheSave, 'function');
assert.strictEqual(typeof localCache.flushCacheToDisk, 'function');
assert.strictEqual(typeof localCache.getCacheBackend, 'function');
assert.strictEqual(typeof localCache.getCacheBackendInfo, 'function');
assert.strictEqual(typeof localCache.setCacheBackendPreference, 'function');
assert.strictEqual(typeof localCache.isCacheWriteMemoryError, 'function');
assert.strictEqual(typeof cacheIndexService.getCacheIndexPath, 'function');
assert.strictEqual(typeof cacheIndexService.loadCacheIndex, 'function');
assert.strictEqual(typeof cacheIndexService.saveCacheIndex, 'function');
assert.strictEqual(typeof cacheIndexService.getCachedSymbolSummary, 'function');
assert.strictEqual(typeof cacheIndexService.updateCachedSymbolSummary, 'function');
assert.strictEqual(typeof cacheIndexService.buildCacheIndexFromSqlite, 'function');
assert.ok(cacheIndexService.getCacheIndexPath().endsWith(path.join('data', 'sync', 'cache-index.json')));

const cacheSaveStateBefore = localCache.getCacheSaveState();
localCache.beginDeferredCacheSave();
assert.strictEqual(localCache.getCacheSaveState().deferred, true);
localCache.endDeferredCacheSave({ flush: false });
assert.strictEqual(localCache.getCacheSaveState().depth, cacheSaveStateBefore.depth);
assert.strictEqual(typeof fullMarketSyncService.syncFullMarketHistory, 'function');
assert.strictEqual(typeof fullMarketSyncService.buildProgress, 'function');
assert.strictEqual(typeof fullMarketSyncService.normalizeSyncSymbols, 'function');
assert.strictEqual(typeof fullMarketSyncService.selectStocksForSync, 'function');
assert.strictEqual(typeof fullMarketSyncService.getCacheSnapshot, 'function');
assert.strictEqual(typeof fullMarketSyncService.buildSyncPlan, 'function');
assert.strictEqual(typeof fullMarketSyncService.resolveFullChunkedStatus, 'function');
assert.strictEqual(typeof fullMarketSyncService.runWorkerPool, 'function');
assert.strictEqual(typeof fullMarketSyncService.withWriteLock, 'function');
assert.strictEqual(fullMarketSyncService.SYNC_VERSION, 'dev-0.1.9.13');
assert.strictEqual(fullMarketSyncService.CACHE_INDEX_VERSION, 'dev-0.1.9.12');
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({}).fullChunkYears, 5);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({}).throttleMs, 200);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({}).batchPauseMs, 300);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({}).failPauseMs, 300);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({}).concurrency, 3);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({ concurrency: 4 }).concurrency, 4);
assert.strictEqual(fullMarketSyncService.normalizeSyncOptions({ concurrency: 99 }).concurrency, 3);
assert.ok(fullMarketSyncSource.includes('loadCacheIndex({ reload: true })'));
assert.ok(fullMarketSyncSource.includes('getCachedSymbolSummary'));
assert.ok(!fullMarketSyncSource.includes('buildCacheIndexFromSqlite('));
assert.ok(localCacheSource.includes('updateCachedSymbolSummary'));
assert.ok(localCacheSource.includes('cacheIndexUpdate'));
assert.ok(localCacheSource.includes('runSqliteDiskCacheBridge'));
assert.ok(localCacheSource.includes('SQLJS_EXPORT_SIZE_LIMIT_BYTES'));
assert.ok(localCacheSource.includes('createSqljsExportBlockedError'));
assert.ok(localCacheSource.includes('isDiskCacheBackend()'));
assert.ok(fullMarketSyncSource.includes("setCacheBackendPreference('disk_sqlite')"));
assert.ok(fullMarketSyncSource.includes('isCacheWriteMemoryError'));
assert.ok(fullMarketSyncSource.includes('markCacheWriteStopped'));
assert.ok(sqliteDiskBridgeSource.includes('sqlite3.connect'));
assert.ok(sqliteDiskBridgeSource.includes('INSERT OR REPLACE INTO daily_bars'));
assert.ok(sqliteDiskBridgeSource.includes('conn.execute("BEGIN")'));
assert.ok(sqliteDiskBridgeSource.includes('build-index-summary'));

const freshStartIndex = mainSource.indexOf('latestFullMarketSyncProgress = buildFreshFullMarketStartProgress(input, concurrency);');
const taskStartIndex = mainSource.indexOf('activeFullMarketSyncTask = syncFullMarketHistory(');
assert.ok(freshStartIndex >= 0 && taskStartIndex > freshStartIndex);
assert.ok(mainSource.includes("currentStatus: 'STARTING'"));
assert.ok(mainSource.includes('recentMessages: []'));
assert.ok(mainSource.includes("currentSymbol: ''"));
assert.ok(mainSource.includes('total = symbols.length;'));
assert.ok(mainSource.includes('total = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 0;'));

const universeFixture = [
  { symbol: '600519', name: '贵州茅台', market: 'SH', status: 'ACTIVE' },
  { symbol: '300750', name: '宁德时代', market: 'SZ', status: 'ACTIVE' },
  { symbol: '002594', name: '比亚迪', market: 'SZ', status: 'ACTIVE' },
  { symbol: '430047', name: '测试北交', market: 'BJ', status: 'ACTIVE' }
];
const symbolsUniverseFixture = [
  { symbol: '000029', name: '深深房A', market: 'SZ', status: 'ACTIVE' },
  { symbol: '000030', name: '富奥股份', market: 'SZ', status: 'ACTIVE' },
  { symbol: '600519', name: '贵州茅台', market: 'SH', status: 'ACTIVE' }
];

assert.deepStrictEqual(
  stockUniverseService.filterStocksForSync({ mode: 'full', universe: universeFixture }).map((stock) => stock.symbol),
  ['600519', '300750', '002594', '430047']
);
assert.deepStrictEqual(
  stockUniverseService.filterStocksForSync({ mode: 'current', currentSymbol: '300750', universe: universeFixture }).map((stock) => stock.symbol),
  ['300750']
);
assert.deepStrictEqual(
  stockUniverseService.filterStocksForSync({ mode: 'symbols', symbols: ['002594', '600519'], universe: universeFixture }).map((stock) => stock.symbol),
  ['002594', '600519']
);
assert.deepStrictEqual(
  stockUniverseService.filterStocksForSync({ mode: 'market', markets: ['SZ'], universe: universeFixture }).map((stock) => stock.symbol),
  ['300750', '002594']
);
assert.deepStrictEqual(
  stockUniverseService.filterStocksForSync({ mode: 'limit', maxCount: 2, universe: universeFixture }).map((stock) => stock.symbol),
  ['600519', '300750']
);

const symbolsCliOptions = syncFullAShareScript.buildOptions(
  syncFullAShareScript.parseArgs(['--symbols=000029,000030'])
);
assert.deepStrictEqual(symbolsCliOptions.symbols, ['000029', '000030']);
assert.strictEqual(symbolsCliOptions.mode, 'symbols');
assert.strictEqual(symbolsCliOptions.maxCount, 0);
assert.strictEqual(symbolsCliOptions.throttleMs, 200);
assert.strictEqual(symbolsCliOptions.batchPauseMs, 300);
assert.strictEqual(symbolsCliOptions.failPauseMs, 300);
assert.strictEqual(symbolsCliOptions.concurrency, 3);

const symbolsConcurrencyCliOptions = syncFullAShareScript.buildOptions(
  syncFullAShareScript.parseArgs(['--symbols=000029,000030', '--concurrency=4'])
);
assert.deepStrictEqual(symbolsConcurrencyCliOptions.symbols, ['000029', '000030']);
assert.strictEqual(symbolsConcurrencyCliOptions.mode, 'symbols');
assert.strictEqual(symbolsConcurrencyCliOptions.maxCount, 0);
assert.strictEqual(symbolsConcurrencyCliOptions.concurrency, 4);

const splitSymbolsCliOptions = syncFullAShareScript.buildOptions(
  syncFullAShareScript.parseArgs(['--symbols=000029', '30'])
);
assert.deepStrictEqual(splitSymbolsCliOptions.symbols, ['000029', '000030']);

const symbolsSelectedStocks = fullMarketSyncService.selectStocksForSync(
  { mode: 'symbols', symbols: ['000029', '000030'], maxCount: 1 },
  symbolsUniverseFixture
);
assert.deepStrictEqual(symbolsSelectedStocks.map((stock) => stock.symbol), ['000029', '000030']);
assert.strictEqual(symbolsSelectedStocks.length, 2);

assert.throws(
  () => fullMarketSyncService.selectStocksForSync(
    { mode: 'symbols', symbols: ['999999'] },
    symbolsUniverseFixture
  ),
  /symbols 模式未匹配到股票，已阻止全市场同步/
);

const limitCliOptions = syncFullAShareScript.buildOptions(
  syncFullAShareScript.parseArgs(['--limit=2'])
);
assert.strictEqual(limitCliOptions.mode, 'limit');
assert.strictEqual(limitCliOptions.maxCount, 2);

const limitConcurrencyCliOptions = syncFullAShareScript.buildOptions(
  syncFullAShareScript.parseArgs(['--scope=all', '--maxCount=2', '--concurrency=4'])
);
assert.strictEqual(limitConcurrencyCliOptions.mode, 'limit');
assert.strictEqual(limitConcurrencyCliOptions.maxCount, 2);
assert.strictEqual(limitConcurrencyCliOptions.concurrency, 4);
assert.deepStrictEqual(
  fullMarketSyncService.selectStocksForSync(
    { mode: 'limit', maxCount: 2 },
    universeFixture
  ).map((stock) => stock.symbol),
  ['600519', '300750']
);
assert.deepStrictEqual(
  fullMarketSyncService.selectStocksForSync(
    limitConcurrencyCliOptions,
    universeFixture
  ).map((stock) => stock.symbol),
  ['600519', '300750']
);

assert.strictEqual(
  fullMarketSyncService.resolveFullChunkedStatus({
    chunks: [{}, {}, {}],
    finishedChunks: [
      { source: 'alt_daily', barCount: 10 },
      { source: 'alt_daily', barCount: 12 }
    ],
    emptyChunks: [{ status: 'EMPTY_CHUNK' }],
    failedChunks: [],
    addedBars: 22
  }),
  'DONE'
);
assert.strictEqual(
  fullMarketSyncService.resolveFullChunkedStatus({
    chunks: [{}, {}, {}],
    finishedChunks: [{ source: 'alt_daily', barCount: 10 }],
    emptyChunks: [{ status: 'EMPTY_CHUNK' }],
    failedChunks: [{ error: 'transport failed' }],
    addedBars: 10
  }),
  'PARTIAL_DONE'
);
assert.strictEqual(
  fullMarketSyncService.resolveFullChunkedStatus({
    chunks: [{}, {}],
    finishedChunks: [],
    emptyChunks: [{ status: 'EMPTY_CHUNK' }, { status: 'EMPTY_CHUNK' }],
    failedChunks: [],
    addedBars: 0
  }),
  'FAILED'
);

const syncProgress = fullMarketSyncService.buildProgress({
  state: {
    running: true,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    items: {
      '600519': { status: 'DONE', costMs: 1000 },
      '300750': { status: 'SKIPPED', costMs: 1 },
      '002594': { status: 'FAILED', costMs: 500 },
      '430047': { status: 'PARTIAL_DONE', costMs: 800 },
      '000004': { status: 'NO_NEW_DATA', costMs: 600 }
    }
  },
  selectedSymbols: ['600519', '300750', '002594', '430047', '000004'],
  currentSymbol: '002594',
  currentStatus: 'FAILED'
});

[
  'total',
  'done',
  'skipped',
  'failed',
  'elapsedMs',
  'estimatedRemainingMs'
].forEach((key) => {
  assert.ok(hasOwn(syncProgress, key));
});
assert.strictEqual(syncProgress.done, 2);
assert.strictEqual(syncProgress.skipped, 2);
assert.strictEqual(syncProgress.failed, 1);
assert.strictEqual(syncProgress.completed, 5);

const concurrentEtaProgress = fullMarketSyncService.buildProgress({
  state: {
    running: true,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    total: 10,
    concurrency: 4,
    activeWorkers: 4,
    items: {
      '000001': { status: 'DONE', costMs: 1000 },
      '000002': { status: 'DONE', costMs: 1000 }
    }
  },
  selectedSymbols: ['000001', '000002', '000003', '000004', '000005', '000006', '000007', '000008', '000009', '000010']
});
assert.strictEqual(concurrentEtaProgress.avgCostMs, 1000);
assert.strictEqual(concurrentEtaProgress.estimatedRemainingMs, 2000);

const skippedOnlyEtaProgress = fullMarketSyncService.buildProgress({
  state: {
    running: true,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    total: 10,
    concurrency: 4,
    activeWorkers: 4,
    items: {
      '000001': { status: 'SKIPPED', costMs: 100 },
      '000002': { status: 'NO_NEW_DATA', costMs: 100 }
    }
  },
  selectedSymbols: ['000001', '000002', '000003', '000004', '000005', '000006', '000007', '000008', '000009', '000010']
});
assert.strictEqual(skippedOnlyEtaProgress.avgCostMs, 100);
assert.strictEqual(skippedOnlyEtaProgress.estimatedRemainingMs, 0);

const bars = buildSyntheticBars();
const result = runModelsOnBars({
  symbol: '600519',
  bars
}, {
  forecastDays: 20,
  maxSamples: 160
});

assert.strictEqual(result.symbol, '600519');
assert.strictEqual(result.barCount, bars.length);
assert.strictEqual(result.barStart, bars[0].date);
assert.strictEqual(result.barEnd, bars[bars.length - 1].date);
assert.strictEqual(result.algoVersion, 'xwb-prediction');
assert.strictEqual(result.predictionVersion, 'xwb-prediction');
assert.strictEqual(result.nodePredictionVersion, 'xwb-node-prediction');
assert.strictEqual(result.selectedNodeDate, bars[bars.length - 1].date);
assert.ok(result.warning);

assert.ok(result.xwbStateAnalysis);
assert.ok(Array.isArray(result.xwbStateAnalysis.dailyStates));
assert.ok(Array.isArray(result.xwbStateAnalysis.stateStats));
assert.strictEqual(result.xwbStateAnalysis.dailyStates.length, result.barCount);
assert.ok(result.xwbStateAnalysis.stateStats.length > 0);
assert.ok(result.xwbStateAnalysis.dailyStates.some((item) => item && item.stateCode));

assert.ok(result.predictionAnalysis);
assert.strictEqual(result.predictionAnalysis.algoVersion, 'xwb-prediction');
assert.ok(Array.isArray(result.predictionAnalysis.dailyPredictions));
assert.ok(Array.isArray(result.predictionAnalysis.predictionStats));
assert.strictEqual(result.predictionAnalysis.dailyPredictions.length, result.barCount);
assert.ok(result.predictionAnalysis.latestPrediction);

assert.ok(result.nodePredictionAnalysis);
assert.strictEqual(result.nodePredictionAnalysis.algoVersion, 'xwb-node-prediction');
assert.strictEqual(result.nodePredictionAnalysis.ok, true);
assert.strictEqual(typeof result.nodePredictionAnalysis.similarSampleCount, 'number');
assert.ok(result.nodePredictionAnalysis.horizonSummary);
assert.ok(result.nodePredictionAnalysis.horizonSummary.d5);
assert.ok(result.nodePredictionAnalysis.horizonSummary.d10);
assert.ok(result.nodePredictionAnalysis.horizonSummary.d20);
assert.ok(Array.isArray(result.nodePredictionAnalysis.futurePathStats));
assert.ok(Array.isArray(result.nodePredictionAnalysis.actualFuturePath));
assert.ok(result.nodePredictionAnalysis.actualComparison);
assert.ok(result.nodePredictionAnalysis.actualComparison.d5);
assert.ok(result.nodePredictionAnalysis.actualComparison.d10);
assert.ok(result.nodePredictionAnalysis.actualComparison.d20);
assert.ok(result.nodePredictionAnalysis.actualComparisonSummary);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d5.hasActual, false);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d5.actualReturnPct, null);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d10.hasActual, false);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d10.actualReturnPct, null);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d20.hasActual, false);
assert.strictEqual(result.nodePredictionAnalysis.actualComparison.d20.actualReturnPct, null);
assert.strictEqual(result.nodePredictionAnalysis.actualComparisonSummary.actualCount, 0);
assert.strictEqual(result.nodePredictionAnalysis.actualComparisonSummary.overallVerdict, 'NO_ACTUAL_DATA');
assert.ok(
  String(result.nodePredictionAnalysis.validationNote || '').includes('不使用点击日期之后的数据')
);

assert.ok(result.debugTradingModels);
assert.strictEqual(result.debugTradingModels.enabled, false);
assert.deepStrictEqual(result.debugTradingModels.models, []);
assert.strictEqual(hasOwn(result, 'models'), false);
assert.strictEqual(hasOwn(result, 'opportunityAnalysis'), false);
assert.strictEqual(hasOwn(result, 'buyHold'), false);
assert.strictEqual(hasOwn(result, 'comparison'), false);
assert.strictEqual(hasOwn(result, 'legacyModels'), false);

const firstState = result.xwbStateAnalysis.dailyStates[0];
[
  'date',
  'close',
  'shape',
  'position',
  'change',
  'stateCode',
  'stateName',
  'stateSummary',
  'futureReturns'
].forEach((key) => {
  assert.ok(hasOwn(firstState, key));
});
assert.ok(hasOwn(firstState.futureReturns, 'd5'));
assert.ok(hasOwn(firstState.futureReturns, 'd10'));
assert.ok(hasOwn(firstState.futureReturns, 'd20'));

const clickedDate = bars[Math.floor(bars.length / 2)].date;
const clickedResult = runModelsOnBars(bars, {
  symbol: '600519',
  clickedDate,
  forecastDays: 20,
  maxSamples: 160
});

assert.strictEqual(clickedResult.selectedNodeDate, clickedDate);
assert.strictEqual(clickedResult.nodePredictionAnalysis.clickedDate, clickedDate);
assert.ok(clickedResult.nodePredictionAnalysis.actualComparison);
assert.ok(clickedResult.nodePredictionAnalysis.actualComparison.d5);
assert.ok(clickedResult.nodePredictionAnalysis.actualComparison.d10);
assert.ok(clickedResult.nodePredictionAnalysis.actualComparison.d20);
assert.ok(clickedResult.nodePredictionAnalysis.actualComparisonSummary);

const latestPrediction = result.predictionAnalysis.latestPrediction;
const horizonSummary = result.nodePredictionAnalysis.horizonSummary;
const cacheIndexFixture = {
  items: {
    '600519': {
      symbol: '600519',
      barCount: 8408,
      startDate: '1991-04-03',
      endDate: '2026-06-05',
      lastIndexedAt: '2026-06-05T00:00:00.000Z'
    }
  }
};
let sqliteFallbackCalls = 0;
const cacheIndexAssertions = Promise.all([
  fullMarketSyncService.getCacheSnapshot('600519', {
    cacheIndex: cacheIndexFixture,
    sqliteSummaryReader: () => {
      throw new Error('cache-index hit should not touch sqlite fallback');
    }
  }).then((snapshot) => {
    assert.strictEqual(snapshot.source, 'cache-index');
    assert.strictEqual(snapshot.indexHit, true);
    assert.strictEqual(snapshot.count, 8408);
    assert.strictEqual(snapshot.startDate, '1991-04-03');
    assert.strictEqual(snapshot.endDate, '2026-06-05');
  }),
  fullMarketSyncService.getCacheSnapshot('000001', {
    cacheIndex: { items: {} },
    sqliteSummaryReader: async (symbol) => {
      sqliteFallbackCalls += 1;
      return {
        symbol,
        count: 3,
        startDate: '2020-01-01',
        endDate: '2020-01-03'
      };
    }
  }).then((snapshot) => {
    assert.strictEqual(snapshot.source, 'sqlite-symbol');
    assert.strictEqual(snapshot.indexHit, false);
    assert.strictEqual(snapshot.count, 3);
    assert.strictEqual(sqliteFallbackCalls, 1);
  }),
  fullMarketSyncService.buildSyncPlan(
    { symbol: '600519', name: '贵州茅台', market: 'SH' },
    fullMarketSyncService.normalizeSyncOptions({ endDate: '20260605' }),
    cacheIndexFixture
  ).then((plan) => {
    assert.strictEqual(plan.syncMode, 'SKIPPED');
    assert.strictEqual(plan.cache.source, 'cache-index');
    assert.strictEqual(plan.cache.count, 8408);
  })
]);
const smoke = {
  ok: true,
  algoVersion: result.predictionVersion,
  nodeAlgoVersion: result.nodePredictionVersion,
  symbol: result.symbol,
  selectedNodeDate: result.selectedNodeDate,
  actualComparisonVerdict: result.nodePredictionAnalysis.actualComparisonSummary.overallVerdict,
  stateDailyCount: result.xwbStateAnalysis.dailyStates.length,
  predictionDailyCount: result.predictionAnalysis.dailyPredictions.length,
  similarSampleCount: result.nodePredictionAnalysis.similarSampleCount,
  latestStateCode: latestPrediction.stateCode,
  latestPredictionGrade: latestPrediction.predictionGrade,
  d5SampleCount: horizonSummary.d5.sampleCount,
  d10SampleCount: horizonSummary.d10.sampleCount,
  d20SampleCount: horizonSummary.d20.sampleCount,
  syncServiceAssertions: true,
  proxyIsolationAssertions: true
};

const workerPoolSeen = [];
const workerPoolAssertions = fullMarketSyncService.runWorkerPool(
  [
    { symbol: '000001' },
    { symbol: '000002' },
    { symbol: '000003' },
    { symbol: '000004' }
  ],
  2,
  async (stock) => {
    workerPoolSeen.push(stock.symbol);
    return stock.symbol;
  }
);

Promise.all([workerPoolAssertions, cacheIndexAssertions]).then(([poolResult]) => {
  assert.strictEqual(poolResult.workerCount, 2);
  assert.deepStrictEqual(
    workerPoolSeen.slice().sort(),
    ['000001', '000002', '000003', '000004']
  );
  assert.strictEqual(new Set(workerPoolSeen).size, workerPoolSeen.length);
  assert.deepStrictEqual(
    poolResult.processedSymbols.slice().sort(),
    ['000001', '000002', '000003', '000004']
  );

  smoke.workerPoolAssertions = true;
  smoke.cacheIndexAssertions = true;
  console.log(JSON.stringify(smoke, null, 2));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
