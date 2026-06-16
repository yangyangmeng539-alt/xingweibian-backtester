const { sma } = require('./signalEngine');

function confirmContinuation(bars, signalIndex, options) {
  const config = {
    confirmDays: 3,
    maxPullbackPct: 6,
    breakSignalClosePct: 3,
    ...options
  };

  if (!Array.isArray(bars) || signalIndex + config.confirmDays + 1 >= bars.length) {
    return {
      pass: false,
      entryIndex: -1,
      reasons: ['变化验证数据不足']
    };
  }

  const signalClose = Number(bars[signalIndex].close);
  const reasons = [];

  for (let offset = 1; offset <= config.confirmDays; offset += 1) {
    const index = signalIndex + offset;
    const bar = bars[index];
    const close = Number(bar.close);
    const low = Number(bar.low);
    const ma20 = sma(bars, index, 20, 'close');

    if (!Number.isFinite(close) || !Number.isFinite(low) || ma20 === null) {
      return {
        pass: false,
        entryIndex: -1,
        reasons: ['变化验证字段为空']
      };
    }

    const pullbackPct = ((low - signalClose) / signalClose) * 100;
    const breakSignalPct = ((close - signalClose) / signalClose) * 100;

    if (close < ma20) {
      reasons.push(`第 ${offset} 天跌破 20 日均线`);
    }

    if (pullbackPct <= -config.maxPullbackPct) {
      reasons.push(`第 ${offset} 天回撤过大`);
    }

    if (breakSignalPct <= -config.breakSignalClosePct) {
      reasons.push(`第 ${offset} 天跌破信号收盘价过多`);
    }
  }

  if (reasons.length > 0) {
    return {
      pass: false,
      entryIndex: -1,
      reasons
    };
  }

  return {
    pass: true,
    entryIndex: signalIndex + config.confirmDays + 1,
    reasons: ['变化延续确认']
  };
}

function calcFutureReturns(bars, signalIndex) {
  const signalClose = Number(bars[signalIndex] && bars[signalIndex].close);

  function ret(days) {
    const futureBar = bars[signalIndex + days];

    if (!futureBar || !Number.isFinite(signalClose) || signalClose <= 0) {
      return null;
    }

    return ((Number(futureBar.close) - signalClose) / signalClose) * 100;
  }

  return {
    future5ReturnPct: ret(5),
    future10ReturnPct: ret(10),
    future20ReturnPct: ret(20)
  };
}

module.exports = {
  confirmContinuation,
  calcFutureReturns
};