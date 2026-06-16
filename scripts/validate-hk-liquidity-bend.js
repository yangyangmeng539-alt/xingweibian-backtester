const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildHkLiquidityBendAnalysisFromBars } = require('../src/core/hkLiquidityBendFactorService');

const DEFAULT_SYMBOLS = [
  'HK:00700',
  'HK:09988',
  'HK:03690',
  'HK:09868',
  'HK:01810',
  'HK:00941',
  'HK:01299',
  'HK:02318'
];

function parseArgs(argv) {
  const args = {};

  argv.slice(2).forEach((item) => {
    const match = String(item || '').match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  });

  return args;
}

function splitSymbols(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_SYMBOLS;

  return raw
    .split(/[，,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (/^HK:/i.test(item)) return item.toUpperCase();
      const digits = item.replace(/\D/g, '');
      return digits ? `HK:${digits.padStart(5, '0')}` : item;
    });
}

function summarize(rows, label) {
  const total = rows.length;
  const byRegime = new Map();

  rows.forEach((row) => {
    const key = row.regime || 'UNKNOWN';
    const list = byRegime.get(key) || [];
    list.push(row);
    byRegime.set(key, list);
  });

  console.log(`\n=== ${label} ===`);
  console.log(`samples=${total}`);

  Array.from(byRegime.entries())
    .sort((left, right) => right[1].length - left[1].length)
    .forEach(([regime, list]) => {
      const avgScore = list.reduce((sum, item) => sum + Number(item.score || 0), 0) / list.length;
      const avgBend = list.reduce((sum, item) => sum + Number(item.avgAbsBend || 0), 0) / list.length;

      console.log(`${regime}: samples=${list.length}, avgScore=${avgScore.toFixed(3)}, avgAbsBend=${avgBend.toFixed(3)}`);
    });
}

function avgAbsBend(bendByDayPct) {
  const values = Object.values(bendByDayPct || {})
    .map(Number)
    .filter(Number.isFinite);

  if (!values.length) return 0;

  return values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = splitSymbols(args.symbols || args.symbol);
  const startDate = args.start || args.startDate || '20180101';
  const endDate = args.end || args.endDate || '';
  const step = Math.max(1, Number(args.step || 20));
  const max = Math.max(1, Number(args.max || 80));
  const warmup = Math.max(80, Number(args.warmup || 140));
  const cacheOnly = args.cacheOnly !== 'false';
  const refresh = args.refresh === 'true';
  const sourceMode = args.sourceMode || 'sqlite_cache_only';

  const allRows = [];
  const failures = [];

  for (const symbol of symbols) {
    try {
      const result = await runBacktestForSymbol({
        symbol,
        startDate,
        endDate,
        cacheOnly,
        refresh,
        sourceMode,
        forecastDays: 20,
        maxSamples: 160
      });

      const bars = Array.isArray(result && result.priceSeries) ? result.priceSeries : [];
      const rows = [];

      for (let index = warmup; index < bars.length - 20 && rows.length < max; index += step) {
        const analysis = buildHkLiquidityBendAnalysisFromBars({
          symbol,
          bars,
          clickedIndex: index,
          forecastDays: 20
        });

        if (!analysis || !analysis.ok) continue;

        rows.push({
          symbol,
          date: analysis.clickedDate,
          regime: analysis.regime,
          score: analysis.score,
          avgAbsBend: avgAbsBend(analysis.bendByDayPct),
          summaryText: analysis.summaryText
        });
      }

      allRows.push(...rows);
      summarize(rows, symbol);

      console.log('样例前5条：');
      rows.slice(0, 5).forEach((row) => {
        console.log(`${row.date} | ${row.regime} | score=${row.score} | bend=${row.avgAbsBend.toFixed(2)} | ${row.summaryText}`);
      });
    } catch (error) {
      failures.push({
        symbol,
        error: error && error.message ? error.message : String(error)
      });

      console.log(`\n=== ${symbol} FAILED ===`);
      console.log(error && error.message ? error.message : String(error));
    }
  }

  summarize(allRows, 'ALL_HK');

  if (failures.length) {
    console.log('\n=== FAILURES ===');
    failures.forEach((item) => console.log(`${item.symbol}: ${item.error}`));
  }

  console.log('\nJSON_HK_LIQUIDITY_BEND_SUMMARY ' + JSON.stringify({
    symbols: Array.from(new Set(allRows.map((row) => row.symbol))),
    totalRows: allRows.length,
    regimes: Array.from(
      allRows.reduce((map, row) => {
        const list = map.get(row.regime) || [];
        list.push(row);
        map.set(row.regime, list);
        return map;
      }, new Map()).entries()
    ).map(([regime, rows]) => ({
      regime,
      samples: rows.length,
      avgScore: rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / rows.length,
      avgAbsBend: rows.reduce((sum, row) => sum + Number(row.avgAbsBend || 0), 0) / rows.length
    })),
    failures
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});