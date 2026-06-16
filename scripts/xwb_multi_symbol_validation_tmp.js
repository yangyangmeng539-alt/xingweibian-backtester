const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

let structureService = {};
try {
  structureService = require('../src/core/nodeStructurePredictionService');
} catch (_error) {
  structureService = {};
}

const DEFAULT_SYMBOLS = [
  '600519',
  '000858',
  '300750',
  '002594',
  '601318'
];

function parseArgs(argv) {
  const args = {};

  argv.slice(2).forEach((item) => {
    const text = String(item || '').trim();
    const match = text.match(/^--([^=]+)=(.*)$/);

    if (match) {
      args[match[1]] = match[2];
    }
  });

  return args;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatPct(value, digits = 2) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return `${num.toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return num.toFixed(digits);
}

function average(values) {
  const nums = values
    .map((value) => toNumber(value))
    .filter(Number.isFinite);

  if (!nums.length) {
    return null;
  }

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function normalizeSymbolArg(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  return digits.padStart(6, '0').slice(-6);
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

function getDailyStates(backtestResult) {
  return backtestResult
    && backtestResult.xwbStateAnalysis
    && Array.isArray(backtestResult.xwbStateAnalysis.dailyStates)
    ? backtestResult.xwbStateAnalysis.dailyStates
    : [];
}

function getRawForecastPct(nodePredictionAnalysis, day) {
  const targetDay = Number(day);
  const key = `d${targetDay}`;

  const forecastMilestones = nodePredictionAnalysis && nodePredictionAnalysis.forecastMilestones
    ? nodePredictionAnalysis.forecastMilestones
    : {};

  if (forecastMilestones[key]) {
    const value = toNumber(forecastMilestones[key].medianReturnPct);

    if (Number.isFinite(value)) {
      return value;
    }
  }

  const horizonSummary = nodePredictionAnalysis && nodePredictionAnalysis.horizonSummary
    ? nodePredictionAnalysis.horizonSummary
    : {};

  if (horizonSummary[key]) {
    const value = toNumber(horizonSummary[key].medianReturnPct);

    if (Number.isFinite(value)) {
      return value;
    }
  }

  const stats = Array.isArray(nodePredictionAnalysis && nodePredictionAnalysis.futurePathStats)
    ? nodePredictionAnalysis.futurePathStats
    : [];

  const stat = stats.find((item) => Number(item && item.day) === targetDay);

  return toNumber(stat && stat.medianReturnPct);
}

function getStructureForecastPct(nodePredictionAnalysis, day) {
  const rawReturnPct = getRawForecastPct(nodePredictionAnalysis, day);
  const fn = structureService && structureService.getStructureAdjustedForecastReturnPct;

  if (!Number.isFinite(toNumber(rawReturnPct))) {
    return null;
  }

  if (typeof fn !== 'function') {
    return rawReturnPct;
  }

  try {
    const value = fn(nodePredictionAnalysis, Number(day), rawReturnPct, 'median');

    if (Number.isFinite(toNumber(value))) {
      return Number(value);
    }
  } catch (_error) {
    // 兼容不同函数签名。
  }

  try {
    const value = fn({
      nodePredictionAnalysis,
      day: Number(day),
      rawReturnPct,
      band: 'median'
    });

    if (Number.isFinite(toNumber(value))) {
      return Number(value);
    }
  } catch (_error) {
    // 兼容不同函数签名。
  }

  return rawReturnPct;
}

function getActualReturnPctFromBars(bars, currentIndex, day) {
  const offset = Number(day);

  if (!Array.isArray(bars) || !Number.isInteger(currentIndex) || !Number.isFinite(offset)) {
    return null;
  }

  const currentClose = toNumber(bars[currentIndex] && bars[currentIndex].close);
  const futureClose = toNumber(bars[currentIndex + offset] && bars[currentIndex + offset].close);

  if (!Number.isFinite(currentClose) || !Number.isFinite(futureClose) || currentClose <= 0) {
    return null;
  }

  return (futureClose / currentClose - 1) * 100;
}

function getActualReturnPct(nodePredictionAnalysis, bars, index, day) {
  const rapid = nodePredictionAnalysis && nodePredictionAnalysis.rapidChangeAnalysis
    ? nodePredictionAnalysis.rapidChangeAnalysis
    : null;

  const rapidMap = rapid
    ? {
      3: rapid.d3ReturnPct,
      5: rapid.d5ReturnPct,
      10: rapid.d10ReturnPct,
      20: rapid.d20ReturnPct
    }
    : {};

  const rapidValue = rapidMap[Number(day)];

  if (Number.isFinite(toNumber(rapidValue))) {
    return Number(rapidValue);
  }

  return getActualReturnPctFromBars(bars, index, day);
}

function direction(value) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return '';
  }

  if (num > 0) {
    return 'UP';
  }

  if (num < 0) {
    return 'DOWN';
  }

  return 'FLAT';
}

function directionHit(forecast, actual) {
  if (!Number.isFinite(toNumber(forecast)) || !Number.isFinite(toNumber(actual))) {
    return null;
  }

  const forecastDirection = direction(forecast);
  const actualDirection = direction(actual);

  if (!forecastDirection || !actualDirection || forecastDirection === 'FLAT' || actualDirection === 'FLAT') {
    return null;
  }

  return forecastDirection === actualDirection;
}

function hitRate(rows, fieldName, actualFieldName) {
  const valid = rows.filter((row) => {
    return Number.isFinite(toNumber(row[actualFieldName]))
      && typeof row[fieldName] === 'boolean';
  });

  if (!valid.length) {
    return null;
  }

  return valid.filter((row) => row[fieldName]).length / valid.length * 100;
}

function summarizeRows(rows) {
  const valid = Array.isArray(rows) ? rows : [];

  return {
    样本: valid.length,

    历史D3均值: formatPct(average(valid.map((row) => row.historyD3Pct))),
    结构D3均值: formatPct(average(valid.map((row) => row.structureD3Pct))),
    真实D3均值: formatPct(average(valid.map((row) => row.actualD3Pct))),

    历史D5均值: formatPct(average(valid.map((row) => row.historyD5Pct))),
    结构D5均值: formatPct(average(valid.map((row) => row.structureD5Pct))),
    真实D5均值: formatPct(average(valid.map((row) => row.actualD5Pct))),

    历史D10均值: formatPct(average(valid.map((row) => row.historyD10Pct))),
    结构D10均值: formatPct(average(valid.map((row) => row.structureD10Pct))),
    真实D10均值: formatPct(average(valid.map((row) => row.actualD10Pct))),

    历史D20均值: formatPct(average(valid.map((row) => row.historyD20Pct))),
    结构D20均值: formatPct(average(valid.map((row) => row.structureD20Pct))),
    真实D20均值: formatPct(average(valid.map((row) => row.actualD20Pct))),

    rawD3命中: formatPct(hitRate(valid, 'rawD3Hit', 'actualD3Pct'), 1),
    结构D3命中: formatPct(hitRate(valid, 'structureD3Hit', 'actualD3Pct'), 1),

    rawD5命中: formatPct(hitRate(valid, 'rawD5Hit', 'actualD5Pct'), 1),
    结构D5命中: formatPct(hitRate(valid, 'structureD5Hit', 'actualD5Pct'), 1),

    rawD10命中: formatPct(hitRate(valid, 'rawD10Hit', 'actualD10Pct'), 1),
    结构D10命中: formatPct(hitRate(valid, 'structureD10Hit', 'actualD10Pct'), 1),

    rawD20命中: formatPct(hitRate(valid, 'rawD20Hit', 'actualD20Pct'), 1),
    结构D20命中: formatPct(hitRate(valid, 'structureD20Hit', 'actualD20Pct'), 1)
  };
}

function summarizeBy(rows, keyName, labelName) {
  const groupMap = new Map();

  rows.forEach((row) => {
    const key = String(row[keyName] || 'UNKNOWN');
    const list = groupMap.get(key) || [];
    list.push(row);
    groupMap.set(key, list);
  });

  return Array.from(groupMap.entries())
    .map(([key, list]) => ({
      [labelName]: key,
      ...summarizeRows(list)
    }))
    .sort((left, right) => Number(right.样本 || 0) - Number(left.样本 || 0));
}

function buildValidationRowsForSymbol(symbol, backtestResult, options) {
  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];
  const dailyStates = getDailyStates(backtestResult);
  const warmup = Math.max(0, Number(options.warmup || 120));
  const step = Math.max(1, Number(options.step || 10));
  const max = Math.max(1, Number(options.max || 120));
  const forecastDays = Math.max(20, Number(options.forecastDays || 20));
  const maxSamples = Math.max(20, Number(options.maxSamples || 160));

  const rows = [];

  for (let index = warmup; index < bars.length - forecastDays && rows.length < max; index += step) {
    const bar = bars[index];

    if (!bar || !bar.date || !Number.isFinite(toNumber(bar.close))) {
      continue;
    }

    const clickedDate = normalizeDate(bar.date);

    let analysis = null;

    try {
      analysis = buildNodePredictionAnalysis({
        symbol,
        bars,
        dailyStates,
        clickedDate,
        forecastDays,
        maxSamples
      });
    } catch (error) {
      rows.push({
        symbol,
        index,
        clickedDate,
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
      continue;
    }

    if (!analysis || !analysis.ok) {
      rows.push({
        symbol,
        index,
        clickedDate,
        ok: false,
        error: analysis && analysis.error ? analysis.error : 'node prediction failed'
      });
      continue;
    }

    const rapid = analysis.rapidChangeAnalysis || {};
    const row = {
      symbol,
      index,
      clickedDate,
      close: toNumber(bar.close),
      ok: true,

      rapidType: rapid.rapidType || 'UNKNOWN',
      rapidTitle: rapid.rapidTitle || '',
      rapidSignal: rapid.rapidSignal || '',
      rapidScore: toNumber(rapid.rapidScore, 0),

      historyD3Pct: getRawForecastPct(analysis, 3),
      structureD3Pct: getStructureForecastPct(analysis, 3),
      actualD3Pct: getActualReturnPct(analysis, bars, index, 3),

      historyD5Pct: getRawForecastPct(analysis, 5),
      structureD5Pct: getStructureForecastPct(analysis, 5),
      actualD5Pct: getActualReturnPct(analysis, bars, index, 5),

      historyD10Pct: getRawForecastPct(analysis, 10),
      structureD10Pct: getStructureForecastPct(analysis, 10),
      actualD10Pct: getActualReturnPct(analysis, bars, index, 10),

      historyD20Pct: getRawForecastPct(analysis, 20),
      structureD20Pct: getStructureForecastPct(analysis, 20),
      actualD20Pct: getActualReturnPct(analysis, bars, index, 20),

      actualMaxUpPct: toNumber(rapid.maxUpPct),
      actualMaxDownPct: toNumber(rapid.maxDownPct),
      actualMaxUpDay: toNumber(rapid.maxUpDay),
      actualMaxDownDay: toNumber(rapid.maxDownDay)
    };

    row.rawD3Hit = directionHit(row.historyD3Pct, row.actualD3Pct);
    row.structureD3Hit = directionHit(row.structureD3Pct, row.actualD3Pct);

    row.rawD5Hit = directionHit(row.historyD5Pct, row.actualD5Pct);
    row.structureD5Hit = directionHit(row.structureD5Pct, row.actualD5Pct);

    row.rawD10Hit = directionHit(row.historyD10Pct, row.actualD10Pct);
    row.structureD10Hit = directionHit(row.structureD10Pct, row.actualD10Pct);

    row.rawD20Hit = directionHit(row.historyD20Pct, row.actualD20Pct);
    row.structureD20Hit = directionHit(row.structureD20Pct, row.actualD20Pct);

    rows.push(row);
  }

  return rows;
}

async function validateSymbol(symbol, options) {
  console.log(`\n[SYMBOL_START] ${symbol}`);

  const backtestResult = await runBacktestForSymbol({
    symbol,
    startDate: options.start,
    endDate: options.end,
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only'
  });

  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];

  const rows = buildValidationRowsForSymbol(symbol, backtestResult, options);
  const validRows = rows.filter((row) => row && row.ok);

  console.log(`[SYMBOL_DATA] ${symbol} bars=${bars.length} first=${bars[0] ? bars[0].date : '-'} last=${bars[bars.length - 1] ? bars[bars.length - 1].date : '-'} rows=${rows.length} valid=${validRows.length}`);

  console.log(`[SYMBOL_SUMMARY] ${symbol}`);
  console.table([{
    股票: symbol,
    ...summarizeRows(validRows)
  }]);

  console.log(`[SYMBOL_BY_RAPID_CHANGE] ${symbol}`);
  console.table(summarizeBy(validRows, 'rapidType', '急变类型'));

  return {
    symbol,
    rows,
    validRows,
    summary: summarizeRows(validRows)
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = String(args.symbols || '')
    .split(',')
    .map(normalizeSymbolArg)
    .filter(Boolean);

  const options = {
    symbols: symbols.length ? symbols : DEFAULT_SYMBOLS,
    start: args.start || '20180101',
    end: args.end || '20260601',
    step: Number(args.step || 10),
    max: Number(args.max || 120),
    warmup: Number(args.warmup || 120),
    forecastDays: Number(args.forecastDays || 20),
    maxSamples: Number(args.maxSamples || 160)
  };

  console.log('[MULTI_SYMBOL_VALIDATION_OPTIONS]');
  console.log(JSON.stringify(options, null, 2));

  const allRows = [];
  const symbolSummaries = [];
  const failures = [];

  for (const symbol of options.symbols) {
    try {
      const result = await validateSymbol(symbol, options);
      allRows.push(...result.validRows);
      symbolSummaries.push({
        股票: symbol,
        ...result.summary
      });
    } catch (error) {
      const message = error && error.stack ? error.stack : String(error);
      failures.push({
        symbol,
        error: message
      });
      console.error(`[SYMBOL_FAIL] ${symbol}`);
      console.error(message);
    }
  }

  console.log('\n[MULTI_SYMBOL_SUMMARY_BY_SYMBOL]');
  console.table(symbolSummaries);

  console.log('\n[MULTI_SYMBOL_SUMMARY_TOTAL]');
  console.table([{
    股票: 'ALL',
    ...summarizeRows(allRows)
  }]);

  console.log('\n[MULTI_SYMBOL_BY_RAPID_CHANGE]');
  console.table(summarizeBy(allRows, 'rapidType', '急变类型'));

  console.log('\n[MULTI_SYMBOL_FAILURES]');
  console.table(failures);

  console.log('\n[MULTI_SYMBOL_DONE]');
  console.log(JSON.stringify({
    symbols: options.symbols.length,
    validRows: allRows.length,
    failures: failures.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});