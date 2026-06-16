'use strict';

const structureService = require('./nodeStructurePredictionService');

const NODE_PREDICTION_VALIDATION_VERSION = 'node-prediction-validation-v1.0.0';
const DEFAULT_HORIZONS = [3, 5, 10, 20];

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundNumber(value, digits = 2) {
  const number = toNumber(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => toNumber(value))
    .filter(Number.isFinite);

  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => toNumber(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (!list.length) return null;

  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function rate(rows, predicate) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  return list.filter(predicate).length / list.length * 100;
}

function direction(value) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) return 'UNKNOWN';
  if (number > 0) return 'UP';
  if (number < 0) return 'DOWN';
  return 'FLAT';
}

function isStructureLikeModelType(modelType) {
  const type = String(modelType || '').trim();

  return type === 'structure' || type === 'market';
}

function directionHit(forecastValue, actualValue) {
  const forecastDirection = direction(forecastValue);
  const actualDirection = direction(actualValue);

  if (
    forecastDirection === 'UNKNOWN'
    || actualDirection === 'UNKNOWN'
    || forecastDirection === 'FLAT'
    || actualDirection === 'FLAT'
  ) {
    return null;
  }

  return forecastDirection === actualDirection;
}

function getClose(bar) {
  return toNumber(bar && bar.close);
}

function getHigh(bar) {
  const high = toNumber(bar && bar.high);
  const close = getClose(bar);
  return Number.isFinite(high) ? high : close;
}

function getLow(bar) {
  const low = toNumber(bar && bar.low);
  const close = getClose(bar);
  return Number.isFinite(low) ? low : close;
}

function getReturnPct(baseClose, futurePrice) {
  const base = toNumber(baseClose);
  const future = toNumber(futurePrice);

  if (!Number.isFinite(base) || !Number.isFinite(future) || base <= 0) {
    return null;
  }

  return (future / base - 1) * 100;
}

function getForecastMilestone(nodePredictionAnalysis, day) {
  const targetDay = Number(day);
  const key = `d${targetDay}`;

  const milestones = nodePredictionAnalysis && nodePredictionAnalysis.forecastMilestones
    ? nodePredictionAnalysis.forecastMilestones
    : {};

  if (milestones[key]) return milestones[key];

  const horizonSummary = nodePredictionAnalysis && nodePredictionAnalysis.horizonSummary
    ? nodePredictionAnalysis.horizonSummary
    : {};

  if (horizonSummary[key]) return horizonSummary[key];

  const futurePathStats = Array.isArray(nodePredictionAnalysis && nodePredictionAnalysis.futurePathStats)
    ? nodePredictionAnalysis.futurePathStats
    : [];

  return futurePathStats.find((item) => Number(item && item.day) === targetDay) || null;
}

function getRawForecastReturnPct(nodePredictionAnalysis, day) {
  const item = getForecastMilestone(nodePredictionAnalysis, day);
  return toNumber(item && item.medianReturnPct);
}

function getStructureForecastReturnPct(nodePredictionAnalysis, day) {
  const rawReturnPct = getRawForecastReturnPct(nodePredictionAnalysis, day);

  if (!Number.isFinite(rawReturnPct)) {
    return null;
  }

  if (!structureService || typeof structureService.getStructureAdjustedForecastReturnPct !== 'function') {
    return rawReturnPct;
  }

  try {
    const adjusted = structureService.getStructureAdjustedForecastReturnPct(
      nodePredictionAnalysis,
      Number(day),
      rawReturnPct,
      'median'
    );

    return Number.isFinite(toNumber(adjusted)) ? Number(adjusted) : rawReturnPct;
  } catch (_error) {
    return rawReturnPct;
  }
}

function buildActualHorizonMetrics(bars, clickedIndex, horizon) {
  const day = Number(horizon);
  const index = Number(clickedIndex);

  if (!Array.isArray(bars) || !Number.isInteger(index) || !Number.isInteger(day) || day <= 0) {
    return { day, ok: false, reason: 'INVALID_INPUT' };
  }

  const baseBar = bars[index];
  const baseClose = getClose(baseBar);

  if (!Number.isFinite(baseClose) || baseClose <= 0) {
    return { day, ok: false, reason: 'INVALID_BASE_CLOSE' };
  }

  const exactBar = bars[index + day];

  if (!exactBar) {
    return {
      day,
      ok: false,
      reason: 'NO_FUTURE_BAR',
      baseDate: baseBar && baseBar.date ? String(baseBar.date) : '',
      baseClose: roundNumber(baseClose)
    };
  }

  let maxReturnPct = null;
  let maxReturnDay = null;
  let maxReturnDate = '';
  let maxDrawdownPct = null;
  let maxDrawdownDay = null;
  let maxDrawdownDate = '';

  for (let offset = 1; offset <= day; offset += 1) {
    const bar = bars[index + offset];
    if (!bar) continue;

    const highReturn = getReturnPct(baseClose, getHigh(bar));
    const lowReturn = getReturnPct(baseClose, getLow(bar));

    if (Number.isFinite(highReturn) && (maxReturnPct === null || highReturn > maxReturnPct)) {
      maxReturnPct = highReturn;
      maxReturnDay = offset;
      maxReturnDate = String(bar.date || '');
    }

    if (Number.isFinite(lowReturn) && (maxDrawdownPct === null || lowReturn < maxDrawdownPct)) {
      maxDrawdownPct = lowReturn;
      maxDrawdownDay = offset;
      maxDrawdownDate = String(bar.date || '');
    }
  }

  const closeReturnPct = getReturnPct(baseClose, getClose(exactBar));

  return {
    day,
    ok: true,
    baseDate: String(baseBar && baseBar.date || ''),
    baseClose: roundNumber(baseClose),
    actualDate: String(exactBar.date || ''),
    actualClose: roundNumber(getClose(exactBar)),
    closeReturnPct: roundNumber(closeReturnPct),
    maxReturnPct: roundNumber(maxReturnPct),
    maxReturnDay,
    maxReturnDate,
    maxDrawdownPct: roundNumber(maxDrawdownPct),
    maxDrawdownDay,
    maxDrawdownDate
  };
}

function buildPreRiskMetrics(bars, clickedIndex) {
  const index = Number(clickedIndex);

  if (!Array.isArray(bars) || !Number.isInteger(index) || index <= 0) {
    return {
      ok: false,
      reason: 'INVALID_PRE_RISK_INPUT'
    };
  }

  const currentBar = bars[index];
  const currentClose = getClose(currentBar);

  if (!Number.isFinite(currentClose) || currentClose <= 0) {
    return {
      ok: false,
      reason: 'INVALID_CURRENT_CLOSE'
    };
  }

  function calcWindow(days) {
    const start = Math.max(0, index - Number(days));
    const end = index;
    const list = bars.slice(start, end + 1).filter(Boolean);

    if (list.length < 2) {
      return {
        days,
        ok: false,
        reason: 'NOT_ENOUGH_PRE_BARS'
      };
    }

    const firstClose = getClose(list[0]);
    const lastClose = getClose(list[list.length - 1]);

    let maxHigh = null;
    let minLow = null;
    let maxClose = null;
    let minClose = null;

    list.forEach((bar) => {
      const high = getHigh(bar);
      const low = getLow(bar);
      const close = getClose(bar);

      if (Number.isFinite(high)) {
        maxHigh = maxHigh === null ? high : Math.max(maxHigh, high);
      }

      if (Number.isFinite(low)) {
        minLow = minLow === null ? low : Math.min(minLow, low);
      }

      if (Number.isFinite(close)) {
        maxClose = maxClose === null ? close : Math.max(maxClose, close);
        minClose = minClose === null ? close : Math.min(minClose, close);
      }
    });

    const returnPct = getReturnPct(firstClose, lastClose);
    const rangePct = Number.isFinite(maxHigh) && Number.isFinite(minLow) && minLow > 0
      ? (maxHigh / minLow - 1) * 100
      : null;

    const drawdownFromHighPct = Number.isFinite(maxHigh) && Number.isFinite(currentClose) && maxHigh > 0
      ? (currentClose / maxHigh - 1) * 100
      : null;

    const reboundFromLowPct = Number.isFinite(minLow) && Number.isFinite(currentClose) && minLow > 0
      ? (currentClose / minLow - 1) * 100
      : null;

    return {
      days,
      ok: true,
      returnPct: roundNumber(returnPct),
      rangePct: roundNumber(rangePct),
      drawdownFromHighPct: roundNumber(drawdownFromHighPct),
      reboundFromLowPct: roundNumber(reboundFromLowPct),
      maxHigh: roundNumber(maxHigh),
      minLow: roundNumber(minLow),
      maxClose: roundNumber(maxClose),
      minClose: roundNumber(minClose)
    };
  }

  const w5 = calcWindow(5);
  const w10 = calcWindow(10);
  const w20 = calcWindow(20);

  const riskFlags = [];

  if (Number.isFinite(toNumber(w20.rangePct)) && w20.rangePct >= 35) {
    riskFlags.push('PRE20_RANGE_TOO_WIDE');
  }

  if (Number.isFinite(toNumber(w10.rangePct)) && w10.rangePct >= 25) {
    riskFlags.push('PRE10_RANGE_TOO_WIDE');
  }

  if (Number.isFinite(toNumber(w20.drawdownFromHighPct)) && w20.drawdownFromHighPct <= -15) {
    riskFlags.push('PRE20_DRAWDOWN_TOO_DEEP');
  }

  if (Number.isFinite(toNumber(w10.drawdownFromHighPct)) && w10.drawdownFromHighPct <= -12) {
    riskFlags.push('PRE10_DRAWDOWN_TOO_DEEP');
  }

  if (Number.isFinite(toNumber(w5.drawdownFromHighPct)) && w5.drawdownFromHighPct <= -8) {
    riskFlags.push('PRE5_FAST_FADE');
  }

  return {
    ok: true,
    w5,
    w10,
    w20,
    riskFlags,
    riskLevel: riskFlags.length >= 2 ? 'HIGH' : riskFlags.length === 1 ? 'MID' : 'LOW'
  };
}

function detectLowRepairPrediction(nodePredictionAnalysis) {
  const prediction = nodePredictionAnalysis && nodePredictionAnalysis.rapidTypePrediction
    ? nodePredictionAnalysis.rapidTypePrediction
    : {};

  const text = [
    prediction.predictedRapidTitle,
    prediction.summaryText,
    ...(Array.isArray(prediction.reasonParts) ? prediction.reasonParts : [])
  ].join(' ');

  return /低位|修复|超跌|rebound|repair/i.test(text);
}

function getStructureType(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.observationRefinement
    && nodePredictionAnalysis.observationRefinement.type
      ? nodePredictionAnalysis.observationRefinement.type
      : ''
  );
}

function getStructureTitle(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.observationRefinement
    && nodePredictionAnalysis.observationRefinement.title
      ? nodePredictionAnalysis.observationRefinement.title
      : ''
  );
}

function getStructureTone(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.observationRefinement
    && nodePredictionAnalysis.observationRefinement.tone
      ? nodePredictionAnalysis.observationRefinement.tone
      : ''
  );
}

function getMarketEnvironment(nodePredictionAnalysis) {
  const env = nodePredictionAnalysis && nodePredictionAnalysis.marketEnvironment
    ? nodePredictionAnalysis.marketEnvironment
    : null;

  return env && typeof env === 'object' ? env : null;
}

function getMarketRegime(nodePredictionAnalysis) {
  const env = getMarketEnvironment(nodePredictionAnalysis);

  return String(env && env.regime ? env.regime : '');
}

function getMarketBias(nodePredictionAnalysis) {
  const env = getMarketEnvironment(nodePredictionAnalysis);

  return String(env && env.bias ? env.bias : '');
}

function isMarketContextReady(nodePredictionAnalysis) {
  const env = getMarketEnvironment(nodePredictionAnalysis);

  return !!(env && env.ok === true);
}

function isHostileMarket(nodePredictionAnalysis) {
  const regime = getMarketRegime(nodePredictionAnalysis);
  const bias = getMarketBias(nodePredictionAnalysis);

  return bias === 'hostile'
    || regime === 'BEAR'
    || regime === 'REBOUND_RISK'
    || regime === 'TOP_CROWDING';
}

function isSupportiveMarket(nodePredictionAnalysis) {
  const regime = getMarketRegime(nodePredictionAnalysis);
  const bias = getMarketBias(nodePredictionAnalysis);

  return bias === 'supportive'
    || regime === 'STRONG'
    || regime === 'WARM';
}

function applyMarketPredictionKindFilter(kind, nodePredictionAnalysis, modelType = 'raw') {
  const predictionKind = String(kind || 'UNKNOWN');

  if (String(modelType || '') !== 'market') {
    return predictionKind;
  }

  if (!isMarketContextReady(nodePredictionAnalysis)) {
    return predictionKind;
  }

  const regime = getMarketRegime(nodePredictionAnalysis);
  const hostile = isHostileMarket(nodePredictionAnalysis);

  // TARGET_CATCHUP 是当前最有效结构。
  // 600519 验证里，即使 BEAR / WEAK 环境下也经常成立，所以不能一刀切压掉。
  if (predictionKind === 'TARGET_CATCHUP') {
    if (regime === 'TOP_CROWDING' && isHighPositionDivergence(nodePredictionAnalysis)) {
      return 'RISK_WARNING';
    }

    return predictionKind;
  }

  // 产业链预热在 hostile 市场里，经常只是反抽/退潮里的假共振。
  // C 层要把它从“看多观察”改成“风险观察”。
  if (predictionKind === 'CHAIN_PREHEAT' && hostile) {
    // 产业链预热在系统退潮里，才更像“反转/退潮风险”。
    // REBOUND_RISK / TOP_CROWDING 很多时候只是震荡回撤，不能直接打成反转。
    if (regime === 'BEAR') {
      return 'RISK_REVERSAL';
    }

    if (regime === 'TOP_CROWDING' && isHighPositionDivergence(nodePredictionAnalysis)) {
      return 'RISK_PULLBACK';
    }

    return 'RISK_PULLBACK';
  }

  // 趋势中继在系统退潮/高位拥挤里最容易误判。
  if (predictionKind === 'EXTEND_UP') {
    // 趋势中继本身已经偏弱，遇到 BEAR 才判反转。
    // TOP_CROWDING 先判回撤，不直接判死。
    if (regime === 'BEAR') {
      return 'RISK_REVERSAL';
    }

    if (regime === 'TOP_CROWDING') {
      return 'RISK_PULLBACK';
    }

    if (hostile && isHighPositionDivergence(nodePredictionAnalysis)) {
      return 'RISK_PULLBACK';
    }
  }

  return predictionKind;
}

function applyMarketConfidenceFilter(confidence, nodePredictionAnalysis, originalKind, adjustedKind, modelType = 'raw') {
  let value = toNumber(confidence, 0.3);

  if (String(modelType || '') !== 'market') {
    return roundNumber(Math.max(0, Math.min(1, value)), 3);
  }

  if (!isMarketContextReady(nodePredictionAnalysis)) {
    return roundNumber(Math.max(0, Math.min(1, value)), 3);
  }

  const regime = getMarketRegime(nodePredictionAnalysis);
  const hostile = isHostileMarket(nodePredictionAnalysis);
  const supportive = isSupportiveMarket(nodePredictionAnalysis);

  if (adjustedKind === 'RISK_WARNING' || adjustedKind === 'RISK_PULLBACK') {
    value = Math.min(value, 0.36);
  }

  if (adjustedKind === 'RISK_REVERSAL') {
    value = Math.min(value, 0.32);
  }

  if (originalKind === 'TARGET_CATCHUP' && adjustedKind === 'TARGET_CATCHUP') {
    if (supportive) {
      value += 0.03;
    }

    if (hostile) {
      // hostile 不等于失败，尤其 TARGET_CATCHUP 在 600519 上反而经常是低位修复。
      // 所以只轻压，不硬砍。
      value -= 0.02;
    }

    if (regime === 'TOP_CROWDING') {
      value = Math.min(value, 0.39);
    }
  }

  if (originalKind === 'CHAIN_PREHEAT' && hostile) {
    value = Math.min(value, 0.32);
  }

  if (originalKind === 'EXTEND_UP' && hostile) {
    value = Math.min(value, 0.34);
  }

  return roundNumber(Math.max(0, Math.min(1, value)), 3);
}

function getRapidTitle(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.rapidTypePrediction
    && nodePredictionAnalysis.rapidTypePrediction.predictedRapidTitle
      ? nodePredictionAnalysis.rapidTypePrediction.predictedRapidTitle
      : ''
  );
}

function getRapidGroup(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.rapidTypePrediction
    && nodePredictionAnalysis.rapidTypePrediction.predictedRapidGroup
      ? nodePredictionAnalysis.rapidTypePrediction.predictedRapidGroup
      : 'UNKNOWN'
  );
}

function getRapidSignal(nodePredictionAnalysis) {
  return String(
    nodePredictionAnalysis
    && nodePredictionAnalysis.rapidTypePrediction
    && nodePredictionAnalysis.rapidTypePrediction.predictedSignal
      ? nodePredictionAnalysis.rapidTypePrediction.predictedSignal
      : ''
  );
}

function isHighPositionDivergence(nodePredictionAnalysis) {
  const title = getRapidTitle(nodePredictionAnalysis);

  return /高位|连续上涨|分歧|透支|回撤|衰减/.test(title);
}

function isLowRepairTitle(nodePredictionAnalysis) {
  const title = getRapidTitle(nodePredictionAnalysis);

  return /低位|修复|弱势|超跌/.test(title);
}

function isTargetCatchupFriendlyTitle(nodePredictionAnalysis) {
  const title = getRapidTitle(nodePredictionAnalysis);

  // 外部强、目标待确认里，低位/修复/弱势确认更像“补确认”，允许进 MID。
  return /低位|修复|弱势|近端弱势|超跌/.test(title);
}

function isTargetCatchupRiskTitle(nodePredictionAnalysis) {
  const title = getRapidTitle(nodePredictionAnalysis);

  // 高位、连续上涨、末端分歧不能因为外部强就直接当优质补涨。
  return /高位|连续上涨|透支|衰减|回撤|末端|冲高/.test(title);
}

function isTargetCatchupMixedTitle(nodePredictionAnalysis) {
  const title = getRapidTitle(nodePredictionAnalysis);

  return /混合分歧/.test(title);
}

function getConfidenceBand(confidence) {
  const value = toNumber(confidence, 0);

  if (value >= 0.68) return 'HIGH';
  if (value >= 0.40) return 'MID';
  return 'LOW';
}

function derivePredictionKind(nodePredictionAnalysis, modelType = 'raw') {
  const rapidGroup = getRapidGroup(nodePredictionAnalysis);
  const rapidSignal = getRapidSignal(nodePredictionAnalysis);
  const structureType = getStructureType(nodePredictionAnalysis);
  const structureTone = getStructureTone(nodePredictionAnalysis);

  if (isStructureLikeModelType(modelType)) {
    if ([
      'STRUCTURE_OVERHEATED',
      'LATE_CONFIRMATION',
      'PREHEAT_DECAY',
      'ISOLATED_NODE',
      'SHAPE_POSITION_RISK'
    ].includes(structureType) || structureTone === 'risk') {
      return 'RISK_WARNING';
    }

    // 外部强、目标待确认：这是当前 600519 验证里最有价值的一类，
    // 不要混进普通 WATCH_REPAIR，单独统计。
    if (structureType === 'EXTERNAL_CONFIRMED_TARGET_WEAK') {
      return 'TARGET_CATCHUP';
    }

    // 产业链预热不是短线强信号，单独统计，主要看 T+10 / T+20。
    if ([
      'SUPPLY_CHAIN_PREHEAT',
      'RELATION_PREHEAT',
      'STRUCTURE_WARMING'
    ].includes(structureType)) {
      return 'CHAIN_PREHEAT';
    }

    if ([
      'TREND_CONTINUATION',
      'STRUCTURE_CONFIRMED',
      'LOW_LEVEL_CONFIRMATION'
    ].includes(structureType) || structureTone === 'strong') {
      return 'EXTEND_UP';
    }

    if (structureTone === 'watch') {
      return 'WATCH_REPAIR';
    }
  }

  if (rapidGroup === 'EXTEND_UP' && detectLowRepairPrediction(nodePredictionAnalysis)) {
    return 'LOW_REPAIR';
  }

  if (rapidGroup === 'SHORT_WINDOW_DECAY' || rapidSignal === 'short_window') {
    return 'SHORT_WINDOW_RISK';
  }

  if (rapidGroup === 'EXTEND_UP' || rapidSignal === 'trend') {
    return 'EXTEND_UP';
  }

  if (rapidGroup === 'MIXED') {
    return 'MIXED';
  }

  return rapidGroup || 'UNKNOWN';
}

function getConfidence(nodePredictionAnalysis, modelType = 'raw') {
  const rapidPrediction = nodePredictionAnalysis && nodePredictionAnalysis.rapidTypePrediction
    ? nodePredictionAnalysis.rapidTypePrediction
    : {};

  const rapidGroup = getRapidGroup(nodePredictionAnalysis);
  const rapidTitle = getRapidTitle(nodePredictionAnalysis);
  const structureType = getStructureType(nodePredictionAnalysis);
  const structureTone = getStructureTone(nodePredictionAnalysis);

  let confidence = toNumber(rapidPrediction.confidence, 0.3);

  if (!isStructureLikeModelType(modelType)) {
    return roundNumber(Math.max(0, Math.min(1, confidence)), 3);
  }

  const refinement = nodePredictionAnalysis && nodePredictionAnalysis.observationRefinement
    ? nodePredictionAnalysis.observationRefinement
    : null;

  const structureScore = toNumber(refinement && refinement.score);

  if (Number.isFinite(structureScore)) {
    const normalized = Math.max(0, Math.min(1, structureScore / 100));
    confidence = confidence * 0.60 + normalized * 0.40;
  } else if (structureTone === 'risk' || structureTone === 'strong') {
    confidence += 0.08;
  } else if (structureTone === 'watch') {
    confidence += 0.03;
  } else if (structureTone === 'weak') {
    confidence -= 0.10;
  }

  if (structureType === 'EXTERNAL_CONFIRMED_TARGET_WEAK') {
    // 外部强、目标待确认：有效结构。
    // 不再简单用“混合分歧”压 LOW；
    // 真正的过滤交给 T0 前波动/回撤 preRiskMetrics。

    const friendlyCatchup = isTargetCatchupFriendlyTitle(nodePredictionAnalysis);
    const riskCatchup = isTargetCatchupRiskTitle(nodePredictionAnalysis);
    const mixedCatchup = isTargetCatchupMixedTitle(nodePredictionAnalysis);

    if (riskCatchup) {
      confidence -= 0.06;
      confidence = Math.min(confidence, 0.36);
    } else if (friendlyCatchup) {
      confidence += isLowRepairTitle(nodePredictionAnalysis) ? 0.14 : 0.10;
      confidence += 0.04;
      confidence = Math.max(confidence, 0.40);
      confidence = Math.min(confidence, 0.62);
    } else if (rapidGroup === 'EXTEND_UP') {
      confidence += 0.06;
      confidence = Math.max(confidence, 0.40);
      confidence = Math.min(confidence, 0.54);
    } else if (mixedCatchup) {
      // 混合分歧不再一刀切压 LOW。
      // 先允许弱 MID，再由 preRiskMetrics 二次过滤。
      confidence += 0.06;
      confidence = Math.max(confidence, 0.40);
      confidence = Math.min(confidence, 0.52);
    } else {
      confidence = Math.min(confidence, 0.39);
    }
  }

  // 2. 产业链预热：默认是观察信号，不是短线强信号，不能因为结构分高直接 HIGH。
  if (structureType === 'SUPPLY_CHAIN_PREHEAT') {
    // 产业链预热：不是短线强信号，但不是废信号。
    // 默认保持 LOW；只有单股本身强、且非高位分歧时才允许靠近 MID。
    confidence -= 0.02;

    if (isHighPositionDivergence(nodePredictionAnalysis)) {
      confidence -= 0.10;
      confidence = Math.min(confidence, 0.28);
    } else if (rapidGroup === 'EXTEND_UP') {
      confidence += 0.04;
      confidence = Math.min(confidence, 0.38);
    } else {
      confidence = Math.min(confidence, 0.34);
    }

    confidence = Math.max(confidence, 0.12);
  }

  // 3. 趋势中继：必须同时得到单股急变倾向支持，否则最多 MID。
  if (structureType === 'TREND_CONTINUATION') {
    if (rapidGroup !== 'EXTEND_UP') {
      confidence -= 0.08;
      confidence = Math.min(confidence, 0.56);
    }

    // 连续上涨后的分歧 / 高位分歧，最容易把“末端强”误判成“趋势中继”。
    if (/高位|连续上涨|分歧|透支|衰减/.test(rapidTitle)) {
      confidence -= 0.16;
      confidence = Math.min(confidence, 0.46);
    }
  }

  // 4. 风险型结构不允许高置信看多。
  if ([
    'STRUCTURE_OVERHEATED',
    'LATE_CONFIRMATION',
    'PREHEAT_DECAY',
    'ISOLATED_NODE',
    'SHAPE_POSITION_RISK'
  ].includes(structureType) || structureTone === 'risk') {
    confidence = Math.min(confidence, 0.42);
  }

  return roundNumber(Math.max(0, Math.min(1, confidence)), 3);
}

function applyPreRiskConfidenceFilter(confidence, nodePredictionAnalysis, predictionKind, preRiskMetrics) {
  let value = toNumber(confidence, 0.3);

  if (!preRiskMetrics || preRiskMetrics.ok !== true) {
    return roundNumber(Math.max(0, Math.min(1, value)), 3);
  }

  const structureType = getStructureType(nodePredictionAnalysis);
  const rapidTitle = getRapidTitle(nodePredictionAnalysis);

  if (structureType !== 'EXTERNAL_CONFIRMED_TARGET_WEAK' || predictionKind !== 'TARGET_CATCHUP') {
    return roundNumber(Math.max(0, Math.min(1, value)), 3);
  }

  const flags = Array.isArray(preRiskMetrics.riskFlags) ? preRiskMetrics.riskFlags : [];

  // 注意：
  // fix4 验证证明 preRisk=HIGH 不等于失败。
  // 所以这里不再按 riskLevel 大幅压低 TARGET_CATCHUP。
  // preRisk 只作为解释字段保留。

  // 只有“短窗快速衰退 + 标题也偏高位/末端风险”同时出现时，才轻微降权。
  const hasFastFade = flags.includes('PRE5_FAST_FADE');
  const titleRisk = /高位|连续上涨|透支|衰减|回撤|末端|冲高/.test(rapidTitle);

  if (hasFastFade && titleRisk) {
    value -= 0.06;
    value = Math.min(value, 0.39);
  }

  return roundNumber(Math.max(0, Math.min(1, value)), 3);
}

function classifyTypeValidation(kind, horizons) {
  const t3 = horizons[3] || {};
  const t5 = horizons[5] || {};
  const t10 = horizons[10] || {};
  const t20 = horizons[20] || {};

  const t3Close = toNumber(t3.closeReturnPct);
  const t5Close = toNumber(t5.closeReturnPct);
  const t10Close = toNumber(t10.closeReturnPct);
  const t20Close = toNumber(t20.closeReturnPct);
  const t5Max = toNumber(t5.maxReturnPct);
  const t5Drawdown = toNumber(t5.maxDrawdownPct);
  const t10Drawdown = toNumber(t10.maxDrawdownPct);
  const t20Drawdown = toNumber(t20.maxDrawdownPct);

  const hasT5 = Number.isFinite(t5Close);
  const hasT10 = Number.isFinite(t10Close);
  const hasT20 = Number.isFinite(t20Close);

  if (kind === 'EXTEND_UP') {
    if (!hasT5 && !hasT10) {
      return { status: 'UNKNOWN', success: null, reason: 'EXTEND_UP_NO_T5_T10' };
    }

    const positiveConfirm = (Number.isFinite(t5Close) && t5Close > 0)
      || (Number.isFinite(t10Close) && t10Close > 0);
    const drawdownOk = !Number.isFinite(t10Drawdown) || t10Drawdown > -10;

    if (positiveConfirm && drawdownOk) {
      return { status: 'SUCCESS', success: true, reason: 'EXTEND_UP_POSITIVE_WITH_CONTROLLED_DRAWDOWN' };
    }

    return { status: 'FAIL', success: false, reason: 'EXTEND_UP_NOT_EXTENDED' };
  }

    if (kind === 'TARGET_CATCHUP') {
    if (!hasT5 && !hasT10 && !hasT20) {
      return { status: 'UNKNOWN', success: null, reason: 'TARGET_CATCHUP_NO_T5_T10_T20' };
    }

    const catchupConfirmed = (Number.isFinite(t5Close) && t5Close > 0)
      || (Number.isFinite(t10Close) && t10Close > 0)
      || (Number.isFinite(t20Close) && t20Close > 0);

    const drawdownOk = !Number.isFinite(t10Drawdown) || t10Drawdown > -10;

    if (catchupConfirmed && drawdownOk) {
      return { status: 'SUCCESS', success: true, reason: 'TARGET_CATCHUP_CONFIRMED' };
    }

    return { status: 'FAIL', success: false, reason: 'TARGET_CATCHUP_FAILED' };
  }

  if (kind === 'CHAIN_PREHEAT') {
    if (!hasT10 && !hasT20) {
      return { status: 'UNKNOWN', success: null, reason: 'CHAIN_PREHEAT_NO_T10_T20' };
    }

    // 产业链预热不按 T+3/T+5 追涨验证，主要看 T+10/T+20 是否形成中期修复。
    const chainConfirmed = (Number.isFinite(t20Close) && t20Close > 0)
      || (Number.isFinite(t10Close) && t10Close > 2);

    const notBroken = !Number.isFinite(t20Drawdown) || t20Drawdown > -15;

    if (chainConfirmed && notBroken) {
      return { status: 'SUCCESS', success: true, reason: 'CHAIN_PREHEAT_CONFIRMED_T10_T20' };
    }

    return { status: 'FAIL', success: false, reason: 'CHAIN_PREHEAT_FAILED_OR_BROKEN' };
  }

  if (kind === 'LOW_REPAIR' || kind === 'WATCH_REPAIR') {
    if (!hasT10 && !hasT20) {
      return { status: 'UNKNOWN', success: null, reason: 'REPAIR_NO_T10_T20' };
    }

    const repaired = (Number.isFinite(t10Close) && t10Close > 0)
      || (Number.isFinite(t20Close) && t20Close > 0);
    const notBroken = !Number.isFinite(t20Drawdown) || t20Drawdown > -15;

    if (repaired && notBroken) {
      return { status: 'SUCCESS', success: true, reason: 'REPAIR_CONFIRMED' };
    }

    return { status: 'FAIL', success: false, reason: 'REPAIR_FAILED_OR_BROKEN' };
  }

  if (kind === 'SHORT_WINDOW_RISK' || kind === 'RISK_WARNING' || kind === 'RISK_PULLBACK' || kind === 'RISK_REVERSAL') {
    if (!hasT5 && !hasT10) {
      return { status: 'UNKNOWN', success: null, reason: 'RISK_NO_T5_T10' };
    }

    const closeWeak = (Number.isFinite(t5Close) && t5Close <= 0)
      || (Number.isFinite(t10Close) && t10Close <= 0);
    const drawdownHit = (Number.isFinite(t5Drawdown) && t5Drawdown <= -4)
      || (Number.isFinite(t10Drawdown) && t10Drawdown <= -6);
    const rushThenFade = Number.isFinite(t5Max)
      && Number.isFinite(t5Close)
      && t5Max >= 2
      && t5Close <= t5Max - 3;
    const t3ToT10Decay = Number.isFinite(t3Close)
      && Number.isFinite(t10Close)
      && t3Close >= 2
      && t10Close <= t3Close - 4;

    if (kind === 'RISK_PULLBACK') {
      if (drawdownHit || rushThenFade || t3ToT10Decay) {
        return { status: 'SUCCESS', success: true, reason: 'RISK_PULLBACK_HIT' };
      }

      return { status: 'FAIL', success: false, reason: 'RISK_PULLBACK_NOT_HIT' };
    }

    if (kind === 'RISK_REVERSAL') {
      // 反转风险必须更严格：
      // 要么 T10/T20 收盘真的转弱，要么 T20 出现深回撤。
      // 不能只因为中途有普通回撤就算反转命中。
      const reversalHit = closeWeak
        || (Number.isFinite(t10Close) && t10Close <= -5)
        || (Number.isFinite(t20Close) && t20Close <= -5)
        || (Number.isFinite(t20Drawdown) && t20Drawdown <= -15);

      if (reversalHit) {
        return { status: 'SUCCESS', success: true, reason: 'RISK_REVERSAL_HIT' };
      }

      return { status: 'FAIL', success: false, reason: 'RISK_REVERSAL_NOT_HIT' };
    }

    if (closeWeak || drawdownHit || rushThenFade || t3ToT10Decay) {
      return { status: 'SUCCESS', success: true, reason: 'RISK_WARNING_HIT' };
    }

    return { status: 'FAIL', success: false, reason: 'RISK_WARNING_NOT_HIT' };
  }

  if (kind === 'MIXED' || kind === 'UNKNOWN') {
    return { status: 'UNKNOWN', success: null, reason: 'MIXED_NOT_FORCE_VALIDATED' };
  }

  return { status: 'UNKNOWN', success: null, reason: 'NO_TYPE_RULE' };
}

function buildForecastValidation(nodePredictionAnalysis, horizons, modelType = 'raw') {
  const result = {};

  for (const day of DEFAULT_HORIZONS) {
    const actual = horizons[day] || {};
    const actualReturnPct = toNumber(actual.closeReturnPct);
    const forecastReturnPct = isStructureLikeModelType(modelType)
    ? getStructureForecastReturnPct(nodePredictionAnalysis, day)
    : getRawForecastReturnPct(nodePredictionAnalysis, day);
    result[`t${day}`] = {
      day,
      forecastReturnPct: roundNumber(forecastReturnPct),
      actualReturnPct: roundNumber(actualReturnPct),
      forecastDirection: direction(forecastReturnPct),
      actualDirection: direction(actualReturnPct),
      directionHit: directionHit(forecastReturnPct, actualReturnPct),
      errorPct: Number.isFinite(forecastReturnPct) && Number.isFinite(actualReturnPct)
        ? roundNumber(actualReturnPct - forecastReturnPct)
        : null
    };
  }

  return result;
}

function buildNodePredictionValidation(options = {}) {
  const bars = Array.isArray(options.bars) ? options.bars : [];
  const clickedIndex = Number(options.clickedIndex);
  const nodePredictionAnalysis = options.nodePredictionAnalysis || {};
  const modelType = String(options.modelType || 'raw');

  const horizons = {};

  for (const day of DEFAULT_HORIZONS) {
    horizons[day] = buildActualHorizonMetrics(bars, clickedIndex, day);
  }

  const rawPredictionKind = derivePredictionKind(nodePredictionAnalysis, modelType);
  const predictionKind = applyMarketPredictionKindFilter(
    rawPredictionKind,
    nodePredictionAnalysis,
    modelType
  );

  const preRiskMetrics = buildPreRiskMetrics(bars, clickedIndex);
  const typeValidation = classifyTypeValidation(predictionKind, horizons);
  const forecastValidation = buildForecastValidation(nodePredictionAnalysis, horizons, modelType);

  const rawConfidence = getConfidence(nodePredictionAnalysis, modelType);
  const marketFilteredConfidence = applyMarketConfidenceFilter(
    rawConfidence,
    nodePredictionAnalysis,
    rawPredictionKind,
    predictionKind,
    modelType
  );

  const confidence = isStructureLikeModelType(modelType)
    ? applyPreRiskConfidenceFilter(marketFilteredConfidence, nodePredictionAnalysis, predictionKind, preRiskMetrics)
    : marketFilteredConfidence;

  return {
    version: NODE_PREDICTION_VALIDATION_VERSION,
    ok: true,
    modelType,
    rawPredictionKind,
    predictionKind,
    confidence,
    confidenceBand: getConfidenceBand(confidence),
    preRiskMetrics,
    rapidGroup: nodePredictionAnalysis
      && nodePredictionAnalysis.rapidTypePrediction
      && nodePredictionAnalysis.rapidTypePrediction.predictedRapidGroup
        ? nodePredictionAnalysis.rapidTypePrediction.predictedRapidGroup
        : 'UNKNOWN',
    rapidTitle: nodePredictionAnalysis
      && nodePredictionAnalysis.rapidTypePrediction
      && nodePredictionAnalysis.rapidTypePrediction.predictedRapidTitle
        ? nodePredictionAnalysis.rapidTypePrediction.predictedRapidTitle
        : '',
    structureType: getStructureType(nodePredictionAnalysis),
    structureTitle: getStructureTitle(nodePredictionAnalysis),
    structureTone: getStructureTone(nodePredictionAnalysis),
    typeValidation,
    forecastValidation,
    horizons,
    warning: 'validation 是事后验证层，可以读取 T0 后真实走势；禁止把 validation 输出反向传入 prediction / forecast / signal / confidence。'
  };
}

function flattenValidationRow(base, validation) {
  const row = {
    ...(base || {}),
    modelType: validation.modelType,
    rawPredictionKind: validation.rawPredictionKind || validation.predictionKind,
    predictionKind: validation.predictionKind,
    confidence: validation.confidence,
    confidenceBand: validation.confidenceBand,
    rapidGroup: validation.rapidGroup,
    rapidTitle: validation.rapidTitle,
    structureType: validation.structureType,
    structureTitle: validation.structureTitle,
    structureTone: validation.structureTone,
    validationStatus: validation.typeValidation.status,
    validationSuccess: validation.typeValidation.success,
    validationReason: validation.typeValidation.reason,
    preRiskLevel: validation.preRiskMetrics && validation.preRiskMetrics.riskLevel
      ? validation.preRiskMetrics.riskLevel
      : '',
    preRiskFlags: validation.preRiskMetrics && Array.isArray(validation.preRiskMetrics.riskFlags)
      ? validation.preRiskMetrics.riskFlags.join('|')
      : '',
    pre5RangePct: validation.preRiskMetrics && validation.preRiskMetrics.w5
      ? validation.preRiskMetrics.w5.rangePct
      : null,
    pre10RangePct: validation.preRiskMetrics && validation.preRiskMetrics.w10
      ? validation.preRiskMetrics.w10.rangePct
      : null,
    pre20RangePct: validation.preRiskMetrics && validation.preRiskMetrics.w20
      ? validation.preRiskMetrics.w20.rangePct
      : null,
    pre5DrawdownFromHighPct: validation.preRiskMetrics && validation.preRiskMetrics.w5
      ? validation.preRiskMetrics.w5.drawdownFromHighPct
      : null,
    pre10DrawdownFromHighPct: validation.preRiskMetrics && validation.preRiskMetrics.w10
      ? validation.preRiskMetrics.w10.drawdownFromHighPct
      : null,
    pre20DrawdownFromHighPct: validation.preRiskMetrics && validation.preRiskMetrics.w20
      ? validation.preRiskMetrics.w20.drawdownFromHighPct
      : null
  };

  for (const day of DEFAULT_HORIZONS) {
    const horizon = validation.horizons[day] || {};
    const forecast = validation.forecastValidation[`t${day}`] || {};

    row[`t${day}ReturnPct`] = horizon.closeReturnPct;
    row[`t${day}MaxReturnPct`] = horizon.maxReturnPct;
    row[`t${day}MaxDrawdownPct`] = horizon.maxDrawdownPct;
    row[`t${day}ForecastPct`] = forecast.forecastReturnPct;
    row[`t${day}DirectionHit`] = forecast.directionHit;
    row[`t${day}ForecastErrorPct`] = forecast.errorPct;
  }

  return row;
}

function summarizeValidationRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const validTypeRows = list.filter((row) => typeof row.validationSuccess === 'boolean');
  const highRows = list.filter((row) => row.confidenceBand === 'HIGH');
  const lowRows = list.filter((row) => row.confidenceBand === 'LOW');

  function hitRateFor(day) {
    const key = `t${day}DirectionHit`;
    const valid = list.filter((row) => typeof row[key] === 'boolean');
    return rate(valid, (row) => row[key] === true);
  }

  return {
    sampleCount: list.length,
    typeValidatedCount: validTypeRows.length,
    typeSuccessRate: roundNumber(rate(validTypeRows, (row) => row.validationSuccess === true), 1),
    badPredictionRate: roundNumber(rate(validTypeRows, (row) => row.validationSuccess === false), 1),

    positiveRateT3: roundNumber(rate(list.filter((row) => Number.isFinite(toNumber(row.t3ReturnPct))), (row) => row.t3ReturnPct > 0), 1),
    positiveRateT5: roundNumber(rate(list.filter((row) => Number.isFinite(toNumber(row.t5ReturnPct))), (row) => row.t5ReturnPct > 0), 1),
    positiveRateT10: roundNumber(rate(list.filter((row) => Number.isFinite(toNumber(row.t10ReturnPct))), (row) => row.t10ReturnPct > 0), 1),
    positiveRateT20: roundNumber(rate(list.filter((row) => Number.isFinite(toNumber(row.t20ReturnPct))), (row) => row.t20ReturnPct > 0), 1),

    avgReturnT3: roundNumber(average(list.map((row) => row.t3ReturnPct))),
    avgReturnT5: roundNumber(average(list.map((row) => row.t5ReturnPct))),
    avgReturnT10: roundNumber(average(list.map((row) => row.t10ReturnPct))),
    avgReturnT20: roundNumber(average(list.map((row) => row.t20ReturnPct))),

    medianReturnT3: roundNumber(median(list.map((row) => row.t3ReturnPct))),
    medianReturnT5: roundNumber(median(list.map((row) => row.t5ReturnPct))),
    medianReturnT10: roundNumber(median(list.map((row) => row.t10ReturnPct))),
    medianReturnT20: roundNumber(median(list.map((row) => row.t20ReturnPct))),

    directionHitT3: roundNumber(hitRateFor(3), 1),
    directionHitT5: roundNumber(hitRateFor(5), 1),
    directionHitT10: roundNumber(hitRateFor(10), 1),
    directionHitT20: roundNumber(hitRateFor(20), 1),

    highConfidenceSampleCount: highRows.length,
    highConfidenceTypeSuccessRate: roundNumber(rate(highRows.filter((row) => typeof row.validationSuccess === 'boolean'), (row) => row.validationSuccess === true), 1),
    highConfidencePositiveRateT5: roundNumber(rate(highRows.filter((row) => Number.isFinite(toNumber(row.t5ReturnPct))), (row) => row.t5ReturnPct > 0), 1),

    lowConfidenceSampleCount: lowRows.length,
    lowConfidenceTypeSuccessRate: roundNumber(rate(lowRows.filter((row) => typeof row.validationSuccess === 'boolean'), (row) => row.validationSuccess === true), 1),
    lowConfidencePositiveRateT5: roundNumber(rate(lowRows.filter((row) => Number.isFinite(toNumber(row.t5ReturnPct))), (row) => row.t5ReturnPct > 0), 1)
  };
}

function groupValidationRows(rows, keyName) {
  const map = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = String(row && row[keyName] || 'UNKNOWN');
    const bucket = map.get(key) || [];
    bucket.push(row);
    map.set(key, bucket);
  });

  return Array.from(map.entries())
    .map(([key, bucket]) => ({
      key,
      ...summarizeValidationRows(bucket)
    }))
    .sort((left, right) => Number(right.sampleCount || 0) - Number(left.sampleCount || 0));
}

module.exports = {
  NODE_PREDICTION_VALIDATION_VERSION,
  DEFAULT_HORIZONS,
  toNumber,
  roundNumber,
  average,
  median,
  direction,
  directionHit,
  isStructureLikeModelType,
  getRawForecastReturnPct,
  getStructureForecastReturnPct,
  buildActualHorizonMetrics,
  derivePredictionKind,
  getConfidence,
  classifyTypeValidation,
  buildNodePredictionValidation,
  flattenValidationRow,
  summarizeValidationRows,
  groupValidationRows,
  getConfidenceBand,
  buildPreRiskMetrics,
  applyPreRiskConfidenceFilter,
  getMarketEnvironment,
  getMarketRegime,
  getMarketBias,
  isMarketContextReady,
  isHostileMarket,
  isSupportiveMarket,
  applyMarketPredictionKindFilter,
  applyMarketConfidenceFilter
};