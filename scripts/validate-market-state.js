const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildMarketStateAnalysis } = require('../src/core/marketStateService');

const DEFAULT_A_SYMBOLS = [
  '600519',
  '000858',
  '300750',
  '002594',
  '601318',
  '600036',
  '000001',
  '600276',
  '603259',
  '600887',
  '000333',
  '000651',
  '600900',
  '601899',
  '000725',
  '002475',
  '603986',
  '601012',
  '600438',
  '600030'
];

const DEFAULT_HK_SYMBOLS = [
  'HK:00700',
  'HK:09988',
  'HK:03690',
  'HK:09868',
  'HK:01810',
  'HK:00941',
  'HK:01299',
  'HK:02318',
  'HK:02498'
];

function parseArgs(argv) {
  const args = {};

  argv.slice(2).forEach((item) => {
    const match = String(item || '').match(/^--([^=]+)=(.*)$/);

    if (match) {
      args[match[1]] = match[2];
    }
  });

  return args;
}

function normalizeMarket(value) {
  const text = String(value || '').trim().toUpperCase();

  if (text === 'HK' || text === 'HKG') return 'HK';
  if (text === 'A' || text === 'ASHARE' || text === 'A_SHARE' || text === 'CN_A') return 'CN_A';

  return 'CN_A';
}

function normalizeSymbol(symbol, market) {
  const text = String(symbol || '').trim();

  if (market === 'HK') {
    if (/^HK:/i.test(text)) return text.toUpperCase();
    if (/^\d{1,5}$/.test(text)) return `HK:${text.padStart(5, '0')}`;
    if (/^\d{1,5}\.HK$/i.test(text)) return `HK:${text.replace(/\.HK$/i, '').padStart(5, '0')}`;
    return text.toUpperCase();
  }

  const digits = text.replace(/\D/g, '');

  return digits.length >= 6 ? digits.slice(-6) : text;
}

function splitSymbols(value, market) {
  const raw = String(value || '').trim();
  const defaults = market === 'HK' ? DEFAULT_HK_SYMBOLS : DEFAULT_A_SYMBOLS;

  if (!raw) return defaults;

  return raw
    .split(/[，,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeSymbol(item, market));
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text.slice(0, 10);
}

function pickLatestCoveredDate(barsBySymbol, minCount) {
  const countByDate = new Map();

  Object.values(barsBySymbol).forEach((bars) => {
    (Array.isArray(bars) ? bars : []).forEach((bar) => {
      const date = normalizeDate(bar && bar.date);

      if (!date) return;

      countByDate.set(date, (countByDate.get(date) || 0) + 1);
    });
  });

  const dates = Array.from(countByDate.entries())
    .filter(([, count]) => count >= minCount)
    .map(([date]) => date)
    .sort();

  return dates[dates.length - 1] || '';
}

async function loadBarsForSymbols(symbols, options) {
  const barsBySymbol = {};
  const failures = [];

  for (const symbol of symbols) {
    try {
      const result = await runBacktestForSymbol({
        symbol,
        startDate: options.startDate,
        endDate: options.endDate,
        cacheOnly: options.cacheOnly,
        refresh: options.refresh,
        sourceMode: options.sourceMode,
        forecastDays: 20,
        maxSamples: 160
      });

      barsBySymbol[symbol] = Array.isArray(result && result.priceSeries)
        ? result.priceSeries
        : [];

      console.log(`[LOAD] ${symbol} bars=${barsBySymbol[symbol].length}`);
    } catch (error) {
      failures.push({
        symbol,
        error: error && error.message ? error.message : String(error)
      });

      console.log(`[FAIL] ${symbol} ${error && error.message ? error.message : String(error)}`);
    }
  }

  return {
    barsBySymbol,
    failures
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const market = normalizeMarket(args.market || args.m);
  const symbols = splitSymbols(args.symbols || args.symbol, market);
  const startDate = args.start || args.startDate || '20180101';
  const endDate = args.end || args.endDate || '';
  const sourceMode = args.sourceMode || 'sqlite_cache_only';
  const cacheOnly = args.cacheOnly !== 'false';
  const refresh = args.refresh === 'true';

  console.log(`\n=== LOAD ${market} ===`);
  console.log(`symbols=${symbols.join(', ')}`);

  const loaded = await loadBarsForSymbols(symbols, {
    startDate,
    endDate,
    sourceMode,
    cacheOnly,
    refresh
  });

  const minCount = Math.max(5, Math.ceil(symbols.length * 0.35));
  const targetDate = normalizeDate(args.date || args.d) || pickLatestCoveredDate(loaded.barsBySymbol, minCount);

  const analysis = buildMarketStateAnalysis({
    market,
    date: targetDate,
    barsBySymbol: loaded.barsBySymbol
  });

  console.log(`\n=== MARKET STATE ${market} ${targetDate} ===`);

  if (!analysis.ok) {
    console.log(JSON.stringify(analysis, null, 2));
    console.log('\nFAILURES', JSON.stringify(loaded.failures, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(analysis.summaryText);
  console.log('\n宽度 breadth:', analysis.breadth);
  console.log('趋势 trend:', analysis.trend);
  console.log('活跃 liquidity:', analysis.liquidity);
  console.log('风险 risk:', analysis.risk);
  console.log('评分 scoreParts:', analysis.scoreParts);

  console.log('\nJSON_MARKET_STATE ' + JSON.stringify({
    market,
    date: targetDate,
    symbols,
    analysis,
    failures: loaded.failures
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});