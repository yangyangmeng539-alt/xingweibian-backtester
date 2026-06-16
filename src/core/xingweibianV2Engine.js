const {
  sma,
  rollingMaxExclusive,
  rollingMaxInclusive,
  rollingMinInclusive
} = require('./signalEngine');
const {
  DEFAULT_FEE_CONFIG,
  resolveFeeConfig,
  calculateBuyFee,
  calculateSellFee,
  applyBuySlippage,
  applySellSlippage,
  roundMoney
} = require('./feeEngine');
const { calcFutureReturns } = require('./changeEngine');

const XINGWEIBIAN_V2_VERSION = 'xingweibian-v2';
const LOT_SIZE = 100;
const WARMUP_DAYS = 120;

const REJECT_REASONS = {
  SHAPE_NOT_PASSED: 'SHAPE_NOT_PASSED',
  POSITION_TOO_HIGH: 'POSITION_TOO_HIGH',
  POSITION_WEAK: 'POSITION_WEAK',
  DOWNTREND_FILTERED: 'DOWNTREND_FILTERED',
  CHANGE_NOT_CONFIRMED: 'CHANGE_NOT_CONFIRMED',
  HIGH_ZONE_NO_BREAKOUT: 'HIGH_ZONE_NO_BREAKOUT',
  INSUFFICIENT_CASH_LOT: 'INSUFFICIENT_CASH_LOT',
  HOLDING_ALREADY: 'HOLDING_ALREADY',
  BUY_EXECUTED: 'BUY_EXECUTED',
  SELL_STOP_LOSS: 'SELL_STOP_LOSS',
  SELL_TREND_BROKEN: 'SELL_TREND_BROKEN',
  SELL_TRAILING_STOP: 'SELL_TRAILING_STOP',
  SELL_TIME_EXIT: 'SELL_TIME_EXIT',
  SELL_CHANGE_FAILED: 'SELL_CHANGE_FAILED'
};

function getNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pctChangePct(current, base) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) {
    return null;
  }

  return ((current - base) / base) * 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function calcRangePosition(close, low, high) {
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return null;
  }

  return clamp((close - low) / (high - low), 0, 1);
}

function classifyPositionZone(position) {
  if (!Number.isFinite(position)) {
    return 'UNKNOWN';
  }

  if (position <= 0.35) {
    return 'LOW_ZONE';
  }

  if (position <= 0.7) {
    return 'MID_ZONE';
  }

  return 'HIGH_ZONE';
}

function rollingMinExclusive(bars, currentIndex, period, field) {
  return rollingMinInclusive(bars, currentIndex - 1, period, field);
}

function calcVolumeRatio(bars, index, period) {
  const volume = getNumber(bars[index] && bars[index].volume);
  const volumeMa = sma(bars, index - 1, period, 'volume');

  if (volume === null || volumeMa === null || volumeMa <= 0) {
    return null;
  }

  return volume / volumeMa;
}

function calcAverageAmplitude(bars, index, period) {
  if (index < period - 1) {
    return null;
  }

  const values = [];

  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const bar = bars[cursor];
    const high = getNumber(bar && bar.high);
    const low = getNumber(bar && bar.low);
    const close = getNumber(bar && bar.close);

    if (high === null || low === null || close === null || close <= 0) {
      return null;
    }

    values.push(((high - low) / close) * 100);
  }

  return average(values);
}

function calcCloseStrength(bars, index, period) {
  const close = getNumber(bars[index] && bars[index].close);
  const high = rollingMaxInclusive(bars, index, period, 'high');
  const low = rollingMinInclusive(bars, index, period, 'low');

  return calcRangePosition(close, low, high);
}

function countDownCloses(bars, index, period) {
  let count = 0;

  for (let cursor = Math.max(1, index - period + 1); cursor <= index; cursor += 1) {
    const close = getNumber(bars[cursor] && bars[cursor].close);
    const prevClose = getNumber(bars[cursor - 1] && bars[cursor - 1].close);

    if (close !== null && prevClose !== null && close < prevClose) {
      count += 1;
    }
  }

  return count;
}

function getIndicators(bars, index) {
  const bar = bars[index] || {};
  const close = getNumber(bar.close);
  const open = getNumber(bar.open);
  const high = getNumber(bar.high);
  const low = getNumber(bar.low);
  const volume = getNumber(bar.volume);
  const prevClose = getNumber(bars[index - 1] && bars[index - 1].close);
  const close3Ago = getNumber(bars[index - 3] && bars[index - 3].close);
  const close5Ago = getNumber(bars[index - 5] && bars[index - 5].close);
  const close10Ago = getNumber(bars[index - 10] && bars[index - 10].close);
  const close20Ago = getNumber(bars[index - 20] && bars[index - 20].close);

  const ma5 = sma(bars, index, 5, 'close');
  const ma10 = sma(bars, index, 10, 'close');
  const ma20 = sma(bars, index, 20, 'close');
  const ma60 = sma(bars, index, 60, 'close');
  const prevMa5 = sma(bars, index - 1, 5, 'close');
  const prevMa20 = sma(bars, index - 1, 20, 'close');

  const high20 = rollingMaxInclusive(bars, index, 20, 'high');
  const low20 = rollingMinInclusive(bars, index, 20, 'low');
  const high60 = rollingMaxInclusive(bars, index, 60, 'high');
  const low60 = rollingMinInclusive(bars, index, 60, 'low');
  const high120 = rollingMaxInclusive(bars, index, 120, 'high');
  const low120 = rollingMinInclusive(bars, index, 120, 'low');
  const priorHigh20 = rollingMaxExclusive(bars, index, 20, 'high');
  const priorHigh60 = rollingMaxExclusive(bars, index, 60, 'high');
  const priorLow5 = rollingMinExclusive(bars, index, 5, 'low');
  const priorLow10 = rollingMinExclusive(bars, index, 10, 'low');
  const priorLow20 = rollingMinExclusive(bars, index, 20, 'low');

  return {
    close,
    open,
    high,
    low,
    volume,
    prevClose,
    close3Ago,
    close5Ago,
    close10Ago,
    close20Ago,
    ma5,
    ma10,
    ma20,
    ma60,
    prevMa5,
    prevMa20,
    high20,
    low20,
    high60,
    low60,
    high120,
    low120,
    priorHigh20,
    priorHigh60,
    priorLow5,
    priorLow10,
    priorLow20,
    position60: calcRangePosition(close, low60, high60),
    position120: calcRangePosition(close, low120, high120),
    volumeRatio5: calcVolumeRatio(bars, index, 5),
    volumeRatio20: calcVolumeRatio(bars, index, 20),
    avgAmplitude5: calcAverageAmplitude(bars, index, 5),
    avgAmplitude20: calcAverageAmplitude(bars, index, 20),
    closeStrength: calcCloseStrength(bars, index, 5),
    recentLowBreak: priorLow5 !== null && low !== null ? low < priorLow5 * 0.995 : false,
    tenDayReturnPct: pctChangePct(close, close10Ago),
    twentyDayReturnPct: pctChangePct(close, close20Ago),
    threeDayReturnPct: pctChangePct(close, close3Ago),
    fiveDayReturnPct: pctChangePct(close, close5Ago),
    downCloses10: countDownCloses(bars, index, 10)
  };
}

function hasRequiredIndicators(indicators, keys) {
  return keys.every((key) => indicators[key] !== null && indicators[key] !== undefined);
}

function evaluateShapeStage(bars, index) {
  if (!Array.isArray(bars) || index < WARMUP_DAYS || index >= bars.length) {
    return {
      shapePassed: false,
      shapeType: 'NONE',
      shapeScore: 0,
      shapeReasons: ['形态数据不足']
    };
  }

  const indicators = getIndicators(bars, index);
  const required = [
    'close',
    'low',
    'prevClose',
    'ma5',
    'ma10',
    'ma20',
    'ma60',
    'high20',
    'low20',
    'priorHigh20',
    'priorLow10',
    'priorLow20',
    'position60',
    'position120',
    'volumeRatio5',
    'avgAmplitude5',
    'avgAmplitude20',
    'closeStrength',
    'tenDayReturnPct',
    'twentyDayReturnPct'
  ];

  if (!hasRequiredIndicators(indicators, required)) {
    return {
      shapePassed: false,
      shapeType: 'NONE',
      shapeScore: 0,
      shapeReasons: ['形态关键字段为空'],
      indicators
    };
  }

  const i = indicators;
  const range20Pct = ((i.high20 - i.low20) / i.close) * 100;
  const lowStable = i.low >= i.priorLow10 * 0.995;
  const stoppedFalling = lowStable && i.closeStrength >= 0.52 && i.close >= i.prevClose * 0.995;
  const volatilityChanged = i.avgAmplitude5 >= i.avgAmplitude20 * 1.08 || i.avgAmplitude5 <= i.avgAmplitude20 * 0.85;
  const volumeChanged = i.volumeRatio5 >= 1.08 || i.volumeRatio5 <= 0.78;
  const hasMarketChange = volatilityChanged || volumeChanged;
  const notSingleGreenDay = stoppedFalling && (hasMarketChange || i.close > i.ma5 || i.closeStrength >= 0.66);

  const pullback = (
    i.position60 >= 0.2 &&
    i.position60 <= 0.68 &&
    i.close <= i.high20 * 0.96 &&
    i.close >= i.low20 * 1.02 &&
    i.tenDayReturnPct <= 1.5 &&
    i.tenDayReturnPct >= -12 &&
    notSingleGreenDay
  );
  const baseRepair = (
    i.position120 <= 0.55 &&
    range20Pct <= 13 &&
    lowStable &&
    i.close >= i.ma10 * 0.985 &&
    i.closeStrength >= 0.55 &&
    hasMarketChange
  );
  const breakoutPrepare = (
    i.close >= i.priorHigh20 * 0.985 &&
    i.position60 <= 0.82 &&
    i.ma20 >= i.ma60 * 0.97 &&
    i.volumeRatio5 >= 0.9 &&
    i.closeStrength >= 0.6 &&
    i.twentyDayReturnPct >= -8
  );
  const oversoldRebound = (
    i.tenDayReturnPct <= -6 &&
    i.downCloses10 >= 5 &&
    lowStable &&
    i.close > i.prevClose &&
    i.close > i.ma5 * 0.985 &&
    i.closeStrength >= 0.58 &&
    hasMarketChange
  );

  const candidates = [
    ['BREAKOUT_PREPARE', breakoutPrepare, 78, '突破前整理'],
    ['BASE_REPAIR', baseRepair, 72, '底部修复'],
    ['PULLBACK', pullback, 68, '回踩企稳'],
    ['OVERSOLD_REBOUND', oversoldRebound, 64, '超跌止跌']
  ];
  const selected = candidates.find((candidate) => candidate[1]);

  if (!selected) {
    return {
      shapePassed: false,
      shapeType: 'NONE',
      shapeScore: 0,
      shapeReasons: ['未出现值得观察的形态'],
      indicators
    };
  }

  const reasons = [selected[3]];

  if (lowStable) reasons.push('近几日低点不再明显下破');
  if (volumeChanged) reasons.push('成交量结构发生变化');
  if (volatilityChanged) reasons.push('波动率结构发生变化');
  if (i.close > i.ma5) reasons.push('收盘靠近短期强势区');

  return {
    shapePassed: true,
    shapeType: selected[0],
    shapeScore: selected[2],
    shapeReasons: reasons,
    indicators
  };
}

function evaluatePositionStage(bars, index, shapeStage) {
  if (!Array.isArray(bars) || index < WARMUP_DAYS || index >= bars.length) {
    return {
      positionPassed: false,
      positionZone: 'UNKNOWN',
      positionScore: 0,
      positionRejectReason: REJECT_REASONS.POSITION_WEAK,
      positionReasons: ['位置数据不足']
    };
  }

  const indicators = (shapeStage && shapeStage.indicators) || getIndicators(bars, index);
  const required = [
    'close',
    'ma5',
    'ma20',
    'ma60',
    'priorHigh60',
    'position60',
    'position120',
    'volumeRatio5',
    'closeStrength'
  ];

  if (!hasRequiredIndicators(indicators, required)) {
    return {
      positionPassed: false,
      positionZone: 'UNKNOWN',
      positionScore: 0,
      positionRejectReason: REJECT_REASONS.POSITION_WEAK,
      positionReasons: ['位置关键字段为空'],
      position60: indicators.position60,
      position120: indicators.position120
    };
  }

  const i = indicators;
  const zone = classifyPositionZone(i.position60);
  const downtrend = i.close < i.ma20 && i.ma20 < i.ma60;
  const trendConfirmed = i.close > i.ma20 && i.ma20 >= i.ma60 * 0.98;
  const strongBreakout = (
    i.close >= i.priorHigh60 * 0.995 &&
    i.volumeRatio5 >= 1.12 &&
    i.close > i.ma20 &&
    i.ma20 >= i.ma60 * 0.98
  );
  const lowZoneRepair = zone === 'LOW_ZONE' && !i.recentLowBreak && i.closeStrength >= 0.48;
  const midZoneConfirm = zone === 'MID_ZONE' && trendConfirmed && (i.closeStrength >= 0.58 || i.close > i.ma5);
  const highZoneConfirm = zone === 'HIGH_ZONE' && strongBreakout;

  let positionPassed = false;
  let positionScore = 0;
  let positionRejectReason = REJECT_REASONS.POSITION_WEAK;
  const reasons = [];

  if (zone === 'LOW_ZONE') {
    positionScore += 72;
    reasons.push('处于 60 日低位区');
    positionPassed = lowZoneRepair;
  } else if (zone === 'MID_ZONE') {
    positionScore += 56;
    reasons.push('处于 60 日中位区');
    positionPassed = midZoneConfirm;
  } else if (zone === 'HIGH_ZONE') {
    positionScore += 35;
    reasons.push('处于 60 日高位区');
    positionPassed = highZoneConfirm;
    positionRejectReason = REJECT_REASONS.POSITION_TOO_HIGH;
  }

  if (i.position120 <= 0.4) {
    positionScore += 12;
    reasons.push('120 日位置偏低');
  }

  if (trendConfirmed) {
    positionScore += 10;
    reasons.push('中期趋势确认');
  }

  if (strongBreakout) {
    positionScore += 18;
    reasons.push('高位具备放量突破确认');
  }

  if (downtrend && zone !== 'LOW_ZONE') {
    positionPassed = false;
    positionRejectReason = REJECT_REASONS.POSITION_WEAK;
    reasons.push('中高位反弹仍处下跌趋势');
  }

  if (!positionPassed && zone === 'HIGH_ZONE' && !strongBreakout) {
    positionRejectReason = REJECT_REASONS.POSITION_TOO_HIGH;
  }

  return {
    positionPassed,
    positionZone: zone,
    positionScore: Math.round(clamp(positionScore, 0, 100)),
    positionRejectReason,
    positionReasons: reasons,
    position60: i.position60,
    position120: i.position120,
    high60: i.high60,
    low60: i.low60,
    high120: i.high120,
    low120: i.low120,
    strongBreakout,
    trendConfirmed,
    downtrend
  };
}

function evaluateChangeStage(bars, index, shapeStage, positionStage) {
  if (!Array.isArray(bars) || index < WARMUP_DAYS || index >= bars.length) {
    return {
      changePassed: false,
      changeType: 'NONE',
      changeReasons: ['变化数据不足']
    };
  }

  const indicators = (shapeStage && shapeStage.indicators) || getIndicators(bars, index);
  const required = [
    'close',
    'low',
    'prevClose',
    'ma5',
    'ma10',
    'ma20',
    'ma60',
    'prevMa5',
    'priorHigh20',
    'volumeRatio5',
    'closeStrength',
    'threeDayReturnPct'
  ];

  if (!hasRequiredIndicators(indicators, required)) {
    return {
      changePassed: false,
      changeType: 'NONE',
      changeReasons: ['变化关键字段为空'],
      indicators
    };
  }

  const i = indicators;
  const downtrend = i.close < i.ma20 && i.ma20 < i.ma60;
  const volumeSmash = i.close < i.prevClose && pctChangePct(i.close, i.prevClose) <= -2 && i.volumeRatio5 >= 1.35;
  const shortMaRecovered = i.close > i.ma5 && i.close > i.ma10 * 0.99;
  const maTurningUp = i.ma5 >= i.ma10 * 0.995 && i.ma5 >= i.prevMa5;
  const priceTurningStrong = i.threeDayReturnPct !== null && i.threeDayReturnPct > -1 && i.closeStrength >= 0.58;
  const breakoutConfirm = (
    i.close >= i.priorHigh20 * 0.995 &&
    i.volumeRatio5 >= 1.05 &&
    i.close > i.ma20
  );
  const stabilized = !i.recentLowBreak && shortMaRecovered && priceTurningStrong;
  const turnUp = !i.recentLowBreak && shortMaRecovered && maTurningUp && i.close >= i.prevClose * 0.995;
  const highZone = positionStage && positionStage.positionZone === 'HIGH_ZONE';

  const reasons = [];

  if (shortMaRecovered) reasons.push('收盘重新站上短期均线');
  if (!i.recentLowBreak) reasons.push('近几日低点未继续下破');
  if (!volumeSmash) reasons.push('未出现放量砸盘');
  if (priceTurningStrong) reasons.push('价格相对前几日转强');
  if (breakoutConfirm) reasons.push('突破确认');

  if (downtrend || i.recentLowBreak || volumeSmash) {
    return {
      changePassed: false,
      changeType: 'FAILED_REBOUND',
      changeReasons: reasons.length ? reasons : ['下跌趋势中的反弹失败'],
      ma5: i.ma5,
      ma10: i.ma10,
      ma20: i.ma20,
      ma60: i.ma60,
      volumeRatio5: i.volumeRatio5,
      recentLowBreak: i.recentLowBreak,
      closeStrength: i.closeStrength,
      indicators
    };
  }

  let changeType = 'NONE';

  if (breakoutConfirm) {
    changeType = 'BREAKOUT_CONFIRM';
  } else if (turnUp) {
    changeType = 'TURN_UP';
  } else if (stabilized && !highZone) {
    changeType = 'STABILIZED';
  }

  const changePassed = changeType !== 'NONE';

  return {
    changePassed,
    changeType,
    changeReasons: changePassed ? reasons : ['变化尚未确认'],
    ma5: i.ma5,
    ma10: i.ma10,
    ma20: i.ma20,
    ma60: i.ma60,
    volumeRatio5: i.volumeRatio5,
    recentLowBreak: i.recentLowBreak,
    closeStrength: i.closeStrength,
    indicators
  };
}

function buildFinalDecision(input) {
  const {
    bars,
    index,
    shapeStage,
    positionStage,
    changeStage,
    hasOpenExposure,
    cash,
    feeConfig
  } = input;
  const indicators = shapeStage.indicators || getIndicators(bars, index);

  if (!shapeStage.shapePassed) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.SHAPE_NOT_PASSED
    };
  }

  if (positionStage.positionZone === 'HIGH_ZONE' && !positionStage.strongBreakout) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.HIGH_ZONE_NO_BREAKOUT
    };
  }

  if (!positionStage.positionPassed) {
    return {
      finalAction: 'REJECT',
      rejectReason: positionStage.positionRejectReason || REJECT_REASONS.POSITION_WEAK
    };
  }

  if (!changeStage.changePassed) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.CHANGE_NOT_CONFIRMED
    };
  }

  if (
    indicators.close !== null &&
    indicators.ma20 !== null &&
    indicators.ma60 !== null &&
    indicators.close < indicators.ma20 &&
    indicators.ma20 < indicators.ma60
  ) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.DOWNTREND_FILTERED
    };
  }

  if (
    indicators.tenDayReturnPct !== null &&
    indicators.tenDayReturnPct <= -10 &&
    changeStage.changeType !== 'STABILIZED'
  ) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.CHANGE_NOT_CONFIRMED
    };
  }

  if (hasOpenExposure) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.HOLDING_ALREADY
    };
  }

  const entryIndex = index + 1;
  const entryBar = bars[entryIndex];
  const rawBuyPrice = getNumber(entryBar && entryBar.open);

  if (!Number.isFinite(rawBuyPrice) || rawBuyPrice <= 0) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.CHANGE_NOT_CONFIRMED
    };
  }

  const buyPrice = applyBuySlippage(rawBuyPrice, feeConfig);
  const shares = getAffordableShares(cash, buyPrice, feeConfig);

  if (shares < LOT_SIZE) {
    return {
      finalAction: 'REJECT',
      rejectReason: REJECT_REASONS.INSUFFICIENT_CASH_LOT,
      entryIndex,
      buyPrice,
      shares
    };
  }

  return {
    finalAction: 'BUY',
    rejectReason: REJECT_REASONS.BUY_EXECUTED,
    entryIndex,
    buyPrice,
    shares
  };
}

function buildDiagnostic(input) {
  const bar = input.bars[input.index] || {};
  const shapeStage = input.shapeStage || evaluateShapeStage(input.bars, input.index);
  const positionStage = input.positionStage || evaluatePositionStage(input.bars, input.index, shapeStage);
  const changeStage = input.changeStage || evaluateChangeStage(input.bars, input.index, shapeStage, positionStage);
  const decision = input.finalDecision || {};

  return {
    date: bar.date,
    close: getNumber(bar.close),
    shapePassed: Boolean(shapeStage.shapePassed),
    shapeType: shapeStage.shapeType || 'NONE',
    positionPassed: Boolean(positionStage.positionPassed),
    positionZone: positionStage.positionZone || 'UNKNOWN',
    positionScore: Number.isFinite(Number(positionStage.positionScore))
      ? Number(positionStage.positionScore)
      : 0,
    changePassed: Boolean(changeStage.changePassed),
    changeType: changeStage.changeType || 'NONE',
    finalAction: decision.finalAction || 'REJECT',
    rejectReason: decision.rejectReason || REJECT_REASONS.SHAPE_NOT_PASSED
  };
}

function getAffordableShares(cash, buyPrice, feeConfig) {
  let shares = Math.floor(Number(cash) / (Number(buyPrice) * LOT_SIZE)) * LOT_SIZE;

  while (shares >= LOT_SIZE) {
    const buyAmount = shares * buyPrice;
    const buyFee = calculateBuyFee(buyAmount, feeConfig);

    if (buyAmount + buyFee.totalBuyFee <= cash) {
      return shares;
    }

    shares -= LOT_SIZE;
  }

  return 0;
}

function buildSimulationConfig(inputConfig) {
  const raw = {
    holdDays: 20,
    stopLossPct: 0.08,
    trailingStopPct: 0.06,
    initialCapital: 100000,
    feeConfig: DEFAULT_FEE_CONFIG,
    ...(inputConfig || {})
  };
  const holdDays = Number(raw.holdDays);
  const stopLossPct = Number(raw.stopLossPct);
  const trailingStopPct = Number(raw.trailingStopPct);
  const initialCapital = Number(raw.initialCapital);

  return {
    holdDays: Number.isInteger(holdDays) && holdDays > 0 ? holdDays : 20,
    stopLossPct: Number.isFinite(stopLossPct) && stopLossPct > 0 && stopLossPct < 1 ? stopLossPct : 0.08,
    trailingStopPct: Number.isFinite(trailingStopPct) && trailingStopPct > 0 && trailingStopPct < 1 ? trailingStopPct : 0.06,
    initialCapital: Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 100000,
    feeConfig: resolveFeeConfig(raw.feeConfig)
  };
}

function getSellDecision(bars, index, position, config) {
  const bar = bars[index] || {};
  const close = getNumber(bar.close);
  const low = getNumber(bar.low);
  const ma5 = sma(bars, index, 5, 'close');
  const ma10 = sma(bars, index, 10, 'close');
  const ma20 = sma(bars, index, 20, 'close');
  const stopPrice = position.buyPrice * (1 - config.stopLossPct);

  if (low !== null && low <= stopPrice) {
    return {
      shouldSell: true,
      rejectReason: REJECT_REASONS.SELL_STOP_LOSS,
      rawSellPrice: stopPrice
    };
  }

  if (close !== null && ma5 !== null && ma10 !== null && ma20 !== null && close < ma20 && ma5 < ma10) {
    return {
      shouldSell: true,
      rejectReason: REJECT_REASONS.SELL_TREND_BROKEN,
      rawSellPrice: close
    };
  }

  if (close !== null) {
    const currentReturnPct = ((close - position.buyPrice) / position.buyPrice) * 100;
    position.maxReturnPct = Math.max(position.maxReturnPct, currentReturnPct);

    if (position.maxReturnPct > 0 && position.maxReturnPct - currentReturnPct >= config.trailingStopPct * 100) {
      return {
        shouldSell: true,
        rejectReason: REJECT_REASONS.SELL_TRAILING_STOP,
        rawSellPrice: close
      };
    }
  }

  const holdDays = index - position.entryIndex;
  const changeStage = evaluateChangeStage(
    bars,
    index,
    evaluateShapeStage(bars, index),
    evaluatePositionStage(bars, index)
  );
  const turnStrong = close !== null && ma20 !== null && close > ma20 && ma5 !== null && ma10 !== null && ma5 >= ma10;
  const unrealizedReturnPct = close !== null ? ((close - position.buyPrice) / position.buyPrice) * 100 : 0;

  if (holdDays >= config.holdDays && (unrealizedReturnPct <= 0 || !turnStrong)) {
    return {
      shouldSell: true,
      rejectReason: REJECT_REASONS.SELL_TIME_EXIT,
      rawSellPrice: close
    };
  }

  if (changeStage.changeType === 'FAILED_REBOUND') {
    return {
      shouldSell: true,
      rejectReason: REJECT_REASONS.SELL_CHANGE_FAILED,
      rawSellPrice: close
    };
  }

  if (index >= bars.length - 1) {
    return {
      shouldSell: true,
      rejectReason: REJECT_REASONS.SELL_TIME_EXIT,
      rawSellPrice: close
    };
  }

  return {
    shouldSell: false,
    rejectReason: ''
  };
}

function executeSell(input) {
  const {
    bars,
    index,
    cash,
    position,
    sellDecision,
    feeConfig
  } = input;
  const rawSellPrice = Number.isFinite(Number(sellDecision.rawSellPrice))
    ? Number(sellDecision.rawSellPrice)
    : Number(bars[index].close);
  const sellPrice = applySellSlippage(rawSellPrice, feeConfig);
  const sellAmount = position.shares * sellPrice;
  const sellFee = calculateSellFee(sellAmount, feeConfig);
  const cashAfterSell = cash + sellAmount - sellFee.totalSellFee;
  const grossPnl = sellAmount - position.buyAmount;
  const totalFees = position.buyFee.totalBuyFee + sellFee.totalSellFee;
  const netPnl = grossPnl - totalFees;
  const netReturnPct = (netPnl / (position.buyAmount + position.buyFee.totalBuyFee)) * 100;
  const grossReturnPct = (grossPnl / position.buyAmount) * 100;
  const holdDays = index - position.entryIndex;

  return {
    cashAfterSell,
    trade: {
      algoVersion: XINGWEIBIAN_V2_VERSION,
      modelId: XINGWEIBIAN_V2_VERSION,
      modelName: '形位变 V2 旧策略对照',
      signalDate: bars[position.signalIndex].date,
      entryDate: bars[position.entryIndex].date,
      exitDate: bars[index].date,
      signalIndex: position.signalIndex,
      entryIndex: position.entryIndex,
      exitIndex: index,
      entryPrice: roundMoney(position.buyPrice),
      exitPrice: roundMoney(sellPrice),
      shares: position.shares,
      holdDays,
      exitReason: sellDecision.rejectReason,
      grossPnl: roundMoney(grossPnl),
      netPnl: roundMoney(netPnl),
      grossReturnPct,
      netReturnPct,
      totalFees: roundMoney(totalFees),
      shapeStage: position.shapeStage,
      positionStage: position.positionStage,
      changeStage: position.changeStage,
      finalDecision: position.finalDecision,
      shapePassed: position.shapeStage.shapePassed,
      shapeType: position.shapeStage.shapeType,
      shapeScore: position.shapeStage.shapeScore,
      shapeReasons: position.shapeStage.shapeReasons,
      positionPassed: position.positionStage.positionPassed,
      positionZone: position.positionStage.positionZone,
      positionScore: position.positionStage.positionScore,
      positionRejectReason: position.positionStage.positionRejectReason,
      positionReasons: position.positionStage.positionReasons,
      changePassed: position.changeStage.changePassed,
      changeType: position.changeStage.changeType,
      changeReasons: position.changeStage.changeReasons,
      range60: position.positionStage.position60,
      range120: position.positionStage.position120,
      range250: null,
      highChase: position.positionStage.positionZone === 'HIGH_ZONE',
      lowStart: position.positionStage.positionZone === 'LOW_ZONE',
      aboveLongMa: position.positionStage.trendConfirmed,
      aboveYearMa: null,
      notTooHigh: position.positionStage.positionZone !== 'HIGH_ZONE' || position.positionStage.strongBreakout,
      futureReturns: calcFutureReturns(bars, position.signalIndex)
    }
  };
}

function getEquity(cash, position, bar) {
  if (!position) {
    return cash;
  }

  const close = getNumber(bar && bar.close);

  if (close === null) {
    return cash;
  }

  return cash + position.shares * close;
}

function evaluateStagesForIndex(bars, index) {
  const shapeStage = evaluateShapeStage(bars, index);
  const positionStage = evaluatePositionStage(bars, index, shapeStage);
  const changeStage = evaluateChangeStage(bars, index, shapeStage, positionStage);

  return {
    shapeStage,
    positionStage,
    changeStage
  };
}

function getTopRejectReason(diagnostics) {
  const counts = new Map();

  for (const item of Array.isArray(diagnostics) ? diagnostics : []) {
    const reason = item && item.rejectReason;

    if (!reason) {
      continue;
    }

    counts.set(reason, (counts.get(reason) || 0) + 1);
  }

  let topReason = '';
  let topCount = 0;

  for (const [reason, count] of counts.entries()) {
    if (count > topCount) {
      topReason = reason;
      topCount = count;
    }
  }

  return topReason;
}

function simulateXingweibianV2(input) {
  const bars = Array.isArray(input && input.bars) ? input.bars : [];
  const config = buildSimulationConfig(input && input.config);
  const feeConfig = config.feeConfig;
  const trades = [];
  const diagnostics = [];
  const equityCurve = [];

  let cash = config.initialCapital;
  let position = null;
  let pendingBuy = null;

  for (let index = 0; index < bars.length; index += 1) {
    let dayNetPnl = 0;
    let tradeIndex = null;

    if (pendingBuy && pendingBuy.entryIndex === index) {
      const buyAmount = pendingBuy.shares * pendingBuy.buyPrice;
      const buyFee = calculateBuyFee(buyAmount, feeConfig);

      cash -= buyAmount + buyFee.totalBuyFee;
      position = {
        ...pendingBuy,
        buyAmount,
        buyFee,
        maxReturnPct: 0
      };
      pendingBuy = null;
    }

    if (position && index > position.entryIndex) {
      const sellDecision = getSellDecision(bars, index, position, config);

      if (sellDecision.shouldSell) {
        const sold = executeSell({
          bars,
          index,
          cash,
          position,
          sellDecision,
          feeConfig
        });
        cash = sold.cashAfterSell;
        dayNetPnl = sold.trade.netPnl;
        trades.push(sold.trade);
        tradeIndex = trades.length - 1;

        const stages = evaluateStagesForIndex(bars, index);
        diagnostics.push(buildDiagnostic({
          bars,
          index,
          ...stages,
          finalDecision: {
            finalAction: 'SELL',
            rejectReason: sellDecision.rejectReason
          }
        }));

        position = null;
      }
    }

    if (index >= WARMUP_DAYS && index < bars.length - 2) {
      const stages = evaluateStagesForIndex(bars, index);
      const finalDecision = buildFinalDecision({
        bars,
        index,
        ...stages,
        hasOpenExposure: Boolean(position || pendingBuy),
        cash,
        feeConfig
      });

      diagnostics.push(buildDiagnostic({
        bars,
        index,
        ...stages,
        finalDecision
      }));

      if (finalDecision.finalAction === 'BUY') {
        pendingBuy = {
          signalIndex: index,
          entryIndex: finalDecision.entryIndex,
          buyPrice: finalDecision.buyPrice,
          shares: finalDecision.shares,
          shapeStage: stages.shapeStage,
          positionStage: stages.positionStage,
          changeStage: stages.changeStage,
          finalDecision
        };
      }
    }

    equityCurve.push({
      date: bars[index] && bars[index].date,
      equity: roundMoney(getEquity(cash, position, bars[index])),
      netPnl: roundMoney(dayNetPnl),
      tradeIndex
    });
  }

  return {
    algoVersion: XINGWEIBIAN_V2_VERSION,
    trades,
    diagnostics,
    equityCurve,
    endingCapital: roundMoney(equityCurve.length ? equityCurve[equityCurve.length - 1].equity : cash),
    topRejectReason: getTopRejectReason(diagnostics)
  };
}

module.exports = {
  XINGWEIBIAN_V2_VERSION,
  REJECT_REASONS,
  evaluateShapeStage,
  evaluatePositionStage,
  evaluateChangeStage,
  simulateXingweibianV2,
  getTopRejectReason
};
