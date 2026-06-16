const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

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

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 1) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return '-';
  }

  return `${number.toFixed(digits)}%`;
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

function getDailyStates(backtestResult) {
  return backtestResult
    && backtestResult.xwbStateAnalysis
    && Array.isArray(backtestResult.xwbStateAnalysis.dailyStates)
    ? backtestResult.xwbStateAnalysis.dailyStates
    : [];
}

function getRapidTargetGroup(rapidType) {
  const value = String(rapidType || '');

  if (value === 'FAST_TREND_EXTEND' || value === 'SLOW_START_EXTEND') {
    return 'EXTEND_UP';
  }

  if (value === 'FAST_BREAKDOWN' || value === 'SLOW_BLEED') {
    return 'BREAKDOWN_DOWN';
  }

  if (
    value === 'INTRADAY_WINDOW_ONLY'
    || value === 'FAST_TAKE_PROFIT_DECAY'
    || value === 'REBOUND_DECAY'
  ) {
    return 'SHORT_WINDOW_DECAY';
  }

  if (value === 'KILL_THEN_REPAIR') {
    return 'KILL_THEN_REPAIR';
  }

  return 'OTHER';
}

function normalizePredictedGroup(group) {
  const value = String(group || '');

  if (value === 'EXTEND_UP') {
    return 'EXTEND_UP';
  }

  if (value === 'BREAKDOWN_DOWN' || value === 'BREAKDOWN_OR_EXHAUSTION') {
    return 'BREAKDOWN_DOWN';
  }

  if (value === 'SHORT_WINDOW_DECAY') {
    return 'SHORT_WINDOW_DECAY';
  }

  if (value === 'KILL_THEN_REPAIR') {
    return 'KILL_THEN_REPAIR';
  }

  if (value === 'LOW_REPAIR_OR_DECAY') {
    return 'LOW_REPAIR_OR_DECAY';
  }

  if (value === 'MIXED') {
    return 'MIXED';
  }

  return value || 'UNKNOWN';
}

function isSoftHit(predictedGroup, actualGroup) {
  if (predictedGroup === actualGroup) {
    return true;
  }

  if (predictedGroup === 'BREAKDOWN_OR_EXHAUSTION') {
    return actualGroup === 'BREAKDOWN_DOWN' || actualGroup === 'SHORT_WINDOW_DECAY';
  }

  if (predictedGroup === 'LOW_REPAIR_OR_DECAY') {
    return actualGroup === 'EXTEND_UP'
      || actualGroup === 'SHORT_WINDOW_DECAY'
      || actualGroup === 'KILL_THEN_REPAIR';
  }

  return false;
}

function groupBy(rows, keyFn) {
  const map = new Map();

  rows.forEach((row) => {
    const key = String(keyFn(row) || 'UNKNOWN');
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  });

  return map;
}

function summarizeRows(rows) {
  const valid = Array.isArray(rows) ? rows : [];
  const predicted = valid.filter((row) => row.predictedGroup !== 'MIXED');
  const strictHits = predicted.filter((row) => row.predictedGroupNormalized === row.actualTargetGroup);
  const softHits = predicted.filter((row) => row.softHit);

  return {
    样本: valid.length,
    有预测样本: predicted.length,
    覆盖率: formatPct(valid.length ? predicted.length / valid.length * 100 : null),
    严格命中: formatPct(predicted.length ? strictHits.length / predicted.length * 100 : null),
    宽松命中: formatPct(predicted.length ? softHits.length / predicted.length * 100 : null),
    平均置信度: formatPct(average(predicted.map((row) => row.confidence * 100))),
    真实D3均值: formatPct(average(valid.map((row) => row.actualD3Pct)), 2),
    真实D5均值: formatPct(average(valid.map((row) => row.actualD5Pct)), 2),
    真实D20均值: formatPct(average(valid.map((row) => row.actualD20Pct)), 2)
  };
}

function summarizeBy(rows, keyName, labelName) {
  return Array.from(groupBy(rows, (row) => row[keyName]).entries())
    .map(([key, list]) => ({
      [labelName]: key,
      ...summarizeRows(list)
    }))
    .sort((left, right) => Number(right.样本 || 0) - Number(left.样本 || 0));
}

function summarizePredictionMatrix(rows) {
  const groups = Array.from(groupBy(rows, (row) => row.predictedGroupNormalized).entries());

  return groups
    .map(([predictedGroup, list]) => {
      const actualMap = groupBy(list, (row) => row.actualTargetGroup);
      const actualParts = Array.from(actualMap.entries())
        .map(([actualGroup, actualRows]) => `${actualGroup}:${actualRows.length}`)
        .join(' / ');

      return {
        预测组: predictedGroup,
        样本: list.length,
        实际分布: actualParts,
        严格命中: formatPct(list.length ? list.filter((row) => row.predictedGroupNormalized === row.actualTargetGroup).length / list.length * 100 : null),
        宽松命中: formatPct(list.length ? list.filter((row) => row.softHit).length / list.length * 100 : null),
        平均置信度: formatPct(average(list.map((row) => row.confidence * 100))),
        真实D20均值: formatPct(average(list.map((row) => row.actualD20Pct)), 2)
      };
    })
    .sort((left, right) => Number(right.样本 || 0) - Number(left.样本 || 0));
}

function buildRowsForSymbol(symbol, backtestResult, options) {
  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];
  const dailyStates = getDailyStates(backtestResult);

  const warmup = Math.max(80, Number(options.warmup || 120));
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

    const rapid = analysis && analysis.rapidChangeAnalysis ? analysis.rapidChangeAnalysis : null;
    const prediction = analysis && analysis.rapidTypePrediction ? analysis.rapidTypePrediction : null;

    if (!analysis || !analysis.ok || !rapid || !rapid.ok || !prediction || !prediction.ok) {
      rows.push({
        symbol,
        index,
        clickedDate,
        ok: false,
        error: 'rapid prediction failed'
      });
      continue;
    }

    const actualTargetGroup = getRapidTargetGroup(rapid.rapidType);
    const predictedGroup = String(prediction.predictedRapidGroup || 'UNKNOWN');
    const predictedGroupNormalized = normalizePredictedGroup(predictedGroup);

    rows.push({
      symbol,
      index,
      clickedDate,
      ok: true,

      actualRapidType: rapid.rapidType,
      actualTargetGroup,

      predictedGroup,
      predictedGroupNormalized,
      predictedTitle: prediction.predictedRapidTitle || '',
      predictedSignal: prediction.predictedSignal || '',
      confidence: toNumber(prediction.confidence, 0),

      strictHit: predictedGroupNormalized === actualTargetGroup,
      softHit: isSoftHit(predictedGroup, actualTargetGroup),

      actualD3Pct: toNumber(rapid.d3ReturnPct),
      actualD5Pct: toNumber(rapid.d5ReturnPct),
      actualD20Pct: toNumber(rapid.d20ReturnPct),

      summaryText: prediction.summaryText || ''
    });
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

  const rows = buildRowsForSymbol(symbol, backtestResult, options);
  const validRows = rows.filter((row) => row.ok);

  console.log(`[SYMBOL_DATA] ${symbol} bars=${bars.length} first=${bars[0] ? bars[0].date : '-'} last=${bars[bars.length - 1] ? bars[bars.length - 1].date : '-'} rows=${rows.length} valid=${validRows.length}`);

  console.log(`[SYMBOL_PREDICTOR_SUMMARY] ${symbol}`);
  console.table([{
    股票: symbol,
    ...summarizeRows(validRows)
  }]);

  console.log(`[SYMBOL_PREDICTOR_BY_PREDICTED_GROUP] ${symbol}`);
  console.table(summarizeBy(validRows, 'predictedGroupNormalized', '预测组'));

  return {
    symbol,
    rows,
    validRows
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

  console.log('[RAPID_PREDICTOR_VALIDATION_OPTIONS]');
  console.log(JSON.stringify(options, null, 2));

  const allRows = [];
  const failures = [];

  for (const symbol of options.symbols) {
    try {
      const result = await validateSymbol(symbol, options);
      allRows.push(...result.validRows);
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

  console.log('\n[RAPID_PREDICTOR_SUMMARY_TOTAL]');
  console.table([{
    股票: 'ALL',
    ...summarizeRows(allRows)
  }]);

  console.log('\n[RAPID_PREDICTOR_BY_PREDICTED_GROUP]');
  console.table(summarizeBy(allRows, 'predictedGroupNormalized', '预测组'));

  console.log('\n[RAPID_PREDICTOR_MATRIX]');
  console.table(summarizePredictionMatrix(allRows));

  console.log('\n[RAPID_PREDICTOR_FAILURES]');
  console.table(failures);

  console.log('\n[RAPID_PREDICTOR_DONE]');
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