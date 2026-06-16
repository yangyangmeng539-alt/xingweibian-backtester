'use strict';

const PREHEAT_PATH_SHAPES = Object.freeze({
  TREND: 'TREND',
  PULSE: 'PULSE',
  DECAY: 'DECAY',
  FAIL: 'FAIL',
  MIXED: 'MIXED'
});

function roundNumber(value, digits = 3) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const valid = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (!valid.length) {
    return null;
  }

  const middle = (valid.length - 1) / 2;
  const left = Math.floor(middle);
  const right = Math.ceil(middle);

  if (left === right) {
    return valid[left];
  }

  return (valid[left] + valid[right]) / 2;
}

function getNearestPathReturn(path, day) {
  const points = (Array.isArray(path) ? path : [])
    .map((point) => ({
      day: Number(point && point.day),
      returnPct: safeNumber(point && point.returnPct)
    }))
    .filter((point) => Number.isFinite(point.day) && point.returnPct !== null)
    .sort((left, right) => Math.abs(left.day - day) - Math.abs(right.day - day));

  return points.length ? points[0].returnPct : null;
}

function summarizePathShape(path) {
  const points = (Array.isArray(path) ? path : [])
    .map((point) => ({
      day: Number(point && point.day),
      returnPct: safeNumber(point && point.returnPct)
    }))
    .filter((point) => Number.isFinite(point.day) && point.returnPct !== null);

  if (points.length < 5) {
    return {
      shape: PREHEAT_PATH_SHAPES.MIXED,
      reason: '样本路径不足'
    };
  }

  const early = points.filter((point) => point.day <= 5).map((point) => point.returnPct);
  const mid = points.filter((point) => point.day > 5 && point.day <= 10).map((point) => point.returnPct);
  const late = points.filter((point) => point.day > 10).map((point) => point.returnPct);

  const d3 = getNearestPathReturn(points, 3);
  const d5 = getNearestPathReturn(points, 5);
  const d10 = getNearestPathReturn(points, 10);
  const d20 = getNearestPathReturn(points, 20);

  const safeD3 = d3 === null ? 0 : d3;
  const safeD5 = d5 === null ? safeD3 : d5;
  const safeD10 = d10 === null ? safeD5 : d10;
  const safeD20 = d20 === null ? safeD10 : d20;

  const maxEarly = early.length ? Math.max(...early) : Math.max(safeD3, safeD5);
  const maxAll = points.length ? Math.max(...points.map((point) => point.returnPct)) : maxEarly;
  const minAll = points.length ? Math.min(...points.map((point) => point.returnPct)) : Math.min(safeD10, safeD20);
  const midMedian = median(mid);
  const lateMedian = median(late);

  const safeMidMedian = midMedian === null ? safeD10 : midMedian;
  const safeLateMedian = lateMedian === null ? safeD20 : lateMedian;

  if (
    maxEarly >= 1.2
    && maxEarly >= safeD20 + 1.0
    && (safeD10 <= maxEarly - 0.8 || safeLateMedian <= maxEarly - 1.0)
  ) {
    return {
      shape: PREHEAT_PATH_SHAPES.PULSE,
      reason: '前段冲高后回落'
    };
  }

  if (
    safeD20 >= 1.5
    && safeD10 >= safeD5 - 0.8
    && safeD20 >= safeD10 - 0.8
    && minAll > -4.5
  ) {
    return {
      shape: PREHEAT_PATH_SHAPES.TREND,
      reason: '路径逐步抬升'
    };
  }

  if (
    maxAll <= 0.9
    && safeD10 <= -0.6
    && safeD20 <= -1.0
  ) {
    return {
      shape: PREHEAT_PATH_SHAPES.FAIL,
      reason: '未有效上冲并走弱'
    };
  }

  if (
    maxEarly >= 0.5
    && (safeMidMedian < 0 || safeD20 < -0.5)
  ) {
    return {
      shape: PREHEAT_PATH_SHAPES.DECAY,
      reason: '弱反抽后衰减'
    };
  }

  return {
    shape: PREHEAT_PATH_SHAPES.MIXED,
    reason: '样本路径分歧'
  };
}

function countByShape(samplePaths) {
  const counts = {
    TREND: 0,
    PULSE: 0,
    DECAY: 0,
    FAIL: 0,
    MIXED: 0
  };

  (Array.isArray(samplePaths) ? samplePaths : []).forEach((path) => {
    const result = summarizePathShape(path);
    counts[result.shape] = (counts[result.shape] || 0) + 1;
  });

  return counts;
}

function getDominantShape(counts, sampleCount) {
  const entries = Object.entries(counts || {})
    .filter(([shape]) => shape !== PREHEAT_PATH_SHAPES.MIXED)
    .sort((left, right) => right[1] - left[1]);

  const top = entries[0] || [PREHEAT_PATH_SHAPES.MIXED, 0];
  const mixedCount = Number(counts && counts.MIXED) || 0;
  const topRate = sampleCount > 0 ? top[1] / sampleCount : 0;

  if (sampleCount < 8 || topRate < 0.34 || top[1] <= mixedCount * 0.72) {
    return PREHEAT_PATH_SHAPES.MIXED;
  }

  return top[0];
}

function calcRecentReturnPct(bars, endIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(endIndex)) {
    return null;
  }

  const startIndex = endIndex - Number(days);

  if (startIndex < 0 || !bars[startIndex] || !bars[endIndex]) {
    return null;
  }

  const startClose = safeNumber(bars[startIndex].close);
  const endClose = safeNumber(bars[endIndex].close);

  if (startClose === null || endClose === null || startClose <= 0 || endClose <= 0) {
    return null;
  }

  return ((endClose - startClose) / startClose) * 100;
}

function calcVolumeRatio(bars, endIndex, shortDays = 5, longDays = 20) {
  if (!Array.isArray(bars) || !Number.isInteger(endIndex) || endIndex < longDays) {
    return null;
  }

  const shortValues = bars
    .slice(Math.max(0, endIndex - shortDays + 1), endIndex + 1)
    .map((bar) => safeNumber(bar && (bar.volume ?? bar.vol)))
    .filter((value) => value !== null && value > 0);

  const longValues = bars
    .slice(Math.max(0, endIndex - longDays + 1), endIndex + 1)
    .map((bar) => safeNumber(bar && (bar.volume ?? bar.vol)))
    .filter((value) => value !== null && value > 0);

  if (!shortValues.length || !longValues.length) {
    return null;
  }

  const shortAvg = shortValues.reduce((sum, value) => sum + value, 0) / shortValues.length;
  const longAvg = longValues.reduce((sum, value) => sum + value, 0) / longValues.length;

  return longAvg > 0 ? shortAvg / longAvg : null;
}

function addCurveBiasPct(baseCurve, extraCurve = {}) {
  const base = baseCurve && typeof baseCurve === 'object' ? baseCurve : {};
  const extra = extraCurve && typeof extraCurve === 'object' ? extraCurve : {};

  return {
    d3: roundNumber((Number(base.d3) || 0) + (Number(extra.d3) || 0), 2),
    d5: roundNumber((Number(base.d5) || 0) + (Number(extra.d5) || 0), 2),
    d10: roundNumber((Number(base.d10) || 0) + (Number(extra.d10) || 0), 2),
    d20: roundNumber((Number(base.d20) || 0) + (Number(extra.d20) || 0), 2)
  };
}

function getShapeLiquidityCurveBiasPct(shape, liquidityAnalysis) {
  const regime = String(liquidityAnalysis && liquidityAnalysis.regime ? liquidityAnalysis.regime : '');

  if (regime !== 'LIQUIDITY_SLIGHT_SUPPORT') {
    return { d3: 0, d5: 0, d10: 0, d20: 0 };
  }

  if (shape === PREHEAT_PATH_SHAPES.PULSE) {
    return {
      d3: 0,
      d5: 0,
      d10: 0.75,
      d20: 2.65
    };
  }

  if (shape === PREHEAT_PATH_SHAPES.MIXED) {
    return {
      d3: 0,
      d5: 0,
      d10: 0.6,
      d20: 2.2
    };
  }

  if (shape === PREHEAT_PATH_SHAPES.DECAY) {
    return {
      d3: 0,
      d5: 0,
      d10: 0.35,
      d20: 1.15
    };
  }

  return { d3: 0, d5: 0, d10: 0, d20: 0 };
}

function getCurrentStateCode(currentState) {
  if (!currentState) return 'UNKNOWN_STATE';

  if (typeof currentState === 'string') {
    return currentState || 'UNKNOWN_STATE';
  }

  return String(
    currentState.stateCode ||
    currentState.code ||
    currentState.type ||
    currentState.name ||
    'UNKNOWN_STATE'
  );
}

function getShapeStateCurveBiasPct(shape, currentState, liquidityAnalysis) {
  if (shape !== PREHEAT_PATH_SHAPES.FAIL) {
    return { d3: 0, d5: 0, d10: 0, d20: 0 };
  }

  const stateCode = getCurrentStateCode(currentState);
  const regime = String(liquidityAnalysis && liquidityAnalysis.regime ? liquidityAnalysis.regime : '');

  if (stateCode === 'LOW_STARTING') {
    if (regime === 'LIQUIDITY_NEUTRAL') {
      return { d3: 0.12, d5: 0.35, d10: 0.8, d20: 3.2 };
    }

    if (regime === 'LIQUIDITY_SLIGHT_SUPPORT') {
      return { d3: 0.08, d5: 0.25, d10: 0.55, d20: 2.0 };
    }

    return { d3: 0.08, d5: 0.25, d10: 0.6, d20: 2.4 };
  }

  if (stateCode === 'MID_TREND_CONTINUING') {
    if (regime === 'LIQUIDITY_NEUTRAL') {
      return { d3: 0.08, d5: 0.25, d10: 0.6, d20: 2.0 };
    }

    if (regime === 'LIQUIDITY_SLIGHT_SUPPORT') {
      return { d3: 0, d5: 0.1, d10: 0.25, d20: 0.7 };
    }

    return { d3: 0.04, d5: 0.15, d10: 0.4, d20: 1.2 };
  }

  if (stateCode === 'BREAKDOWN_RISK') {
    return { d3: -0.05, d5: -0.15, d10: -0.35, d20: -0.8 };
  }

  if (stateCode === 'HIGH_CHASE_RISK') {
    return { d3: -0.15, d5: -0.4, d10: -0.9, d20: -3.0 };
  }

  return { d3: 0, d5: 0, d10: 0, d20: 0 };
}
function getCurveBiasPct(shape, liquidityAnalysis = null, currentState = null) {
  let baseCurve = { d3: -0.13, d5: -0.03, d10: 0.1, d20: 1.1 };

  if (shape === PREHEAT_PATH_SHAPES.TREND) {
    baseCurve = { d3: -1.15, d5: -1.5, d10: -2.45, d20: -3.5 };
  } else if (shape === PREHEAT_PATH_SHAPES.PULSE) {
    baseCurve = { d3: 0.42, d5: 0.48, d10: 0.82, d20: 3.35 };
  } else if (shape === PREHEAT_PATH_SHAPES.DECAY) {
    baseCurve = { d3: 0, d5: 0, d10: 0.38, d20: 0.45 };
  } else if (shape === PREHEAT_PATH_SHAPES.FAIL) {
    baseCurve = { d3: 0.7, d5: 1.15, d10: 1.75, d20: 4.8 };
  }

  return addCurveBiasPct(addCurveBiasPct(baseCurve, getShapeLiquidityCurveBiasPct(shape, liquidityAnalysis)), getShapeStateCurveBiasPct(shape, currentState, liquidityAnalysis));
}

function getShapeLabel(shape) {
  return {
    TREND: '预热趋势型',
    PULSE: '预热脉冲型',
    DECAY: '预热衰减型',
    FAIL: '预热失败型',
    MIXED: '预热分歧型'
  }[shape] || '预热分歧型';
}

function buildPreheatPathShapePrediction(options = {}) {
  const predictionBars = Array.isArray(options.predictionBars) ? options.predictionBars : [];
  const clickedIndex = Number.isInteger(options.clickedIndex) ? options.clickedIndex : predictionBars.length - 1;
  const samplePaths = Array.isArray(options.samplePaths) ? options.samplePaths : [];
  const similarSamples = Array.isArray(options.similarSamples) ? options.similarSamples : [];
  const currentState = options.currentState || null;
  const liquidityAnalysis = options.liquidityAnalysis || null;
  const sampleCount = samplePaths.length;

  if (!currentState || sampleCount < 5) {
    return {
      ok: false,
      source: 'cutoff_safe_samples_and_t0_features',
      reason: 'NO_ENOUGH_CUTOFF_SAFE_SAMPLES',
      shape: PREHEAT_PATH_SHAPES.MIXED,
      label: getShapeLabel(PREHEAT_PATH_SHAPES.MIXED),
      confidence: 0,
      sampleCount,
      curveBiasPct: getCurveBiasPct(PREHEAT_PATH_SHAPES.MIXED, liquidityAnalysis, currentState),
      reasonParts: ['T0前同类样本不足，不能做预热路径分型']
    };
  }

  const counts = countByShape(samplePaths);
  let shape = getDominantShape(counts, sampleCount);
  const topCount = Number(counts[shape]) || 0;
  const topRate = sampleCount > 0 ? topCount / sampleCount : 0;

  const recent3 = calcRecentReturnPct(predictionBars, clickedIndex, 3);
  const recent5 = calcRecentReturnPct(predictionBars, clickedIndex, 5);
  const recent10 = calcRecentReturnPct(predictionBars, clickedIndex, 10);
  const volumeRatio = calcVolumeRatio(predictionBars, clickedIndex, 5, 20);

  const t0Impulse = (
    (recent3 !== null && recent3 >= 4.5)
    || (recent5 !== null && recent5 >= 7)
    || (volumeRatio !== null && volumeRatio >= 1.65)
  );

  const t0WeakFade = (
    (recent5 !== null && recent5 <= -3.5)
    || (recent10 !== null && recent10 <= -5.5)
  );

  const reasonParts = [
    `截止T0安全样本 ${sampleCount}`,
    `样本分型 TREND=${counts.TREND} / PULSE=${counts.PULSE} / DECAY=${counts.DECAY} / FAIL=${counts.FAIL} / MIXED=${counts.MIXED}`
  ];

  if (
    t0Impulse
    && [PREHEAT_PATH_SHAPES.TREND, PREHEAT_PATH_SHAPES.MIXED].includes(shape)
    && (counts.PULSE || 0) >= Math.max(3, (counts.TREND || 0) * 0.55)
  ) {
    shape = PREHEAT_PATH_SHAPES.PULSE;
    reasonParts.push('T0前短窗放量/急拉，预热更偏脉冲而非平滑趋势');
  }

  if (
    t0WeakFade
    && [PREHEAT_PATH_SHAPES.PULSE, PREHEAT_PATH_SHAPES.MIXED].includes(shape)
    && (counts.DECAY + counts.FAIL) >= Math.max(3, counts.PULSE || 0)
  ) {
    shape = PREHEAT_PATH_SHAPES.DECAY;
    reasonParts.push('T0前已转弱，预热更偏衰减');
  }

  if (shape === PREHEAT_PATH_SHAPES.TREND) {
    reasonParts.push('同类历史样本更偏逐步抬升');
  } else if (shape === PREHEAT_PATH_SHAPES.PULSE) {
    reasonParts.push('同类历史样本更偏先冲后落');
  } else if (shape === PREHEAT_PATH_SHAPES.DECAY) {
    reasonParts.push('同类历史样本更偏弱反抽后衰减');
  } else if (shape === PREHEAT_PATH_SHAPES.FAIL) {
    reasonParts.push('同类历史样本更偏预热失败');
  } else {
    reasonParts.push('同类历史样本路径分歧，保持中性');
  }

  reasonParts.push(`T0前特征 R3=${roundNumber(recent3, 2)} / R5=${roundNumber(recent5, 2)} / R10=${roundNumber(recent10, 2)} / VOL5_20=${roundNumber(volumeRatio, 2)}`);

  const sampleReliability = clamp(sampleCount / 80, 0.25, 1);
  const shapeRate = shape === PREHEAT_PATH_SHAPES.MIXED ? 0.28 : topRate;
  const confidence = roundNumber(clamp(shapeRate * 0.72 + sampleReliability * 0.28, 0, 1), 3);

  return {
    ok: true,
    source: 'cutoff_safe_samples_and_t0_features',
    cutoffSafe: true,
    shape,
    label: getShapeLabel(shape),
    confidence,
    sampleCount,
    similarSampleCount: similarSamples.length,
    counts,
    recentFeature: {
      recent3ReturnPct: roundNumber(recent3, 3),
      recent5ReturnPct: roundNumber(recent5, 3),
      recent10ReturnPct: roundNumber(recent10, 3),
      volumeRatio5To20: roundNumber(volumeRatio, 3)
    },
    curveBiasPct: getCurveBiasPct(shape, liquidityAnalysis, currentState),
    reasonParts
  };
}

module.exports = {
  PREHEAT_PATH_SHAPES,
  buildPreheatPathShapePrediction
};













