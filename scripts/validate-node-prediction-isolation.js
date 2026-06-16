'use strict';

const assert = require('assert');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

const FORECAST_DAYS = 20;
const CLICKED_INDEX = 49;
const CLICKED_DATE = toDateKey(CLICKED_INDEX);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDateKey(index) {
  const date = new Date(Date.UTC(2024, 0, 1 + Number(index || 0)));
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  return `${year}-${month}-${day}`;
}

function round(value, digits = 4) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function makeBars(mode = 'base') {
  const bars = [];
  let close = 10;

  for (let index = 0; index < 80; index += 1) {
    const beforeT0 = index <= CLICKED_INDEX;
    const wave = Math.sin(index / 3) * 0.12;
    close += 0.05 + wave;

    let finalClose = close;

    if (!beforeT0) {
      if (mode === 'future_up') {
        finalClose = close * (1 + (index - CLICKED_INDEX) * 0.18);
      } else if (mode === 'future_down') {
        finalClose = close * Math.max(0.12, 1 - (index - CLICKED_INDEX) * 0.16);
      } else if (mode === 'future_noise') {
        finalClose = close * (index % 2 === 0 ? 2.4 : 0.35);
      }
    }

    bars.push({
      date: toDateKey(index),
      open: round(finalClose * 0.99),
      high: round(finalClose * 1.03),
      low: round(finalClose * 0.97),
      close: round(finalClose),
      volume: 100000 + index * 1000,
      amount: round(finalClose * (100000 + index * 1000))
    });
  }

  if (mode === 'future_deleted') {
    return bars.slice(0, CLICKED_INDEX + 1);
  }

  return bars;
}

function makeDailyStates() {
  const states = [];

  for (let index = 0; index <= CLICKED_INDEX; index += 1) {
    const sameCluster = index <= 29 || index === CLICKED_INDEX;

    states.push({
      date: toDateKey(index),
      stateCode: sameCluster ? 'LOW_STARTING' : 'PULLBACK_REPAIR',
      stateName: sameCluster ? '低位启动' : '回踩修复',
      stateSummary: sameCluster ? 'T0 前结构预热测试样本' : '其它样本',
      shape: {
        type: sameCluster ? 'VOLUME_BREAKOUT' : 'SHRINK_PULLBACK',
        score: sameCluster ? 72 : 48
      },
      position: {
        type: sameCluster ? 'LOW_AREA' : 'MID_AREA',
        score: sameCluster ? 66 : 52
      },
      change: {
        type: sameCluster ? 'STRENGTHENING' : 'PULLBACK_STABLE',
        score: sameCluster ? 68 : 50
      },

      // 故意放污染字段：
      // 核心预判必须剥离 futureReturns，不能让它影响黄线/分位带/路径预判。
      futureReturns: {
        future5ReturnPct: index % 2 === 0 ? 999 : -999,
        future10ReturnPct: index % 2 === 0 ? 888 : -888,
        future20ReturnPct: index % 2 === 0 ? 777 : -777
      }
    });
  }

  return states;
}

function stableClone(value) {
  if (Array.isArray(value)) {
    return value.map(stableClone);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableClone(value[key]);
      return result;
    }, {});
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableClone(value));
}

function pickPredictionSignature(result) {
  return stableClone({
    ok: result.ok,
    clickedDate: result.clickedDate,
    forecastDays: result.forecastDays,
    currentNode: result.currentNode,
    similarSampleCount: result.similarSampleCount,
    similarSamples: result.similarSamples,
    baselineFuturePathStats: result.baselineFuturePathStats,
    futurePathStats: result.futurePathStats,
    horizonSummary: result.horizonSummary,
    pathRisk: result.pathRisk,
    liquidityAnalysis: result.liquidityAnalysis,
    liquidityEnhancedPrediction: result.liquidityEnhancedPrediction,
    rapidTypePrediction: result.rapidTypePrediction,
    forecastMilestones: result.forecastMilestones,
    predictionText: result.predictionText,

    // 下一步加预热分型后，也会自动纳入防泄露测试。
    preheatPathShapePrediction: result.preheatPathShapePrediction || null,

    calculationIsolation: {
      enabled: result.calculationIsolation && result.calculationIsolation.enabled,
      cutoffDate: result.calculationIsolation && result.calculationIsolation.cutoffDate,
      predictionBarCount: result.calculationIsolation && result.calculationIsolation.predictionBarCount,
      predictionBarEndDate: result.calculationIsolation && result.calculationIsolation.predictionBarEndDate
    }
  });
}

function runCase(mode) {
  return buildNodePredictionAnalysis({
    symbol: 'TEST001',
    market: 'CN_A',
    bars: makeBars(mode),
    dailyStates: makeDailyStates(),
    clickedDate: CLICKED_DATE,
    forecastDays: FORECAST_DAYS,
    maxSamples: 160
  });
}

function main() {
  const base = runCase('base');
  const baseSignature = pickPredictionSignature(base);
  const baseText = stableStringify(baseSignature);

  assert.strictEqual(base.ok, true, 'baseline should be ok');
  assert.strictEqual(base.calculationIsolation.enabled, true, 'calculation isolation must be enabled');
  assert.strictEqual(base.calculationIsolation.predictionBarEndDate, CLICKED_DATE, 'prediction bars must end at T0');

  const modes = [
    'future_up',
    'future_down',
    'future_noise',
    'future_deleted'
  ];

  const passed = [];

  for (const mode of modes) {
    const result = runCase(mode);
    const text = stableStringify(pickPredictionSignature(result));

    if (text !== baseText) {
      console.error(`[FAIL] ${mode} changed prediction signature`);
      console.error('BASE:', JSON.stringify(baseSignature, null, 2));
      console.error('CASE:', JSON.stringify(pickPredictionSignature(result), null, 2));
      process.exit(1);
    }

    passed.push(mode);
  }

  console.log(JSON.stringify({
    ok: true,
    clickedDate: CLICKED_DATE,
    forecastDays: FORECAST_DAYS,
    rule: 'Mutating/deleting bars after T0 must not change yellow-line prediction fields.',
    ignoredActualOnlyFields: [
      'actualFuturePath',
      'actualComparison',
      'actualComparisonSummary',
      'actualPathSummary',
      'rapidChangeAnalysis'
    ],
    checkedModes: passed,
    similarSampleCount: base.similarSampleCount,
    predictionBarCount: base.calculationIsolation.predictionBarCount,
    predictionBarEndDate: base.calculationIsolation.predictionBarEndDate
  }, null, 2));
}

main();