const { STATE_NAMES } = require('./xwbStateClassifier');
const {
  buildActualPathSummary,
  buildForecastMilestones
} = require('./futurePathAnalysisService');

const {
  buildRapidChangeAnalysisFromBars
} = require('./rapidChangeAnalysisService');

const {
  buildRapidTypePredictionFromBars
} = require('./rapidTypePredictorService');

const {
  buildLiquidityFactorAnalysisFromBars,
  buildLiquidityEnhancedPrediction,
  applyLiquidityAdjustmentToFuturePathStats
} = require('./liquidityFactorService');

const {
  buildPreheatPathShapePrediction
} = require('./preheatPathShapePredictorService');

const XWB_NODE_PREDICTION_VERSION = 'xwb-node-prediction';

const DEFAULT_FORECAST_DAYS = 20;
const DEFAULT_MAX_SAMPLES = 160;

function roundNumber(value, digits = 2) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }

  const num = Number(value);

  if (!Number.isFinite(num)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getStateName(stateCode) {
  return STATE_NAMES[stateCode] || STATE_NAMES.UNKNOWN_STATE || '未明确状态';
}

function percentile(values, p) {
  const valid = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!valid.length) {
    return null;
  }

  const index = (valid.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return valid[lower];
  }

  const weight = index - lower;
  return valid[lower] * (1 - weight) + valid[upper] * weight;
}

function average(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));

  if (!valid.length) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function rate(values, predicate) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));

  if (!valid.length) {
    return null;
  }

  return (valid.filter(predicate).length / valid.length) * 100;
}

function getReturnPct(baseClose, futureClose) {
  const base = safeNumber(baseClose);
  const future = safeNumber(futureClose);

  if (base === null || future === null || base <= 0 || future <= 0) {
    return null;
  }

  const result = ((future - base) / base) * 100;

  if (!Number.isFinite(result)) {
    return null;
  }

  if (Math.abs(result) > 200) {
    return null;
  }

  return result;
}

function buildBarIndexMap(bars) {
  const map = new Map();

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];

    if (bar && bar.date) {
      map.set(String(bar.date), index);
    }
  }

  return map;
}

function buildStateMap(dailyStates) {
  const map = new Map();

  for (const item of Array.isArray(dailyStates) ? dailyStates : []) {
    if (item && item.date) {
      map.set(String(item.date), item);
    }
  }

  return map;
}

function getLatestValidDate(bars) {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index];

    if (bar && bar.date) {
      return bar.date;
    }
  }

  return '';
}

function normalizeDateKey(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10).replace(/-/g, '');
  }

  if (/^\d{8}$/.test(text)) {
    return text;
  }

  return text.replace(/-/g, '');
}

function isDateOnOrBefore(value, cutoffDate) {
  const dateKey = normalizeDateKey(value);
  const cutoffKey = normalizeDateKey(cutoffDate);

  return Boolean(dateKey && cutoffKey && dateKey <= cutoffKey);
}

function filterBarsThroughDate(bars, cutoffDate) {
  return (Array.isArray(bars) ? bars : []).filter((bar) => {
    const date = bar && (bar.date || bar.trade_date);
    return isDateOnOrBefore(date, cutoffDate);
  });
}

function stripFutureReturnFields(state) {
  if (!state || typeof state !== 'object') {
    return state;
  }

  const clone = { ...state };
  delete clone.futureReturns;
  return clone;
}

function filterDailyStatesThroughDate(dailyStates, cutoffDate) {
  return (Array.isArray(dailyStates) ? dailyStates : [])
    .filter((state) => state && state.date && isDateOnOrBefore(state.date, cutoffDate))
    .map(stripFutureReturnFields);
}

function assertNoFutureBarsForPrediction(bars, cutoffDate) {
  const cutoffKey = normalizeDateKey(cutoffDate);

  if (!cutoffKey) {
    return;
  }

  const leak = (Array.isArray(bars) ? bars : []).find((bar) => {
    const date = bar && (bar.date || bar.trade_date);
    const dateKey = normalizeDateKey(date);
    return dateKey && dateKey > cutoffKey;
  });

  if (leak) {
    throw new Error(`??????????K??${leak.date || leak.trade_date} > T0 ${cutoffDate}`);
  }
}

function assertNoFutureSamplesForPrediction(samples, bars, forecastDays, clickedIndex, clickedDate) {
  if (!Array.isArray(samples) || !Array.isArray(bars) || !Number.isInteger(clickedIndex)) {
    return;
  }

  for (const sample of samples) {
    const endIndex = Number(sample && sample.sampleIndex) + Number(forecastDays || DEFAULT_FORECAST_DAYS);

    if (!Number.isInteger(endIndex) || endIndex > clickedIndex) {
      throw new Error(`????????T0?${sample && sample.sampleDate} + ${forecastDays} > ${clickedDate}`);
    }

    const endBar = bars[endIndex];

    if (endBar && endBar.date && !isDateOnOrBefore(endBar.date, clickedDate)) {
      throw new Error(`????????????T0?${sample && sample.sampleDate} -> ${endBar.date} > ${clickedDate}`);
    }
  }
}

function getShapeType(state) {
  return state && state.shape && state.shape.type ? state.shape.type : 'UNKNOWN_SHAPE';
}

function getPositionType(state) {
  return state && state.position && state.position.type ? state.position.type : 'MID_AREA';
}

function getChangeType(state) {
  return state && state.change && state.change.type ? state.change.type : 'UNKNOWN_CHANGE';
}

function getStageScore(stage) {
  const value = safeNumber(stage && stage.score);
  return value === null ? 0 : clamp(value, 0, 100);
}

function calcSimilarity(currentState, sampleState) {
  if (!currentState || !sampleState) {
    return 0;
  }

  let score = 0;

  const currentStateCode = currentState.stateCode || 'UNKNOWN_STATE';
  const sampleStateCode = sampleState.stateCode || 'UNKNOWN_STATE';
  const currentShape = getShapeType(currentState);
  const sampleShape = getShapeType(sampleState);
  const currentPosition = getPositionType(currentState);
  const samplePosition = getPositionType(sampleState);
  const currentChange = getChangeType(currentState);
  const sampleChange = getChangeType(sampleState);

  if (currentStateCode === sampleStateCode) score += 50;
  if (currentShape === sampleShape) score += 15;
  if (currentPosition === samplePosition) score += 15;
  if (currentChange === sampleChange) score += 20;

  const currentShapeScore = getStageScore(currentState.shape);
  const sampleShapeScore = getStageScore(sampleState.shape);
  const currentPositionScore = getStageScore(currentState.position);
  const samplePositionScore = getStageScore(sampleState.position);
  const currentChangeScore = getStageScore(currentState.change);
  const sampleChangeScore = getStageScore(sampleState.change);

  score += Math.max(0, 10 - Math.abs(currentShapeScore - sampleShapeScore) / 10);
  score += Math.max(0, 10 - Math.abs(currentPositionScore - samplePositionScore) / 10);
  score += Math.max(0, 10 - Math.abs(currentChangeScore - sampleChangeScore) / 10);

  return roundNumber(clamp(score, 0, 120));
}

function buildSamplePath(sample, bars, forecastDays) {
  const baseBar = bars[sample.sampleIndex];
  const baseClose = safeNumber(baseBar && baseBar.close);

  if (baseClose === null || baseClose <= 0) {
    return [];
  }

  const path = [];

  for (let day = 1; day <= forecastDays; day += 1) {
    const futureBar = bars[sample.sampleIndex + day];

    if (!futureBar) {
      break;
    }

    const value = getReturnPct(baseClose, futureBar.close);

    if (value === null) {
      path.push({
        day,
        date: futureBar.date,
        returnPct: null
      });
    } else {
      path.push({
        day,
        date: futureBar.date,
        returnPct: roundNumber(value)
      });
    }
  }

  return path;
}

function buildActualFuturePath(bars, clickedIndex, forecastDays) {
  const clickedBar = bars[clickedIndex];
  const baseClose = safeNumber(clickedBar && clickedBar.close);

  if (baseClose === null || baseClose <= 0) {
    return [];
  }

  const path = [];

  for (let day = 1; day <= forecastDays; day += 1) {
    const futureBar = bars[clickedIndex + day];

    if (!futureBar) {
      path.push({
        day,
        date: '',
        close: null,
        returnPct: null,
        exists: false
      });
      continue;
    }

    path.push({
      day,
      date: futureBar.date,
      close: roundNumber(futureBar.close),
      returnPct: roundNumber(getReturnPct(baseClose, futureBar.close)),
      exists: true
    });
  }

  return path;
}

function getActualPoint(actualPath, day) {
  return actualPath.find((item) => item.day === day) || null;
}

function compareActualToForecast(horizonSummary, actualPath) {
  const result = {};

  for (const key of ['d5', 'd10', 'd20']) {
    const day = key === 'd5' ? 5 : key === 'd10' ? 10 : 20;
    const forecast = horizonSummary && horizonSummary[key] ? horizonSummary[key] : null;
    const actual = getActualPoint(actualPath, day);
    const actualReturn = actual && actual.exists !== false ? safeNumber(actual.returnPct) : null;

    if (!forecast || actualReturn === null) {
      result[key] = {
        day,
        hasActual: false,
        actualDate: actual && actual.exists !== false ? actual.date || '' : '',
        actualClose: actual && actual.exists !== false ? actual.close : null,
        actualReturnPct: null,
        forecastMedianPct: forecast ? forecast.medianReturnPct : null,
        forecastLowerQuartilePct: forecast ? forecast.lowerQuartileReturnPct : null,
        forecastUpperQuartilePct: forecast ? forecast.upperQuartileReturnPct : null,
        forecastMaxAdversePct: forecast ? forecast.maxAdverseReturnPct : null,
        forecastMaxFavorablePct: forecast ? forecast.maxFavorableReturnPct : null,
        directionMatched: null,
        inInterQuartileRange: null,
        inFullRange: null,
        medianDeviationPct: null,
        verdict: 'NO_ACTUAL_DATA'
      };
      continue;
    }

    const lowerQ = safeNumber(forecast.lowerQuartileReturnPct);
    const upperQ = safeNumber(forecast.upperQuartileReturnPct);
    const minValue = safeNumber(forecast.maxAdverseReturnPct);
    const maxValue = safeNumber(forecast.maxFavorableReturnPct);
    const median = safeNumber(forecast.medianReturnPct);

    const forecastDirection = median !== null && median > 0
      ? 'UP'
      : median !== null && median < 0
        ? 'DOWN'
        : 'NEUTRAL';

    const actualDirection = actualReturn > 0
      ? 'UP'
      : actualReturn < 0
        ? 'DOWN'
        : 'NEUTRAL';

    const directionMatched = forecastDirection === 'NEUTRAL'
      ? Math.abs(actualReturn) <= 3
      : forecastDirection === actualDirection;

    const inInterQuartileRange = lowerQ !== null && upperQ !== null
      ? actualReturn >= lowerQ && actualReturn <= upperQ
      : null;

    const inFullRange = minValue !== null && maxValue !== null
      ? actualReturn >= minValue && actualReturn <= maxValue
      : null;

    let verdict = 'MISS';

    if (directionMatched && inInterQuartileRange) {
      verdict = 'STRONG_MATCH';
    } else if (directionMatched && inFullRange) {
      verdict = 'BASIC_MATCH';
    } else if (inFullRange) {
      verdict = 'RANGE_MATCH_DIRECTION_MISS';
    } else {
      verdict = 'OUT_OF_RANGE';
    }

    result[key] = {
      day,
      hasActual: true,
      actualDate: actual.date,
      actualClose: actual.close,
      actualReturnPct: actualReturn,
      forecastMedianPct: median,
      forecastLowerQuartilePct: lowerQ,
      forecastUpperQuartilePct: upperQ,
      forecastMaxAdversePct: minValue,
      forecastMaxFavorablePct: maxValue,
      forecastDirection,
      actualDirection,
      directionMatched,
      inInterQuartileRange,
      inFullRange,
      medianDeviationPct: median === null ? null : roundNumber(actualReturn - median),
      verdict
    };
  }

  return result;
}

function summarizeActualComparison(comparison) {
  const rows = Object.values(comparison || {});
  const actualRows = rows.filter((item) => item && item.hasActual);

  if (!actualRows.length) {
    return {
      actualCount: 0,
      strongMatchCount: 0,
      basicMatchCount: 0,
      rangeMatchCount: 0,
      directionMatchCount: 0,
      overallVerdict: 'NO_ACTUAL_DATA'
    };
  }

  const strongMatchCount = actualRows.filter((item) => item.verdict === 'STRONG_MATCH').length;
  const basicMatchCount = actualRows.filter((item) => item.verdict === 'BASIC_MATCH').length;
  const rangeMatchCount = actualRows.filter((item) => item.inFullRange).length;
  const directionMatchCount = actualRows.filter((item) => item.directionMatched).length;

  let overallVerdict = 'MISS';

  if (strongMatchCount >= 2) {
    overallVerdict = 'STRONG_MATCH';
  } else if (basicMatchCount + strongMatchCount >= 2) {
    overallVerdict = 'BASIC_MATCH';
  } else if (rangeMatchCount >= 2) {
    overallVerdict = 'RANGE_MATCH';
  } else if (directionMatchCount >= 2) {
    overallVerdict = 'DIRECTION_ONLY_MATCH';
  }

  return {
    actualCount: actualRows.length,
    strongMatchCount,
    basicMatchCount,
    rangeMatchCount,
    directionMatchCount,
    overallVerdict
  };
}

function summarizeDayPath(paths, forecastDays) {
  const result = [];

  for (let day = 1; day <= forecastDays; day += 1) {
    const values = [];

    for (const path of paths) {
      const point = path.find((item) => item.day === day);

      if (point && Number.isFinite(Number(point.returnPct))) {
        values.push(Number(point.returnPct));
      }
    }

    result.push({
      day,
      sampleCount: values.length,
      averageReturnPct: roundNumber(average(values)),
      medianReturnPct: roundNumber(percentile(values, 0.5)),
      lowerQuartileReturnPct: roundNumber(percentile(values, 0.25)),
      upperQuartileReturnPct: roundNumber(percentile(values, 0.75)),
      minReturnPct: roundNumber(percentile(values, 0)),
      maxReturnPct: roundNumber(percentile(values, 1)),
      positiveRatePct: roundNumber(rate(values, (value) => value > 0))
    });
  }

  return result;
}

function summarizeHorizon(pathStats, day) {
  const item = pathStats.find((row) => row.day === day);

  if (!item) {
    return {
      day,
      sampleCount: 0,
      upProbabilityPct: null,
      averageReturnPct: null,
      medianReturnPct: null,
      lowerQuartileReturnPct: null,
      upperQuartileReturnPct: null,
      maxAdverseReturnPct: null,
      maxFavorableReturnPct: null
    };
  }

  return {
    day,
    sampleCount: item.sampleCount,
    upProbabilityPct: item.positiveRatePct,
    averageReturnPct: item.averageReturnPct,
    medianReturnPct: item.medianReturnPct,
    lowerQuartileReturnPct: item.lowerQuartileReturnPct,
    upperQuartileReturnPct: item.upperQuartileReturnPct,
    maxAdverseReturnPct: item.minReturnPct,
    maxFavorableReturnPct: item.maxReturnPct
  };
}

function summarizePathRisk(paths) {
  const adverseValues = [];
  const favorableValues = [];

  for (const path of paths) {
    const returns = path
      .map((item) => safeNumber(item.returnPct))
      .filter((value) => value !== null);

    if (!returns.length) {
      continue;
    }

    adverseValues.push(Math.min(...returns));
    favorableValues.push(Math.max(...returns));
  }

  return {
    sampleCount: adverseValues.length,
    averageMaxAdversePct: roundNumber(average(adverseValues)),
    medianMaxAdversePct: roundNumber(percentile(adverseValues, 0.5)),
    worstMaxAdversePct: roundNumber(percentile(adverseValues, 0)),
    averageMaxFavorablePct: roundNumber(average(favorableValues)),
    medianMaxFavorablePct: roundNumber(percentile(favorableValues, 0.5)),
    bestMaxFavorablePct: roundNumber(percentile(favorableValues, 1))
  };
}

function getPredictionText(currentState, summary20) {
  const stateCode = currentState && currentState.stateCode ? currentState.stateCode : 'UNKNOWN_STATE';
  const shapeType = getShapeType(currentState);
  const positionType = getPositionType(currentState);
  const changeType = getChangeType(currentState);
  const upProbability = safeNumber(summary20 && summary20.upProbabilityPct);
  const medianReturn = safeNumber(summary20 && summary20.medianReturnPct);
  const maxAdverse = safeNumber(summary20 && summary20.maxAdverseReturnPct);

  if (stateCode === 'LOW_STARTING' || stateCode === 'PULLBACK_REPAIR') {
    if (upProbability !== null && upProbability >= 60 && medianReturn !== null && medianReturn > 0) {
      return '历史相似节点显示偏正向，属于值得重点观察的形位变状态。';
    }

    return '状态本身偏正向，但历史相似节点的后续分布仍需谨慎观察。';
  }

  if (stateCode === 'BREAKDOWN_RISK' || stateCode === 'LOW_WEAK_OBSERVE') {
    return '当前状态偏风险，历史相似节点不适合作为强机会判断。';
  }

  if (positionType === 'HIGH_AREA' && shapeType === 'UNKNOWN_SHAPE') {
    return '短期变化存在走强迹象，但形态不明且位置偏高，预判价值偏低。';
  }

  if (changeType === 'STRENGTHENING' && upProbability !== null && upProbability >= 55) {
    return '变化方向偏强，但仍需结合形态和位置确认，不能单独作为强预判。';
  }

  if (maxAdverse !== null && maxAdverse <= -20) {
    return '历史相似节点存在较大不利波动，当前更适合观察而非强判断。';
  }

  return '当前节点的历史相似分布未形成强预判，建议继续观察形位变是否进一步清晰。';
}

function buildCurrentNode(currentState, clickedBar) {
  const stateCode = currentState && currentState.stateCode ? currentState.stateCode : 'UNKNOWN_STATE';

  return {
    date: clickedBar ? clickedBar.date : '',
    close: clickedBar ? roundNumber(clickedBar.close) : null,
    stateCode,
    stateName: currentState && currentState.stateName ? currentState.stateName : getStateName(stateCode),
    stateSummary: currentState && currentState.stateSummary ? currentState.stateSummary : '',
    shape: currentState ? currentState.shape : null,
    position: currentState ? currentState.position : null,
    change: currentState ? currentState.change : null
  };
}

function buildSimilarSamples({
  bars,
  dailyStates,
  currentState,
  clickedIndex,
  forecastDays,
  maxSamples
}) {
  const barIndexMap = buildBarIndexMap(bars);
  const samples = [];

  for (const state of dailyStates) {
    if (!state || !state.date) {
      continue;
    }

    const sampleIndex = barIndexMap.get(String(state.date));

    if (!Number.isInteger(sampleIndex)) {
      continue;
    }

    /*
     * 时间隔离：
     * 样本的完整未来路径必须发生在 clickedDate 之前。
     * 不能用 clickedDate 之后的数据参与该节点预判。
     */
    if (sampleIndex + forecastDays > clickedIndex) {
      continue;
    }

    const similarityScore = calcSimilarity(currentState, state);

    if (similarityScore < 50) {
      continue;
    }

    const bar = bars[sampleIndex];

    samples.push({
      sampleDate: state.date,
      sampleIndex,
      close: roundNumber(bar && bar.close),
      stateCode: state.stateCode || 'UNKNOWN_STATE',
      stateName: state.stateName || getStateName(state.stateCode || 'UNKNOWN_STATE'),
      shapeType: getShapeType(state),
      positionType: getPositionType(state),
      changeType: getChangeType(state),
      similarityScore,
      pathEndDate: bars[sampleIndex + forecastDays] ? bars[sampleIndex + forecastDays].date : '',
      futureReturns: {},
      cutoffSafe: true
    });
  }

  return samples
    .sort((a, b) => {
      if (b.similarityScore !== a.similarityScore) {
        return b.similarityScore - a.similarityScore;
      }

      return b.sampleIndex - a.sampleIndex;
    })
    .slice(0, maxSamples);
}

function buildNodePredictionAnalysis(options) {
  const fullBars = Array.isArray(options && options.bars) ? options.bars : [];
  const fullDailyStates = Array.isArray(options && options.dailyStates) ? options.dailyStates : [];
  const forecastDays = Number(options && options.forecastDays) > 0
    ? Number(options.forecastDays)
    : DEFAULT_FORECAST_DAYS;
  const maxSamples = Number(options && options.maxSamples) > 0
    ? Number(options.maxSamples)
    : DEFAULT_MAX_SAMPLES;
  const clickedDate = options && options.clickedDate
    ? String(options.clickedDate)
    : getLatestValidDate(fullBars);
  
  const symbol = options && options.symbol ? String(options.symbol) : '';
  const market = options && options.market ? String(options.market) : '';

  const fullBarIndexMap = buildBarIndexMap(fullBars);
  const fullClickedIndex = fullBarIndexMap.get(clickedDate);
  const predictionBars = Number.isInteger(fullClickedIndex)
    ? fullBars.slice(0, fullClickedIndex + 1)
    : filterBarsThroughDate(fullBars, clickedDate);
  const predictionDailyStates = filterDailyStatesThroughDate(fullDailyStates, clickedDate);

  assertNoFutureBarsForPrediction(predictionBars, clickedDate);

  const barIndexMap = buildBarIndexMap(predictionBars);
  const stateMap = buildStateMap(predictionDailyStates);
  const clickedIndex = barIndexMap.get(clickedDate);
  const clickedBar = Number.isInteger(clickedIndex) ? predictionBars[clickedIndex] : null;
  const currentState = stateMap.get(clickedDate) || null;
  const calculationIsolation = {
    enabled: true,
    cutoffDate: clickedDate,
    rule: 'prediction uses only bars/dailyStates <= clickedDate; actual path is evaluation/display only',
    predictionBarCount: predictionBars.length,
    fullBarCount: fullBars.length,
    predictionBarEndDate: getLatestValidDate(predictionBars),
    fullBarEndDate: getLatestValidDate(fullBars)
  };

  // ???????????????? T0 ????????????????
  const rapidChangeAnalysis = buildRapidChangeAnalysisFromBars({
    bars: fullBars,
    clickedIndex: fullClickedIndex,
    forecastDays
  });
  const rapidTypePrediction = buildRapidTypePredictionFromBars({
    bars: predictionBars,
    clickedIndex,
    currentState
  });
  const liquidityAnalysis = buildLiquidityFactorAnalysisFromBars({
    symbol,
    market,
    bars: predictionBars,
    clickedIndex,
    currentState,
    forecastDays
  });

  const emptyPreheatPathShapePrediction = buildPreheatPathShapePrediction({
    predictionBars,
    predictionDailyStates,
    currentState,
    clickedIndex,
    similarSamples: [],
    samplePaths: [],
    liquidityAnalysis,
    rapidTypePrediction,
    forecastDays
  });

  if (!clickedBar || !currentState) {
    const actualFuturePath = Number.isInteger(fullClickedIndex)
      ? buildActualFuturePath(fullBars, fullClickedIndex, forecastDays)
      : [];
    const actualComparison = compareActualToForecast({}, actualFuturePath);
    const actualComparisonSummary = summarizeActualComparison(actualComparison);
    const actualPathSummary = buildActualPathSummary(actualFuturePath);
    const forecastMilestones = {};

    return {
      algoVersion: XWB_NODE_PREDICTION_VERSION,
      ok: false,
      clickedDate,
      error: '??????????????????',
      calculationIsolation,
      currentNode: null,
      similarSamples: [],
      futurePathStats: [],
      horizonSummary: {},
      pathRisk: null,
      liquidityAnalysis,
      liquidityEnhancedPrediction: buildLiquidityEnhancedPrediction({
        horizonSummary: {},
        liquidityAnalysis
      }),
      preheatPathShapePrediction: emptyPreheatPathShapePrediction,
      actualFuturePath,
      actualComparison,
      actualComparisonSummary,
      rapidChangeAnalysis,
      rapidTypePrediction,
      predictionText: '该节点暂无足够数据用于预判。',
      forecastMilestones,
      actualPathSummary,
      validationNote: '计算隔离已启用：黄线/分位带只使用 T0 及以前的数据；T0 后真实走势只用于显示与评分。',
    };
  }

  const similarSamples = buildSimilarSamples({
    bars: predictionBars,
    dailyStates: predictionDailyStates,
    currentState,
    clickedIndex,
    forecastDays,
    maxSamples
  });
  assertNoFutureSamplesForPrediction(similarSamples, predictionBars, forecastDays, clickedIndex, clickedDate);
  const samplePaths = similarSamples.map((sample) => buildSamplePath(sample, predictionBars, forecastDays));
  const futurePathStats = summarizeDayPath(samplePaths, forecastDays);
  const horizonSummary = {
    d5: summarizeHorizon(futurePathStats, 5),
    d10: summarizeHorizon(futurePathStats, 10),
    d20: summarizeHorizon(futurePathStats, 20)
  };
  const pathRisk = summarizePathRisk(samplePaths);
  const predictionText = getPredictionText(currentState, horizonSummary.d20);
  const actualFuturePath = Number.isInteger(fullClickedIndex)
    ? buildActualFuturePath(fullBars, fullClickedIndex, forecastDays)
    : [];
  const actualComparison = compareActualToForecast(horizonSummary, actualFuturePath);
  const actualComparisonSummary = summarizeActualComparison(actualComparison);
  const actualPathSummary = buildActualPathSummary(actualFuturePath);
  const liquidityFuturePathStats = applyLiquidityAdjustmentToFuturePathStats(
    futurePathStats,
    liquidityAnalysis
  );
  const forecastMilestones = buildForecastMilestones(liquidityFuturePathStats);
  const liquidityEnhancedPrediction = buildLiquidityEnhancedPrediction({
    horizonSummary,
    liquidityAnalysis
  });
  const preheatPathShapePrediction = buildPreheatPathShapePrediction({
    predictionBars,
    predictionDailyStates,
    currentState,
    clickedIndex,
    similarSamples,
    samplePaths,
    liquidityAnalysis,
    rapidTypePrediction,
    forecastDays
  });

  return {
    algoVersion: XWB_NODE_PREDICTION_VERSION,
    ok: true,
    clickedDate,
    clickedIndex,
    forecastDays,
    maxSamples,
    calculationIsolation,
    currentNode: buildCurrentNode(currentState, clickedBar),
    similarSampleCount: similarSamples.length,
    similarSamples,
    baselineFuturePathStats: futurePathStats,
    futurePathStats: liquidityFuturePathStats,
    horizonSummary,
    pathRisk,
    liquidityAnalysis,
    liquidityEnhancedPrediction,
    preheatPathShapePrediction,
    actualFuturePath,
    actualComparison,
    actualComparisonSummary,
    rapidChangeAnalysis,
    rapidTypePrediction,
    forecastMilestones,
    actualPathSummary,
    predictionText,
    validationNote: '计算隔离已启用：黄线/分位带只使用 T0 及以前的数据；T0 后真实走势只用于显示与评分。',
  };
}

module.exports = {
  XWB_NODE_PREDICTION_VERSION,
  buildNodePredictionAnalysis
};

