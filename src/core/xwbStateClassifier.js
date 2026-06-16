const {
  sma,
  rollingMaxExclusive,
  rollingMaxInclusive,
  rollingMinInclusive
} = require('./signalEngine');

const STATE_NAMES = {
  LOW_STARTING: '低位启动型变化',
  MID_TREND_CONTINUING: '中位趋势延续',
  HIGH_CHASE_RISK: '高位追涨风险',
  HIGH_VOLUME_STALL: '高位放量滞涨',
  PULLBACK_REPAIR: '回踩修复',
  LOW_WEAK_OBSERVE: '低位弱势观察',
  BREAKDOWN_RISK: '破位风险',
  SIDEWAYS_WAITING: '横盘观察',
  UNKNOWN_STATE: '未明确状态'
};

function getNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

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

function pctChangePct(current, base) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) {
    return null;
  }

  return ((current - base) / base) * 100;
}

function calcRangePosition(close, low, high) {
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return null;
  }

  return clamp((close - low) / (high - low), 0, 1);
}

function calcVolumeRatio(bars, index, period) {
  const volume = getNumber(bars[index] && bars[index].volume);
  const volumeMa = sma(bars, index - 1, period, 'volume');

  if (volume === null || volumeMa === null || volumeMa <= 0) {
    return null;
  }

  return volume / volumeMa;
}

function calcFutureReturn(bars, index, days) {
  const close = getNumber(bars[index] && bars[index].close);
  const futureClose = getNumber(bars[index + days] && bars[index + days].close);

  if (close === null || close <= 0 || futureClose === null || futureClose <= 0) {
    return null;
  }

  const value = ((futureClose - close) / close) * 100;

  // 复权断层、异常价格会污染状态统计。这里不把极端异常当真实未来收益。
  if (!Number.isFinite(value) || Math.abs(value) > 200) {
    return null;
  }

  return roundNumber(value);
}

function getStateName(stateCode) {
  return STATE_NAMES[stateCode] || STATE_NAMES.UNKNOWN_STATE;
}

function hasLabel(section, label) {
  return Boolean(section && Array.isArray(section.labels) && section.labels.includes(label));
}

function pickType(labels, priority, fallback) {
  return priority.find((label) => labels.includes(label)) || fallback;
}

function addLabel(target, label, reason) {
  if (!target.labels.includes(label)) {
    target.labels.push(label);
  }

  if (reason) {
    target.reasons.push(reason);
  }
}

function getIndicators(bars, index) {
  const bar = bars[index] || {};
  const prevBar = bars[index - 1] || {};
  const close = getNumber(bar.close);
  const open = getNumber(bar.open);
  const high = getNumber(bar.high);
  const low = getNumber(bar.low);
  const volume = getNumber(bar.volume);
  const prevClose = getNumber(prevBar.close);
  const close3Ago = getNumber(bars[index - 3] && bars[index - 3].close);
  const close5Ago = getNumber(bars[index - 5] && bars[index - 5].close);
  const close10Ago = getNumber(bars[index - 10] && bars[index - 10].close);
  const close20Ago = getNumber(bars[index - 20] && bars[index - 20].close);
  const ma5 = sma(bars, index, 5, 'close');
  const ma10 = sma(bars, index, 10, 'close');
  const ma20 = sma(bars, index, 20, 'close');
  const ma60 = sma(bars, index, 60, 'close');
  const ma120 = sma(bars, index, 120, 'close');
  const ma250 = sma(bars, index, 250, 'close');
  const prevMa5 = sma(bars, index - 1, 5, 'close');
  const prevMa10 = sma(bars, index - 1, 10, 'close');
  const prevMa20 = sma(bars, index - 1, 20, 'close');
  const prevMa60 = sma(bars, index - 1, 60, 'close');
  const high20 = rollingMaxInclusive(bars, index, 20, 'high');
  const low20 = rollingMinInclusive(bars, index, 20, 'low');
  const high60 = rollingMaxInclusive(bars, index, 60, 'high');
  const low60 = rollingMinInclusive(bars, index, 60, 'low');
  const high120 = rollingMaxInclusive(bars, index, 120, 'high');
  const low120 = rollingMinInclusive(bars, index, 120, 'low');
  const high250 = rollingMaxInclusive(bars, index, 250, 'high');
  const low250 = rollingMinInclusive(bars, index, 250, 'low');
  const priorHigh20 = rollingMaxExclusive(bars, index, 20, 'high');
  const priorHigh60 = rollingMaxExclusive(bars, index, 60, 'high');
  const priorLow20 = index >= 20 ? rollingMinInclusive(bars, index - 1, 20, 'low') : null;
  const range = high !== null && low !== null ? high - low : null;
  const upperShadowPct = range !== null && range > 0 && open !== null && close !== null
    ? ((high - Math.max(open, close)) / range) * 100
    : null;
  const bodyReturnPct = pctChangePct(close, open);
  const dayReturnPct = pctChangePct(close, prevClose);

  return {
    close,
    open,
    high,
    low,
    volume,
    prevClose,
    ma5,
    ma10,
    ma20,
    ma60,
    ma120,
    ma250,
    prevMa5,
    prevMa10,
    prevMa20,
    prevMa60,
    high20,
    low20,
    high60,
    low60,
    high120,
    low120,
    high250,
    low250,
    priorHigh20,
    priorHigh60,
    priorLow20,
    range60: calcRangePosition(close, low60, high60),
    range120: calcRangePosition(close, low120, high120),
    range250: calcRangePosition(close, low250, high250),
    volumeRatio5: calcVolumeRatio(bars, index, 5),
    volumeRatio20: calcVolumeRatio(bars, index, 20),
    upperShadowPct,
    bodyReturnPct,
    dayReturnPct,
    return3: pctChangePct(close, close3Ago),
    return5: pctChangePct(close, close5Ago),
    return10: pctChangePct(close, close10Ago),
    return20: pctChangePct(close, close20Ago),
    aboveMa60: close !== null && ma60 !== null ? close >= ma60 : null,
    aboveMa120: close !== null && ma120 !== null ? close >= ma120 : null,
    aboveMa250: close !== null && ma250 !== null ? close >= ma250 : null
  };
}

function classifyShape(indicators) {
  const result = {
    type: 'UNKNOWN_SHAPE',
    score: 0,
    labels: [],
    reasons: []
  };
  const i = indicators;
  const volumeBreakout = (
    i.close !== null &&
    i.priorHigh20 !== null &&
    i.volumeRatio20 !== null &&
    i.volumeRatio20 >= 1.35 &&
    i.close >= i.priorHigh20 * 0.995 &&
    (i.dayReturnPct === null || i.dayReturnPct >= 0.8)
  );
  const maTurnStrong = (
    i.ma5 !== null &&
    i.ma10 !== null &&
    i.ma20 !== null &&
    i.prevMa5 !== null &&
    i.prevMa10 !== null &&
    i.ma5 >= i.ma10 * 0.995 &&
    i.ma10 >= i.ma20 * 0.985 &&
    i.ma5 >= i.prevMa5 &&
    i.ma10 >= i.prevMa10 * 0.995
  );
  const closeAboveKeyMa = (
    i.close !== null &&
    (
      (i.ma20 !== null && i.prevClose !== null && i.prevMa20 !== null && i.close > i.ma20 && i.prevClose <= i.prevMa20) ||
      (i.ma60 !== null && i.prevClose !== null && i.prevMa60 !== null && i.close > i.ma60 && i.prevClose <= i.prevMa60)
    )
  );
  const highWaveRisk = (
    i.upperShadowPct !== null &&
    i.upperShadowPct >= 45 &&
    i.high !== null &&
    i.close !== null &&
    i.high >= i.close * 1.018
  );
  const weakBreakdown = (
    i.close !== null &&
    (
      (i.ma20 !== null && i.prevClose !== null && i.prevMa20 !== null && i.close < i.ma20 && i.prevClose >= i.prevMa20) ||
      (i.priorLow20 !== null && i.close <= i.priorLow20 * 0.995)
    )
  );
  const shrinkPullback = (
    i.volumeRatio20 !== null &&
    i.volumeRatio20 <= 0.82 &&
    i.return5 !== null &&
    i.return5 <= 0.8 &&
    i.return5 >= -8 &&
    i.close !== null &&
    (
      (i.ma20 !== null && i.close >= i.ma20 * 0.96) ||
      (i.ma60 !== null && i.close >= i.ma60 * 0.97)
    )
  );
  const range20Pct = i.high20 !== null && i.low20 !== null && i.close !== null && i.close > 0
    ? ((i.high20 - i.low20) / i.close) * 100
    : null;
  const sidewaysAccumulation = (
    range20Pct !== null &&
    range20Pct <= 8 &&
    i.volumeRatio20 !== null &&
    i.volumeRatio20 <= 1.15 &&
    i.close !== null &&
    i.ma20 !== null &&
    Math.abs(pctChangePct(i.close, i.ma20) || 0) <= 5
  );

  if (volumeBreakout) addLabel(result, 'VOLUME_BREAKOUT', '放量接近或突破近 20 日压力');
  if (maTurnStrong) addLabel(result, 'MA_TURN_STRONG', '短中期均线结构转强');
  if (closeAboveKeyMa) addLabel(result, 'CLOSE_ABOVE_KEY_MA', '收盘站上关键均线');
  if (highWaveRisk) addLabel(result, 'HIGH_WAVE_RISK', '出现长上影或冲高回落');
  if (weakBreakdown) addLabel(result, 'WEAK_BREAKDOWN', '收盘跌破关键均线或近 20 日支撑');
  if (shrinkPullback) addLabel(result, 'SHRINK_PULLBACK', '缩量回踩且仍接近中期均线');
  if (sidewaysAccumulation) addLabel(result, 'SIDEWAYS_ACCUMULATION', '近 20 日窄幅横盘蓄势');

  result.type = pickType(result.labels, [
    'WEAK_BREAKDOWN',
    'HIGH_WAVE_RISK',
    'VOLUME_BREAKOUT',
    'MA_TURN_STRONG',
    'CLOSE_ABOVE_KEY_MA',
    'SHRINK_PULLBACK',
    'SIDEWAYS_ACCUMULATION'
  ], 'UNKNOWN_SHAPE');
  result.score = clamp(result.labels.length * 16 + (volumeBreakout ? 18 : 0) + (weakBreakdown ? 14 : 0), 0, 100);

  if (result.labels.length === 0) {
    result.labels.push('UNKNOWN_SHAPE');
    result.reasons.push('未识别出明确形态');
  }

  return result;
}

function classifyPosition(indicators) {
  const result = {
    type: 'MID_AREA',
    score: 0,
    labels: [],
    reasons: [],
    range60: roundNumber(indicators.range60, 4),
    range120: roundNumber(indicators.range120, 4),
    range250: roundNumber(indicators.range250, 4),
    aboveMa60: indicators.aboveMa60,
    aboveMa120: indicators.aboveMa120,
    aboveMa250: indicators.aboveMa250
  };
  const range = indicators.range250 !== null ? indicators.range250 : (
    indicators.range120 !== null ? indicators.range120 : indicators.range60
  );

  if (range === null) {
    addLabel(result, 'MID_AREA', '长期区间数据不足，暂按中位观察');
  } else if (range <= 0.35) {
    addLabel(result, 'LOW_AREA', '处于历史区间低位区域');
  } else if (range <= 0.7) {
    addLabel(result, 'MID_AREA', '处于历史区间中位区域');
  } else {
    addLabel(result, 'HIGH_AREA', '处于历史区间高位区域');
  }

  if (indicators.aboveMa120 === true || indicators.aboveMa250 === true) {
    addLabel(result, 'ABOVE_LONG_MA', '价格处在长期均线之上');
  }

  if (indicators.aboveMa120 === false && (indicators.aboveMa250 === false || indicators.ma250 === null)) {
    addLabel(result, 'BELOW_LONG_MA', '价格处在长期均线之下');
  }

  const nearPressure = (
    indicators.close !== null &&
    (
      (indicators.priorHigh60 !== null && indicators.close >= indicators.priorHigh60 * 0.97) ||
      (indicators.high120 !== null && indicators.close >= indicators.high120 * 0.97)
    )
  );
  const nearSupport = (
    indicators.close !== null &&
    (
      (indicators.low60 !== null && indicators.close <= indicators.low60 * 1.05) ||
      (indicators.ma60 !== null && Math.abs(pctChangePct(indicators.close, indicators.ma60) || 0) <= 3)
    )
  );
  const highChaseRisk = (
    result.labels.includes('HIGH_AREA') &&
    (
      nearPressure ||
      (indicators.return20 !== null && indicators.return20 >= 12) ||
      (indicators.volumeRatio20 !== null && indicators.volumeRatio20 >= 1.4)
    )
  );

  if (nearPressure) addLabel(result, 'NEAR_PRESSURE', '接近前期压力位');
  if (nearSupport) addLabel(result, 'NEAR_SUPPORT', '接近支撑位或长期均线');
  if (highChaseRisk) addLabel(result, 'HIGH_CHASE_RISK', '高位叠加追涨风险');

  result.type = pickType(result.labels, [
    'HIGH_CHASE_RISK',
    'LOW_AREA',
    'MID_AREA',
    'HIGH_AREA',
    'ABOVE_LONG_MA',
    'BELOW_LONG_MA',
    'NEAR_PRESSURE',
    'NEAR_SUPPORT'
  ], 'MID_AREA');
  result.score = clamp(
    (result.labels.includes('ABOVE_LONG_MA') ? 18 : 0) +
    (result.labels.includes('NEAR_SUPPORT') ? 14 : 0) +
    (result.labels.includes('LOW_AREA') ? 22 : 0) +
    (result.labels.includes('MID_AREA') ? 18 : 0) +
    (result.labels.includes('HIGH_AREA') ? 10 : 0) -
    (result.labels.includes('HIGH_CHASE_RISK') ? 14 : 0) -
    (result.labels.includes('BELOW_LONG_MA') ? 10 : 0),
    0,
    100
  );

  return result;
}

function classifyChange(indicators, shape, position) {
  const result = {
    type: 'UNKNOWN_CHANGE',
    score: 0,
    labels: [],
    reasons: []
  };
  const maTurningUp = (
    indicators.ma5 !== null &&
    indicators.ma10 !== null &&
    indicators.prevMa5 !== null &&
    indicators.ma5 >= indicators.ma10 * 0.995 &&
    indicators.ma5 >= indicators.prevMa5
  );
  const maTurningDown = (
    indicators.ma5 !== null &&
    indicators.ma10 !== null &&
    indicators.prevMa5 !== null &&
    indicators.ma5 < indicators.ma10 &&
    indicators.ma5 < indicators.prevMa5
  );
  const strengthening = (
    maTurningUp &&
    indicators.close !== null &&
    indicators.ma20 !== null &&
    indicators.close >= indicators.ma20 &&
    (indicators.return5 === null || indicators.return5 >= -1)
  );
  const weakening = (
    maTurningDown ||
    (
      indicators.close !== null &&
      indicators.ma20 !== null &&
      indicators.close < indicators.ma20 &&
      indicators.return5 !== null &&
      indicators.return5 < 0
    )
  );
  const continuingUp = (
    indicators.close !== null &&
    indicators.ma5 !== null &&
    indicators.ma10 !== null &&
    indicators.ma20 !== null &&
    indicators.close > indicators.ma20 &&
    indicators.ma5 >= indicators.ma10 &&
    indicators.ma10 >= indicators.ma20 * 0.99 &&
    indicators.return10 !== null &&
    indicators.return10 > 0
  );
  const continuingDown = (
    indicators.close !== null &&
    indicators.ma5 !== null &&
    indicators.ma10 !== null &&
    indicators.ma20 !== null &&
    indicators.close < indicators.ma20 &&
    indicators.ma5 <= indicators.ma10 &&
    indicators.ma10 <= indicators.ma20 &&
    indicators.return10 !== null &&
    indicators.return10 < 0
  );
  const pullbackStable = (
    hasLabel(shape, 'SHRINK_PULLBACK') &&
    indicators.priorLow20 !== null &&
    indicators.low !== null &&
    indicators.low >= indicators.priorLow20 * 0.995 &&
    (indicators.aboveMa60 === true || indicators.aboveMa120 === true || hasLabel(position, 'NEAR_SUPPORT'))
  );
  const failedBreakout = (
    indicators.high !== null &&
    indicators.priorHigh20 !== null &&
    indicators.close !== null &&
    indicators.high >= indicators.priorHigh20 * 1.005 &&
    indicators.close < indicators.priorHigh20 &&
    hasLabel(shape, 'HIGH_WAVE_RISK')
  );
  const volumePriceDivergence = (
    indicators.volumeRatio20 !== null &&
    indicators.volumeRatio20 >= 1.45 &&
    indicators.dayReturnPct !== null &&
    indicators.dayReturnPct <= 0.8 &&
    (hasLabel(position, 'HIGH_AREA') || hasLabel(position, 'NEAR_PRESSURE'))
  );

  if (strengthening) addLabel(result, 'STRENGTHENING', '短期均线与价格同步走强');
  if (weakening) addLabel(result, 'WEAKENING', '短期结构转弱');
  if (continuingUp) addLabel(result, 'CONTINUING_UP', '上行趋势延续');
  if (continuingDown) addLabel(result, 'CONTINUING_DOWN', '下跌趋势延续');
  if (pullbackStable) addLabel(result, 'PULLBACK_STABLE', '缩量回踩后低点稳定');
  if (failedBreakout) addLabel(result, 'FAILED_BREAKOUT', '盘中突破后未能站稳');
  if (volumePriceDivergence) addLabel(result, 'VOLUME_PRICE_DIVERGENCE', '放量但价格推进不足');

  result.type = pickType(result.labels, [
    'FAILED_BREAKOUT',
    'VOLUME_PRICE_DIVERGENCE',
    'WEAKENING',
    'CONTINUING_DOWN',
    'PULLBACK_STABLE',
    'STRENGTHENING',
    'CONTINUING_UP'
  ], 'UNKNOWN_CHANGE');
  result.score = clamp(result.labels.length * 17 + (strengthening || continuingUp ? 10 : 0), 0, 100);

  if (result.labels.length === 0) {
    result.labels.push('UNKNOWN_CHANGE');
    result.reasons.push('变化方向不明确');
  }

  return result;
}

function buildStateSummary(shape, position, change) {
  const parts = [
    shape.reasons[0] || '形态未明确',
    position.reasons[0] || '位置语境不明确',
    change.reasons[0] || '变化方向不明确'
  ];

  return parts.join('；');
}

function classifyCompositeState(shape, position, change) {
  const lowArea = hasLabel(position, 'LOW_AREA');
  const midArea = hasLabel(position, 'MID_AREA');
  const highArea = hasLabel(position, 'HIGH_AREA') || hasLabel(position, 'HIGH_CHASE_RISK');
  const aboveLongMa = hasLabel(position, 'ABOVE_LONG_MA');
  const belowLongMa = hasLabel(position, 'BELOW_LONG_MA');
  const breakoutOrTurn = hasLabel(shape, 'VOLUME_BREAKOUT') || hasLabel(shape, 'MA_TURN_STRONG') || hasLabel(shape, 'CLOSE_ABOVE_KEY_MA');
  const trendShape = hasLabel(shape, 'MA_TURN_STRONG') || hasLabel(shape, 'CLOSE_ABOVE_KEY_MA');
  const stronger = hasLabel(change, 'STRENGTHENING') || hasLabel(change, 'CONTINUING_UP');
  const weaker = hasLabel(shape, 'WEAK_BREAKDOWN') || hasLabel(change, 'WEAKENING') || hasLabel(change, 'CONTINUING_DOWN');
  const stall = hasLabel(shape, 'HIGH_WAVE_RISK') || hasLabel(change, 'FAILED_BREAKOUT') || hasLabel(change, 'VOLUME_PRICE_DIVERGENCE');

  let stateCode = 'UNKNOWN_STATE';

  if (lowArea && weaker && belowLongMa) {
    stateCode = 'LOW_WEAK_OBSERVE';
  } else if (weaker) {
    stateCode = 'BREAKDOWN_RISK';
  } else if (highArea && hasLabel(shape, 'VOLUME_BREAKOUT') && stall) {
    stateCode = 'HIGH_VOLUME_STALL';
  } else if (highArea && breakoutOrTurn) {
    stateCode = 'HIGH_CHASE_RISK';
  } else if ((aboveLongMa || midArea) && hasLabel(shape, 'SHRINK_PULLBACK') && hasLabel(change, 'PULLBACK_STABLE')) {
    stateCode = 'PULLBACK_REPAIR';
  } else if (lowArea && breakoutOrTurn && stronger) {
    stateCode = 'LOW_STARTING';
  } else if (midArea && trendShape && (hasLabel(change, 'CONTINUING_UP') || stronger)) {
    stateCode = 'MID_TREND_CONTINUING';
  } else if (hasLabel(shape, 'SIDEWAYS_ACCUMULATION') && hasLabel(change, 'UNKNOWN_CHANGE')) {
    stateCode = 'SIDEWAYS_WAITING';
  }

  return {
    stateCode,
    stateName: getStateName(stateCode),
    stateSummary: buildStateSummary(shape, position, change)
  };
}

function classifyXwbStateForBar(bars, index) {
  const bar = bars[index] || {};
  const indicators = getIndicators(bars, index);
  const shape = classifyShape(indicators);
  const position = classifyPosition(indicators);
  const change = classifyChange(indicators, shape, position);
  const state = classifyCompositeState(shape, position, change);

  return {
    date: bar.date,
    close: getNumber(bar.close),
    shape,
    position,
    change,
    stateCode: state.stateCode,
    stateName: state.stateName,
    stateSummary: state.stateSummary,
    futureReturns: {
      d5: calcFutureReturn(bars, index, 5),
      d10: calcFutureReturn(bars, index, 10),
      d20: calcFutureReturn(bars, index, 20)
    }
  };
}

function classifyXwbStates(bars) {
  if (!Array.isArray(bars)) {
    return [];
  }

  return bars.map((bar, index) => classifyXwbStateForBar(bars, index));
}

module.exports = {
  STATE_NAMES,
  classifyXwbStateForBar,
  classifyXwbStates
};
