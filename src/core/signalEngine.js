function getNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sma(bars, endIndex, period, field) {
  if (endIndex < period - 1) {
    return null;
  }

  let sum = 0;
  let count = 0;

  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const value = getNumber(bars[i] && bars[i][field]);
    if (value === null) {
      return null;
    }

    sum += value;
    count += 1;
  }

  return count === period ? sum / period : null;
}

function rollingMaxExclusive(bars, currentIndex, period, field) {
  const start = currentIndex - period;
  const end = currentIndex - 1;

  if (start < 0) {
    return null;
  }

  let max = -Infinity;

  for (let i = start; i <= end; i += 1) {
    const value = getNumber(bars[i] && bars[i][field]);
    if (value === null) {
      return null;
    }

    if (value > max) {
      max = value;
    }
  }

  return max;
}

function rollingMaxInclusive(bars, endIndex, period, field) {
  if (endIndex < period - 1) {
    return null;
  }

  let max = -Infinity;

  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const value = getNumber(bars[i] && bars[i][field]);
    if (value === null) {
      return null;
    }

    if (value > max) {
      max = value;
    }
  }

  return max;
}

function rollingMinInclusive(bars, endIndex, period, field) {
  if (endIndex < period - 1) {
    return null;
  }

  let min = Infinity;

  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const value = getNumber(bars[i] && bars[i][field]);
    if (value === null) {
      return null;
    }

    if (value < min) {
      min = value;
    }
  }

  return min;
}

function evaluateShape(bars, index) {
  if (!Array.isArray(bars) || index < 60 || index >= bars.length) {
    return {
      pass: false,
      score: 0,
      reasons: ['数据不足']
    };
  }

  const bar = bars[index];
  const prevBar = bars[index - 1];

  const close = getNumber(bar.close);
  const prevClose = getNumber(prevBar.close);
  const volume = getNumber(bar.volume);
  const high = getNumber(bar.high);
  const low = getNumber(bar.low);
  const pctChange = getNumber(bar.pctChange);
  const amplitude = getNumber(bar.amplitude);

  const ma5 = sma(bars, index, 5, 'close');
  const ma10 = sma(bars, index, 10, 'close');
  const ma20 = sma(bars, index, 20, 'close');
  const prevMa5 = sma(bars, index - 1, 5, 'close');
  const prevMa20 = sma(bars, index - 1, 20, 'close');
  const volumeMa20 = sma(bars, index - 1, 20, 'volume');
  const recentHigh20 = rollingMaxExclusive(bars, index, 20, 'high');

  if (
    close === null ||
    prevClose === null ||
    volume === null ||
    high === null ||
    low === null ||
    ma5 === null ||
    ma10 === null ||
    ma20 === null ||
    prevMa5 === null ||
    prevMa20 === null ||
    volumeMa20 === null ||
    recentHigh20 === null
  ) {
    return {
      pass: false,
      score: 0,
      reasons: ['关键字段为空']
    };
  }

  const checks = {
    volumeSpike: volume > volumeMa20 * 1.5,
    maTurnStrong: ma5 > ma10 && ma10 > ma20 && ma5 > prevMa5,
    closeAboveKeyMa: close > ma20 && prevClose <= prevMa20,
    breakPressure: close > recentHigh20,
    klineStrength: pctChange !== null && amplitude !== null && pctChange >= 2 && pctChange <= 9.5 && amplitude <= 12
  };

  const reasons = [];
  let score = 0;

  if (checks.volumeSpike) {
    score += 1;
    reasons.push('放量');
  }

  if (checks.maTurnStrong) {
    score += 1;
    reasons.push('均线转强');
  }

  if (checks.closeAboveKeyMa) {
    score += 1;
    reasons.push('收盘站上 20 日均线');
  }

  if (checks.breakPressure) {
    score += 1;
    reasons.push('突破 20 日压力位');
  }

  if (checks.klineStrength) {
    score += 1;
    reasons.push('K 线强度合格');
  }

  return {
    pass: score >= 3,
    score,
    checks,
    reasons,
    ma5,
    ma10,
    ma20
  };
}

module.exports = {
  evaluateShape,
  sma,
  rollingMaxExclusive,
  rollingMaxInclusive,
  rollingMinInclusive
};