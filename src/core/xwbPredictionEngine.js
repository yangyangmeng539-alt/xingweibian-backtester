const { STATE_NAMES } = require('./xwbStateClassifier');

const XWB_PREDICTION_VERSION = 'xwb-prediction';

const PERIODS = [
  { key: 'd5', suffix: '5', label: '5日' },
  { key: 'd10', suffix: '10', label: '10日' },
  { key: 'd20', suffix: '20', label: '20日' }
];

function roundNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '') {
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

function getNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getReturnValue(value) {
  const num = getNumber(value);

  if (num === null) {
    return null;
  }

  if (Math.abs(num) > 200) {
    return null;
  }

  return num;
}

function average(values) {
  const valid = values.map(getReturnValue).filter((value) => value !== null);

  if (!valid.length) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values) {
  const valid = values.map(getReturnValue).filter((value) => value !== null).sort((a, b) => a - b);

  if (!valid.length) {
    return null;
  }

  const mid = Math.floor(valid.length / 2);

  if (valid.length % 2 === 1) {
    return valid[mid];
  }

  return (valid[mid - 1] + valid[mid]) / 2;
}

function rate(values, predicate) {
  const valid = values.map(getReturnValue).filter((value) => value !== null);

  if (!valid.length) {
    return null;
  }

  const matched = valid.filter(predicate).length;
  return (matched / valid.length) * 100;
}

function maxValue(values) {
  const valid = values.map(getReturnValue).filter((value) => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

function minValue(values) {
  const valid = values.map(getReturnValue).filter((value) => value !== null);
  return valid.length ? Math.min(...valid) : null;
}

function isRiskState(stateCode) {
  return [
    'HIGH_CHASE_RISK',
    'HIGH_VOLUME_STALL',
    'BREAKDOWN_RISK',
    'LOW_WEAK_OBSERVE'
  ].includes(stateCode);
}

function isPositiveState(stateCode) {
  return [
    'LOW_STARTING',
    'PULLBACK_REPAIR',
    'MID_TREND_CONTINUING'
  ].includes(stateCode);
}

function isBadShape(shapeType) {
  return [
    'UNKNOWN_SHAPE',
    'HIGH_WAVE_RISK',
    'WEAK_BREAKDOWN'
  ].includes(shapeType);
}

function isBadChange(changeType) {
  return [
    'WEAKENING',
    'CONTINUING_DOWN',
    'FAILED_BREAKOUT',
    'VOLUME_PRICE_DIVERGENCE'
  ].includes(changeType);
}

function normalizeScore(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return 0;
  }

  return clamp(num, 0, 100) / 10;
}

function getStateStatsMap(stateStats) {
  const map = new Map();

  for (const item of Array.isArray(stateStats) ? stateStats : []) {
    if (item && item.stateCode) {
      map.set(String(item.stateCode), item);
    }
  }

  return map;
}

function getStateName(stateCode) {
  return STATE_NAMES[stateCode] || STATE_NAMES.UNKNOWN_STATE || '未明确状态';
}

function inferDirectionFromStats(stats) {
  const winRate20 = getNumber(stats && stats.winRate20);
  const avgReturn20 = getNumber(stats && stats.avgReturn20);
  const medianReturn20 = getNumber(stats && stats.medianReturn20);
  const maxLoss20 = getNumber(stats && stats.maxLoss20);

  if (
    winRate20 !== null &&
    avgReturn20 !== null &&
    medianReturn20 !== null &&
    winRate20 >= 55 &&
    avgReturn20 > 0 &&
    medianReturn20 > 0
  ) {
    return 'UP_BIAS';
  }

  if (
    winRate20 !== null &&
    medianReturn20 !== null &&
    winRate20 <= 45 &&
    medianReturn20 < 0
  ) {
    return 'DOWN_BIAS';
  }

  if (
    maxLoss20 !== null &&
    maxLoss20 <= -25 &&
    medianReturn20 !== null &&
    medianReturn20 <= 0
  ) {
    return 'RISK_DOWN_BIAS';
  }

  return 'NEUTRAL';
}

function isDirectionHit(direction, futureReturn) {
  const value = getReturnValue(futureReturn);

  if (value === null) {
    return null;
  }

  if (direction === 'UP_BIAS') {
    return value > 0;
  }

  if (direction === 'DOWN_BIAS' || direction === 'RISK_DOWN_BIAS') {
    return value < 0;
  }

  if (direction === 'NEUTRAL') {
    return Math.abs(value) <= 3;
  }

  return null;
}

function directionToText(direction) {
  if (direction === 'UP_BIAS') return '偏向上行';
  if (direction === 'DOWN_BIAS') return '偏向下行';
  if (direction === 'RISK_DOWN_BIAS') return '风险偏下';
  return '震荡/不明确';
}

function getPredictionGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

function capGrade(grade, maxGrade) {
  const order = ['A', 'B', 'C', 'D'];
  const gradeIndex = order.indexOf(grade);
  const maxIndex = order.indexOf(maxGrade);

  if (gradeIndex < 0) return maxGrade;
  if (maxIndex < 0) return grade;

  return gradeIndex < maxIndex ? maxGrade : grade;
}

function getRiskLevel(input) {
  const stateCode = input.stateCode;
  const shapeType = input.shapeType;
  const positionType = input.positionType;
  const changeType = input.changeType;
  const maxLoss20 = getNumber(input.maxLoss20);

  if (stateCode === 'BREAKDOWN_RISK') return 'HIGH';
  if (stateCode === 'HIGH_CHASE_RISK') return 'HIGH';
  if (stateCode === 'HIGH_VOLUME_STALL') return 'HIGH';
  if (stateCode === 'UNKNOWN_STATE' && shapeType === 'UNKNOWN_SHAPE') return 'HIGH';
  if (positionType === 'HIGH_AREA' && shapeType === 'UNKNOWN_SHAPE') return 'HIGH';
  if (shapeType === 'WEAK_BREAKDOWN' || shapeType === 'HIGH_WAVE_RISK') return 'HIGH';
  if (changeType === 'WEAKENING' || changeType === 'CONTINUING_DOWN' || changeType === 'FAILED_BREAKOUT') return 'HIGH';
  if (maxLoss20 !== null && maxLoss20 <= -25) return 'HIGH';
  if (stateCode === 'LOW_WEAK_OBSERVE') return 'MID';
  if (maxLoss20 !== null && maxLoss20 <= -15) return 'MID';

  return 'LOW';
}

function getObservationValue(grade, riskLevel) {
  if (riskLevel === 'HIGH') {
    return 'LOW';
  }

  if (grade === 'A') {
    return 'HIGH';
  }

  if (grade === 'B') {
    return 'MID_HIGH';
  }

  if (grade === 'C') {
    return 'MID';
  }

  return 'LOW';
}

function getActionBias(grade, riskLevel) {
  if (riskLevel === 'HIGH') return 'AVOID';
  if (grade === 'A') return 'FOCUS';
  if (grade === 'B') return 'WATCH';
  if (grade === 'C') return 'WAIT';
  return 'AVOID';
}

function buildStatePeriodPrediction(items, direction, period) {
  const values = items
    .map((item) => item && item.futureReturns ? item.futureReturns[period.key] : null)
    .filter((value) => getReturnValue(value) !== null);

  const hitValues = values
    .map((value) => isDirectionHit(direction, value))
    .filter((value) => value !== null);

  const positiveRate = rate(values, (value) => value > 0);
  const downsideRate = rate(values, (value) => value < -5);
  const falsePositiveRate = direction === 'UP_BIAS'
    ? rate(values, (value) => value <= 0)
    : null;

  return {
    [`sampleCount${period.suffix}`]: values.length,
    [`directionHitRate${period.suffix}`]: hitValues.length
      ? roundNumber((hitValues.filter(Boolean).length / hitValues.length) * 100)
      : null,
    [`positiveRate${period.suffix}`]: roundNumber(positiveRate),
    [`avgReturn${period.suffix}`]: roundNumber(average(values)),
    [`medianReturn${period.suffix}`]: roundNumber(median(values)),
    [`maxLoss${period.suffix}`]: roundNumber(minValue(values)),
    [`maxGain${period.suffix}`]: roundNumber(maxValue(values)),
    [`downsideRate${period.suffix}`]: roundNumber(downsideRate),
    [`falsePositiveRate${period.suffix}`]: roundNumber(falsePositiveRate)
  };
}

function calcRiskReward20(items) {
  const values = items
    .map((item) => item && item.futureReturns ? item.futureReturns.d20 : null)
    .map(getReturnValue)
    .filter((value) => value !== null);

  const gains = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0).map((value) => Math.abs(value));
  const avgGain = gains.length ? gains.reduce((sum, value) => sum + value, 0) / gains.length : null;
  const avgLoss = losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : null;

  if (avgGain === null || avgLoss === null || avgLoss <= 0) {
    return null;
  }

  return avgGain / avgLoss;
}

function calcPredictionScore(stat) {
  let score = 50;
  const sampleCount = Number(stat.sampleCount || 0);
  const hit20 = getNumber(stat.directionHitRate20);
  const median20 = getNumber(stat.medianReturn20);
  const avg20 = getNumber(stat.avgReturn20);
  const maxLoss20 = getNumber(stat.maxLoss20);
  const riskReward20 = getNumber(stat.riskReward20);
  const falsePositive20 = getNumber(stat.falsePositiveRate20);

  if (sampleCount >= 80) score += 12;
  else if (sampleCount >= 30) score += 8;
  else if (sampleCount >= 15) score += 4;
  else score -= 18;

  if (hit20 !== null && hit20 >= 65) score += 18;
  else if (hit20 !== null && hit20 >= 55) score += 10;
  else if (hit20 !== null && hit20 < 45) score -= 12;

  if (median20 !== null && median20 > 0) score += 10;
  if (avg20 !== null && avg20 > 0) score += 6;

  if (riskReward20 !== null && riskReward20 >= 1.5) score += 10;
  else if (riskReward20 !== null && riskReward20 < 0.8) score -= 10;

  if (falsePositive20 !== null && falsePositive20 >= 50) score -= 12;

  if (maxLoss20 !== null && maxLoss20 <= -25) score -= 15;
  else if (maxLoss20 !== null && maxLoss20 <= -15) score -= 8;

  if (isRiskState(stat.stateCode)) score -= 12;
  if (stat.stateCode === 'UNKNOWN_STATE') score -= 18;

  return roundNumber(clamp(score, 0, 100));
}

function buildPredictionStats(dailyStates) {
  const groups = new Map();

  for (const item of Array.isArray(dailyStates) ? dailyStates : []) {
    const stateCode = item && item.stateCode ? item.stateCode : 'UNKNOWN_STATE';

    if (!groups.has(stateCode)) {
      groups.set(stateCode, {
        stateCode,
        stateName: (item && item.stateName) || getStateName(stateCode),
        items: []
      });
    }

    groups.get(stateCode).items.push(item);
  }

  return Array.from(groups.values())
    .map((group) => {
      const rawStats = {
        stateCode: group.stateCode,
        stateName: group.stateName,
        sampleCount: group.items.length,
        winRate20: roundNumber(rate(group.items.map((item) => item.futureReturns && item.futureReturns.d20), (value) => value > 0)),
        avgReturn20: roundNumber(average(group.items.map((item) => item.futureReturns && item.futureReturns.d20))),
        medianReturn20: roundNumber(median(group.items.map((item) => item.futureReturns && item.futureReturns.d20))),
        maxLoss20: roundNumber(minValue(group.items.map((item) => item.futureReturns && item.futureReturns.d20))),
        maxGain20: roundNumber(maxValue(group.items.map((item) => item.futureReturns && item.futureReturns.d20)))
      };

      const direction = inferDirectionFromStats(rawStats);

      const periodStats = PERIODS.reduce((acc, period) => {
        return {
          ...acc,
          ...buildStatePeriodPrediction(group.items, direction, period)
        };
      }, {});

      const riskReward20 = roundNumber(calcRiskReward20(group.items));

      const merged = {
        ...rawStats,
        ...periodStats,
        predictionDirection: direction,
        predictionDirectionText: directionToText(direction),
        riskReward20
      };

      const predictionScore = calcPredictionScore(merged);
      let predictionGrade = getPredictionGrade(predictionScore);

      const riskLevel = getRiskLevel({
        stateCode: group.stateCode,
        shapeType: '',
        positionType: '',
        changeType: '',
        maxLoss20: merged.maxLoss20
      });

      /*
       * 形位变预判等级不是“涨幅大小排名”。
       * 样本不足、状态不明、高风险状态，即使历史均值为正，也不能给高等级。
       */
      if (group.items.length < 10) {
        predictionGrade = 'D';
      } else if (group.items.length < 20) {
        predictionGrade = capGrade(predictionGrade, 'C');
      }

      if (group.stateCode === 'UNKNOWN_STATE') {
        predictionGrade = capGrade(predictionGrade, 'C');
      }

      if (isRiskState(group.stateCode)) {
        predictionGrade = capGrade(predictionGrade, 'C');
      }

      if (riskLevel === 'HIGH') {
        predictionGrade = capGrade(predictionGrade, 'C');
      }

      if (group.stateCode === 'SIDEWAYS_WAITING' && group.items.length < 20) {
        predictionGrade = 'D';
      }

      return {
        ...merged,
        predictionScore,
        predictionGrade,
        riskLevel,
        observationValue: getObservationValue(predictionGrade, riskLevel)
      };
    })
    .sort((left, right) => {
      const rightScore = Number(right.predictionScore || 0);
      const leftScore = Number(left.predictionScore || 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return Number(right.sampleCount || 0) - Number(left.sampleCount || 0);
    });
}

function buildDailyPrediction(dailyState, predictionStat) {
  const shape = dailyState && dailyState.shape ? dailyState.shape : {};
  const position = dailyState && dailyState.position ? dailyState.position : {};
  const change = dailyState && dailyState.change ? dailyState.change : {};
  const stateCode = dailyState && dailyState.stateCode ? dailyState.stateCode : 'UNKNOWN_STATE';
  const shapeType = shape.type || 'UNKNOWN_SHAPE';
  const positionType = position.type || 'MID_AREA';
  const changeType = change.type || 'UNKNOWN_CHANGE';
  const stat = predictionStat || {};
  const baseScore = getNumber(stat.predictionScore) || 0;
  let currentScore = baseScore;
  const reasons = [];
  const riskNotes = [];

  if (isPositiveState(stateCode)) {
    currentScore += 8;
    reasons.push('当前综合状态属于正向观察状态');
  }

  if (isRiskState(stateCode)) {
    currentScore -= 14;
    riskNotes.push('当前综合状态带有风险属性');
  }

  if (shapeType === 'UNKNOWN_SHAPE') {
    currentScore -= 10;
    riskNotes.push('观其形未形成明确结构');
  } else if (!isBadShape(shapeType)) {
    currentScore += normalizeScore(shape.score) * 2;
    reasons.push('观其形存在可识别结构');
  } else {
    currentScore -= 12;
    riskNotes.push('观其形出现风险结构');
  }

  if (positionType === 'HIGH_AREA' || positionType === 'HIGH_CHASE_RISK') {
    currentScore -= 10;
    riskNotes.push('知其位显示位置偏高或追涨风险');
  } else {
    currentScore += normalizeScore(position.score) * 1.5;
    reasons.push('知其位未显示明显高位追涨');
  }

  if (isBadChange(changeType)) {
    currentScore -= 14;
    riskNotes.push('复察其变显示变化不利');
  } else if (changeType !== 'UNKNOWN_CHANGE') {
    currentScore += normalizeScore(change.score) * 2;
    reasons.push('复察其变显示变化方向可观察');
  }

  const riskLevel = getRiskLevel({
    stateCode,
    shapeType,
    positionType,
    changeType,
    maxLoss20: stat.maxLoss20
  });
  let predictionGrade = getPredictionGrade(clamp(currentScore, 0, 100));

  if (riskLevel === 'HIGH') predictionGrade = capGrade(predictionGrade, 'C');
  if (stateCode === 'UNKNOWN_STATE') predictionGrade = capGrade(predictionGrade, 'C');
  if (shapeType === 'UNKNOWN_SHAPE') predictionGrade = capGrade(predictionGrade, 'C');

  const finalScore = roundNumber(clamp(currentScore, 0, 100));
  const observationValue = getObservationValue(predictionGrade, riskLevel);
  const actionBias = getActionBias(predictionGrade, riskLevel);

  return {
    date: dailyState.date,
    close: dailyState.close,
    stateCode,
    stateName: dailyState.stateName || getStateName(stateCode),
    shapeType,
    positionType,
    changeType,
    shapeScore: roundNumber(shape.score),
    positionScore: roundNumber(position.score),
    changeScore: roundNumber(change.score),
    predictionDirection: stat.predictionDirection || 'NEUTRAL',
    predictionDirectionText: stat.predictionDirectionText || '震荡/不明确',
    predictionScore: finalScore,
    predictionGrade,
    riskLevel,
    observationValue,
    actionBias,
    sampleCount: stat.sampleCount || 0,
    directionHitRate5: stat.directionHitRate5,
    directionHitRate10: stat.directionHitRate10,
    directionHitRate20: stat.directionHitRate20,
    avgReturn5: stat.avgReturn5,
    avgReturn10: stat.avgReturn10,
    avgReturn20: stat.avgReturn20,
    medianReturn5: stat.medianReturn5,
    medianReturn10: stat.medianReturn10,
    medianReturn20: stat.medianReturn20,
    maxLoss20: stat.maxLoss20,
    maxGain20: stat.maxGain20,
    riskReward20: stat.riskReward20,
    falsePositiveRate20: stat.falsePositiveRate20,
    reasons,
    riskNotes,
    stateSummary: dailyState.stateSummary,
    futureReturns: dailyState.futureReturns
  };
}

function buildPredictionAnalysis(dailyStates, stateStats) {
  const predictionStats = buildPredictionStats(dailyStates);
  const statMap = new Map(predictionStats.map((item) => [String(item.stateCode), item]));
  const dailyPredictions = (Array.isArray(dailyStates) ? dailyStates : []).map((dailyState) => {
    const stateCode = dailyState && dailyState.stateCode ? dailyState.stateCode : 'UNKNOWN_STATE';
    return buildDailyPrediction(dailyState, statMap.get(String(stateCode)));
  });
  const latestPrediction = dailyPredictions.length ? dailyPredictions[dailyPredictions.length - 1] : null;

  return {
    algoVersion: XWB_PREDICTION_VERSION,
    dailyPredictions,
    predictionStats,
    latestPrediction
  };
}

module.exports = {
  XWB_PREDICTION_VERSION,
  buildPredictionAnalysis,
  buildPredictionStats,
  buildDailyPrediction
};