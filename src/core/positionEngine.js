const {
  sma,
  rollingMaxInclusive,
  rollingMinInclusive
} = require('./signalEngine');

function calcRangePosition(close, low, high) {
  if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }

  if (high <= low) {
    return null;
  }

  return (close - low) / (high - low);
}

function evaluatePosition(bars, index) {
  if (!Array.isArray(bars) || index < 120 || index >= bars.length) {
    return {
      pass: false,
      reasons: ['位置数据不足']
    };
  }

  const bar = bars[index];
  const close = Number(bar.close);
  const pctChange = Number(bar.pctChange);

  const high60 = rollingMaxInclusive(bars, index, 60, 'high');
  const low60 = rollingMinInclusive(bars, index, 60, 'low');
  const high120 = rollingMaxInclusive(bars, index, 120, 'high');
  const low120 = rollingMinInclusive(bars, index, 120, 'low');
  const high250 = rollingMaxInclusive(bars, index, 250, 'high');
  const low250 = rollingMinInclusive(bars, index, 250, 'low');

  const ma60 = sma(bars, index, 60, 'close');
  const ma120 = sma(bars, index, 120, 'close');
  const ma250 = sma(bars, index, 250, 'close');

  const range60 = calcRangePosition(close, low60, high60);
  const range120 = calcRangePosition(close, low120, high120);
  const range250 = calcRangePosition(close, low250, high250);

  const highChase = range60 !== null && range60 >= 0.88 && pctChange >= 4;
  const lowStart = range120 !== null && range120 <= 0.65 && ma60 !== null && close > ma60;
  const aboveLongMa = ma120 !== null && close > ma120;
  const aboveYearMa = ma250 !== null && close > ma250;
  const notTooHigh = range60 !== null && range60 <= 0.9 && range250 !== null && range250 <= 0.85;

  const reasons = [];

  if (lowStart) reasons.push('低位启动');
  if (aboveLongMa) reasons.push('长期均线之上');
  if (aboveYearMa) reasons.push('年线之上');
  if (highChase) reasons.push('高位追涨风险');
  if (notTooHigh) reasons.push('位置不过热');

  return {
    pass: !highChase && notTooHigh && (lowStart || aboveLongMa),
    range60,
    range120,
    range250,
    highChase,
    lowStart,
    aboveLongMa,
    aboveYearMa,
    notTooHigh,
    reasons
  };
}

module.exports = {
  evaluatePosition
};