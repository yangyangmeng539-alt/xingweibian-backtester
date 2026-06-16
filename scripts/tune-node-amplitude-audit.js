const fs = require('fs');
const path = require('path');
const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

const DEFAULT_SYMBOLS = [
  '600519','000858','300750','002594','601318',
  '600036','000001','600276','603259','600887',
  '000333','000651','600900','601899','000725',
  '002475','603986','601012','600438','600030',
  '601888','002415','300059','600031','600309'
];

const HORIZONS = [3, 5, 10, 20];

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((item) => {
    const m = String(item || '').match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  });
  return args;
}

function normalizeSymbol(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/HK/i.test(text)) return text;
  const digits = text.replace(/\D/g, '');
  return digits ? digits.padStart(6, '0').slice(-6) : '';
}

function splitSymbols(value) {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_SYMBOLS;
  return text.split(/[,\s，]+/).map(normalizeSymbol).filter(Boolean);
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 3) {
  const n = num(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function avg(values) {
  const list = values.map((v) => num(v)).filter(Number.isFinite);
  if (!list.length) return null;
  return list.reduce((s, v) => s + v, 0) / list.length;
}

function median(values) {
  const list = values.map((v) => num(v)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = (list.length - 1) / 2;
  const l = Math.floor(mid);
  const r = Math.ceil(mid);
  if (l === r) return list[l];
  return list[l] * (r - mid) + list[r] * (mid - l);
}

function absAvg(values) {
  return avg(values.map((v) => Math.abs(num(v, 0))));
}

function pct(value, digits = 2) {
  const n = num(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '-';
}

function getDate(bar) {
  return String(bar && (bar.date || bar.tradeDate || bar.trade_date) || '');
}

function getDailyStates(result) {
  return result && result.xwbStateAnalysis && Array.isArray(result.xwbStateAnalysis.dailyStates)
    ? result.xwbStateAnalysis.dailyStates
    : [];
}

function getStatByDay(stats, day) {
  return (Array.isArray(stats) ? stats : []).find((item) => Number(item && item.day) === Number(day)) || null;
}

function getForecastBasePct(analysis, day) {
  const key = `d${Number(day)}`;
  const milestone = analysis && analysis.forecastMilestones ? analysis.forecastMilestones[key] : null;
  const fromMilestone = num(milestone && milestone.medianReturnPct);
  if (Number.isFinite(fromMilestone)) return fromMilestone;

  const stat = getStatByDay(analysis && analysis.futurePathStats, day);
  return num(stat && stat.medianReturnPct);
}

function getBaselineRawPct(analysis, day) {
  const stat = getStatByDay(analysis && analysis.baselineFuturePathStats, day);
  return num(stat && stat.medianReturnPct);
}

function getActualPct(analysis, day) {
  const path = Array.isArray(analysis && analysis.actualFuturePath) ? analysis.actualFuturePath : [];
  const point = path.find((item) => Number(item && item.day) === Number(day));
  if (!point || point.exists === false) return null;
  return num(point.returnPct);
}

function direction(value) {
  const n = num(value);
  if (!Number.isFinite(n)) return '';
  if (n > 0) return 'UP';
  if (n < 0) return 'DOWN';
  return 'FLAT';
}

function directionHit(forecast, actual) {
  const f = direction(forecast);
  const a = direction(actual);
  if (!f || !a || f === 'FLAT' || a === 'FLAT') return null;
  return f === a;
}

function getPreheatBias(analysis, day) {
  const preheat = analysis && analysis.preheatPathShapePrediction ? analysis.preheatPathShapePrediction : {};
  const curve = preheat.curveBiasPct || {};
  return num(curve[`d${Number(day)}`], 0);
}

function getShape(analysis) {
  const preheat = analysis && analysis.preheatPathShapePrediction ? analysis.preheatPathShapePrediction : {};
  return String(preheat.shape || 'UNKNOWN');
}

function getShapeLabel(analysis) {
  const preheat = analysis && analysis.preheatPathShapePrediction ? analysis.preheatPathShapePrediction : {};
  return String(preheat.label || preheat.shape || 'UNKNOWN');
}

function getShapeConfidence(analysis) {
  const preheat = analysis && analysis.preheatPathShapePrediction ? analysis.preheatPathShapePrediction : {};
  return num(preheat.confidence, 0);
}

function getLiquidityRegime(analysis) {
  const liquidity = analysis && analysis.liquidityAnalysis ? analysis.liquidityAnalysis : {};
  return String(liquidity.regime || liquidity.regimeKey || liquidity.type || 'UNKNOWN');
}

function getLiquidityScore(analysis) {
  const liquidity = analysis && analysis.liquidityAnalysis ? analysis.liquidityAnalysis : {};
  return num(liquidity.score, 0);
}

function getCurrentStateCode(analysis) {
  return String(
    analysis
    && analysis.currentNode
    && analysis.currentNode.stateCode
      ? analysis.currentNode.stateCode
      : 'UNKNOWN'
  );
}

function summarizeRows(rows) {
  const valid = rows.filter((row) => Number.isFinite(num(row.actualPct)) && Number.isFinite(num(row.basePct)));
  return {
    count: valid.length,
    baseAvg: round(avg(valid.map((row) => row.basePct)), 3),
    actualAvg: round(avg(valid.map((row) => row.actualPct)), 3),
    rawBaseAvg: round(avg(valid.map((row) => row.rawBasePct)), 3),
    currentBiasAvg: round(avg(valid.map((row) => row.currentPreheatBiasPct)), 3),
    suggestedBiasAvg: round(avg(valid.map((row) => row.suggestedBiasPct)), 3),
    gapAvg: round(avg(valid.map((row) => row.paramGapPct)), 3),
    gapMedian: round(median(valid.map((row) => row.paramGapPct)), 3),
    maeBase: round(absAvg(valid.map((row) => row.baseErrorPct)), 3),
    maeAfterCurrentBias: round(absAvg(valid.map((row) => row.currentBiasErrorPct)), 3),
    directionHitRatePct: round(
      valid.filter((row) => row.directionHit === true).length / Math.max(1, valid.filter((row) => row.directionHit !== null).length) * 100,
      2
    )
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  });
  return map;
}

function summarizeGroup(rows, keyFields) {
  const groups = groupBy(rows, (row) => keyFields.map((key) => row[key]).join('||'));
  return Array.from(groups.entries()).map(([key, list]) => {
    const parts = key.split('||');
    const obj = {};
    keyFields.forEach((field, index) => {
      obj[field] = parts[index];
    });
    const summary = summarizeRows(list);
    const conservativeNewBias = round(summary.currentBiasAvg + summary.gapAvg * 0.35, 3);
    const aggressiveNewBias = round(summary.currentBiasAvg + summary.gapAvg * 0.65, 3);
    return {
      ...obj,
      ...summary,
      suggestedNewBias35Pct: conservativeNewBias,
      suggestedNewBias65Pct: aggressiveNewBias
    };
  }).sort((a, b) => {
    const left = Math.abs(num(a.gapAvg, 0)) * Math.sqrt(num(a.count, 0));
    const right = Math.abs(num(b.gapAvg, 0)) * Math.sqrt(num(b.count, 0));
    return right - left;
  });
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))
  ].join('\n');
}

async function validateSymbol(symbol, options) {
  console.log(`[SYMBOL] ${symbol}`);

  const result = await runBacktestForSymbol({
    symbol,
    startDate: options.start,
    endDate: options.end,
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only'
  });

  const bars = Array.isArray(result && result.priceSeries) ? result.priceSeries : [];
  const dailyStates = getDailyStates(result);
  const rows = [];

  for (
    let index = options.warmup;
    index < bars.length - options.forecastDays && rows.length < options.maxPerSymbol;
    index += options.step
  ) {
    const bar = bars[index];
    const clickedDate = getDate(bar);

    if (!clickedDate || !Number.isFinite(num(bar && bar.close))) {
      continue;
    }

    let analysis = null;

    try {
      analysis = buildNodePredictionAnalysis({
        symbol,
        market: options.market,
        bars,
        dailyStates,
        clickedDate,
        forecastDays: options.forecastDays,
        maxSamples: options.maxSamples
      });
    } catch (error) {
      continue;
    }

    if (!analysis || !analysis.ok) {
      continue;
    }

    const shape = getShape(analysis);
    const shapeLabel = getShapeLabel(analysis);
    const shapeConfidence = getShapeConfidence(analysis);
    const liquidityRegime = getLiquidityRegime(analysis);
    const liquidityScore = getLiquidityScore(analysis);
    const stateCode = getCurrentStateCode(analysis);

    HORIZONS.forEach((day) => {
      const rawBasePct = getBaselineRawPct(analysis, day);
      const basePct = getForecastBasePct(analysis, day);
      const actualPct = getActualPct(analysis, day);
      const currentPreheatBiasPct = getPreheatBias(analysis, day);

      if (!Number.isFinite(num(basePct)) || !Number.isFinite(num(actualPct))) {
        return;
      }

      const suggestedBiasPct = actualPct - basePct;
      const paramGapPct = suggestedBiasPct - currentPreheatBiasPct;

      rows.push({
        symbol,
        clickedDate,
        day,
        stateCode,
        shape,
        shapeLabel,
        shapeConfidence: round(shapeConfidence, 3),
        liquidityRegime,
        liquidityScore: round(liquidityScore, 3),
        rawBasePct: round(rawBasePct, 3),
        basePct: round(basePct, 3),
        actualPct: round(actualPct, 3),
        currentPreheatBiasPct: round(currentPreheatBiasPct, 3),
        suggestedBiasPct: round(suggestedBiasPct, 3),
        paramGapPct: round(paramGapPct, 3),
        baseErrorPct: round(actualPct - basePct, 3),
        currentBiasForecastPct: round(basePct + currentPreheatBiasPct, 3),
        currentBiasErrorPct: round(actualPct - (basePct + currentPreheatBiasPct), 3),
        directionHit: directionHit(basePct + currentPreheatBiasPct, actualPct)
      });
    });
  }

  console.log(`[SYMBOL_DONE] ${symbol} bars=${bars.length} rows=${rows.length}`);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);

  const options = {
    symbols: splitSymbols(args.symbols),
    start: args.start || '20180101',
    end: args.end || '20260601',
    market: args.market || 'CN_A',
    warmup: Math.max(60, Number(args.warmup || 160)),
    step: Math.max(1, Number(args.step || 20)),
    maxPerSymbol: Math.max(1, Number(args.max || 80)),
    forecastDays: Math.max(20, Number(args.forecastDays || 20)),
    maxSamples: Math.max(30, Number(args.maxSamples || 160)),
    minGroup: Math.max(1, Number(args.minGroup || 20))
  };

  console.log('[AMPLITUDE_TUNE_OPTIONS]');
  console.log(JSON.stringify(options, null, 2));

  const allRows = [];
  const failures = [];

  for (const symbol of options.symbols) {
    try {
      const rows = await validateSymbol(symbol, options);
      allRows.push(...rows);
    } catch (error) {
      failures.push({
        symbol,
        error: error && error.message ? error.message : String(error)
      });
      console.error(`[FAIL] ${symbol}`, error && error.stack ? error.stack : error);
    }
  }

  const byShapeDay = summarizeGroup(allRows, ['shape', 'shapeLabel', 'day'])
    .filter((row) => row.count >= options.minGroup);

  const byShapeLiquidityDay = summarizeGroup(allRows, ['shape', 'liquidityRegime', 'day'])
    .filter((row) => row.count >= options.minGroup);

  const byStateDay = summarizeGroup(allRows, ['stateCode', 'day'])
    .filter((row) => row.count >= options.minGroup);

  const outputDir = path.join(process.cwd(), 'data', 'validation', 'node-amplitude');
  fs.mkdirSync(outputDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = path.join(outputDir, `amplitude-rows-${stamp}.jsonl`);
  const shapePath = path.join(outputDir, `amplitude-by-shape-day-${stamp}.json`);
  const shapeCsvPath = path.join(outputDir, `amplitude-by-shape-day-${stamp}.csv`);
  const shapeLiquidityPath = path.join(outputDir, `amplitude-by-shape-liquidity-day-${stamp}.json`);
  const statePath = path.join(outputDir, `amplitude-by-state-day-${stamp}.json`);

  fs.writeFileSync(rawPath, allRows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  fs.writeFileSync(shapePath, JSON.stringify(byShapeDay, null, 2), 'utf8');
  fs.writeFileSync(shapeCsvPath, toCsv(byShapeDay), 'utf8');
  fs.writeFileSync(shapeLiquidityPath, JSON.stringify(byShapeLiquidityDay, null, 2), 'utf8');
  fs.writeFileSync(statePath, JSON.stringify(byStateDay, null, 2), 'utf8');

  console.log('\n[TUNE_BY_SHAPE_DAY]');
  console.table(byShapeDay.slice(0, 40));

  console.log('\n[TUNE_BY_SHAPE_LIQUIDITY_DAY]');
  console.table(byShapeLiquidityDay.slice(0, 40));

  console.log('\n[TUNE_BY_STATE_DAY]');
  console.table(byStateDay.slice(0, 30));

  console.log('\n[OUTPUT]');
  console.log(JSON.stringify({
    rawPath,
    shapePath,
    shapeCsvPath,
    shapeLiquidityPath,
    statePath,
    totalRows: allRows.length,
    failures
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
