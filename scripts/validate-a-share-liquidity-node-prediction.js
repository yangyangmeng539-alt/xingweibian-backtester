const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

const DEFAULT_SYMBOLS = ['600519', '000858', '300750', '002594', '601318'];

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

function splitSymbols(value) {
  const text = String(value || '').trim();

  if (!text) {
    return DEFAULT_SYMBOLS;
  }

  return text
    .split(/[，,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 2) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return '-';
  }

  return `${number.toFixed(digits)}%`;
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text;
}

function getDailyStates(result) {
  return result
    && result.xwbStateAnalysis
    && Array.isArray(result.xwbStateAnalysis.dailyStates)
    ? result.xwbStateAnalysis.dailyStates
    : [];
}

function getBars(result) {
  return Array.isArray(result && result.priceSeries) ? result.priceSeries : [];
}

function getForecastDirection(value) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return 'NONE';
  }

  if (number > 0) {
    return 'UP';
  }

  if (number < 0) {
    return 'DOWN';
  }

  return 'NEUTRAL';
}

function getActualDirection(value) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return 'NONE';
  }

  if (number > 0) {
    return 'UP';
  }

  if (number < 0) {
    return 'DOWN';
  }

  return 'NEUTRAL';
}

function isDirectionHit(predicted, actual) {
  const forecastDirection = getForecastDirection(predicted);
  const actualDirection = getActualDirection(actual);

  if (forecastDirection === 'NONE' || actualDirection === 'NONE') {
    return false;
  }

  if (forecastDirection === 'NEUTRAL') {
    return Math.abs(toNumber(actual, 0)) <= 3;
  }

  return forecastDirection === actualDirection;
}

function absError(predicted, actual) {
  const left = toNumber(predicted);
  const right = toNumber(actual);

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }

  return Math.abs(left - right);
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) {
    return null;
  }

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!list.length) {
    return null;
  }

  const mid = Math.floor(list.length / 2);

  if (list.length % 2) {
    return list[mid];
  }

  return (list[mid - 1] + list[mid]) / 2;
}

function summarizeRows(rows) {
  const validRows = rows.filter((row) => {
    return Number.isFinite(Number(row.actualD20));
  });

  const rawHit = validRows.filter((row) => row.rawDirectionHit).length;
  const enhancedHit = validRows.filter((row) => row.enhancedDirectionHit).length;
  const rawMae = average(validRows.map((row) => row.rawAbsError));
  const enhancedMae = average(validRows.map((row) => row.enhancedAbsError));
  const rawBullBigDrop = validRows.filter((row) => {
    return toNumber(row.rawD20) > 0 && toNumber(row.actualD20) <= -8;
  }).length;
  const enhancedBullBigDrop = validRows.filter((row) => {
    return toNumber(row.enhancedD20) > 0 && toNumber(row.actualD20) <= -8;
  }).length;

  return {
    total: rows.length,
    valid: validRows.length,
    rawDirectionHitPct: validRows.length ? rawHit / validRows.length * 100 : null,
    enhancedDirectionHitPct: validRows.length ? enhancedHit / validRows.length * 100 : null,
    directionDeltaPct: validRows.length ? (enhancedHit - rawHit) / validRows.length * 100 : null,
    rawMae,
    enhancedMae,
    maeDelta: Number.isFinite(rawMae) && Number.isFinite(enhancedMae) ? enhancedMae - rawMae : null,
    rawBullBigDrop,
    enhancedBullBigDrop,
    bullBigDropDelta: enhancedBullBigDrop - rawBullBigDrop,
    actualD20Median: median(validRows.map((row) => row.actualD20))
  };
}

function printSummary(title, summary) {
  console.log(`\n=== ${title} ===`);
  console.log(`samples=${summary.valid}/${summary.total}`);
  console.log(`direction raw=${formatPct(summary.rawDirectionHitPct)} enhanced=${formatPct(summary.enhancedDirectionHitPct)} delta=${formatPct(summary.directionDeltaPct)}`);
  console.log(`mae raw=${formatPct(summary.rawMae)} enhanced=${formatPct(summary.enhancedMae)} delta=${formatPct(summary.maeDelta)}`);
  console.log(`bullBigDrop raw=${summary.rawBullBigDrop} enhanced=${summary.enhancedBullBigDrop} delta=${summary.bullBigDropDelta}`);
  console.log(`actualD20Median=${formatPct(summary.actualD20Median)}`);
}

async function validateSymbol(symbol, options) {
  const result = await runBacktestForSymbol({
    symbol,
    startDate: options.startDate,
    endDate: options.endDate,
    cacheOnly: options.cacheOnly,
    refresh: false,
    sourceMode: options.sourceMode,
    forecastDays: 20
  });

  const bars = getBars(result);
  const dailyStates = getDailyStates(result);
  const rows = [];
  const startIndex = Math.max(Number(options.warmup) || 140, 140);
  const endIndex = Math.max(startIndex, bars.length - 21);
  const step = Math.max(1, Number(options.step) || 20);
  const max = Math.max(1, Number(options.max) || 80);

  for (let index = startIndex; index <= endIndex && rows.length < max; index += step) {
    const bar = bars[index];

    if (!bar || !bar.date) {
      continue;
    }

    const analysis = buildNodePredictionAnalysis({
      symbol: result.symbol || symbol,
      market: result.market || 'CN_A',
      bars,
      dailyStates,
      clickedDate: normalizeDate(bar.date),
      forecastDays: 20,
      maxSamples: 160
    });

    if (!analysis || !analysis.ok) {
      continue;
    }

    const rawD20 = toNumber(analysis.horizonSummary && analysis.horizonSummary.d20 && analysis.horizonSummary.d20.medianReturnPct);
    const enhancedD20 = toNumber(
      analysis.liquidityEnhancedPrediction
        && analysis.liquidityEnhancedPrediction.horizonSummary
        && analysis.liquidityEnhancedPrediction.horizonSummary.d20
        && analysis.liquidityEnhancedPrediction.horizonSummary.d20.medianReturnPct
    );
    const actualD20 = toNumber(
      analysis.actualComparison
        && analysis.actualComparison.d20
        && analysis.actualComparison.d20.actualReturnPct
    );

    if (!Number.isFinite(rawD20) || !Number.isFinite(enhancedD20) || !Number.isFinite(actualD20)) {
      continue;
    }

    rows.push({
      symbol,
      date: normalizeDate(bar.date),
      rawD20,
      enhancedD20,
      actualD20,
      rawDirectionHit: isDirectionHit(rawD20, actualD20),
      enhancedDirectionHit: isDirectionHit(enhancedD20, actualD20),
      rawAbsError: absError(rawD20, actualD20),
      enhancedAbsError: absError(enhancedD20, actualD20),
      liquidityRegime: analysis.liquidityAnalysis && analysis.liquidityAnalysis.regime,
      liquidityScore: analysis.liquidityAnalysis && analysis.liquidityAnalysis.score,
      liquiditySummary: analysis.liquidityAnalysis && analysis.liquidityAnalysis.summaryText
    });
  }

  return {
    symbol,
    rows,
    summary: summarizeRows(rows)
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = splitSymbols(args.symbols || args.symbol).filter((symbol) => /^\d{6}$/.test(symbol));
  const options = {
    startDate: args.start || args.startDate || '20180101',
    endDate: args.end || args.endDate || '',
    step: Number(args.step || 20),
    max: Number(args.max || 80),
    warmup: Number(args.warmup || 140),
    cacheOnly: args.cacheOnly !== 'false',
    sourceMode: args.sourceMode || 'sqlite_cache_only'
  };

  const allRows = [];

  for (const symbol of symbols) {
    const result = await validateSymbol(symbol, options);

    result.rows.forEach((row) => allRows.push(row));
    printSummary(symbol, result.summary);

    console.log('样例前5条：');
    result.rows.slice(0, 5).forEach((row) => {
      console.log([
        row.date,
        `raw=${formatPct(row.rawD20)}`,
        `enhanced=${formatPct(row.enhancedD20)}`,
        `actual=${formatPct(row.actualD20)}`,
        `liq=${row.liquidityRegime}`,
        `score=${row.liquidityScore}`
      ].join(' | '));
    });
  }

  printSummary('ALL_A_SHARE', summarizeRows(allRows));

  const byRegime = {};
  allRows.forEach((row) => {
    const key = row.liquidityRegime || 'UNKNOWN';

    if (!byRegime[key]) {
      byRegime[key] = [];
    }

    byRegime[key].push(row);
  });

  console.log('\n=== 按量价状态分组 ===');
  Object.keys(byRegime).sort().forEach((key) => {
    const summary = summarizeRows(byRegime[key]);
    console.log(`${key}: samples=${summary.valid}, direction raw=${formatPct(summary.rawDirectionHitPct)} enhanced=${formatPct(summary.enhancedDirectionHitPct)}, mae raw=${formatPct(summary.rawMae)} enhanced=${formatPct(summary.enhancedMae)}`);
  });

  console.log('\nJSON_SUMMARY ' + JSON.stringify({
    symbols,
    total: summarizeRows(allRows),
    byRegime: Object.fromEntries(Object.entries(byRegime).map(([key, rows]) => [key, summarizeRows(rows)]))
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});