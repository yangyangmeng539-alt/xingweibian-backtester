const HK_LIQUIDITY_BEND_VERSION = 'xwb-hk-liquidity-bend-v1';

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 2) {
  const number = safeNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getBarNumber(bar, key) {
  if (!bar) return null;

  if (key === 'pctChange') {
    return safeNumber(bar.pctChange !== undefined ? bar.pctChange : bar.pct_change);
  }

  if (key === 'tradeDate') {
    return bar.date || bar.tradeDate || bar.trade_date || '';
  }

  return safeNumber(bar[key]);
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) return null;

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function sliceBeforeAndAt(bars, clickedIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex) || clickedIndex < 0) return [];
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, clickedIndex - size + 1);
  return bars.slice(start, clickedIndex + 1).filter(Boolean);
}

function sliceBeforeOnly(bars, clickedIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex) || clickedIndex <= 0) return [];
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, clickedIndex - size);
  return bars.slice(start, clickedIndex).filter(Boolean);
}

function valuesOf(rows, key) {
  return (Array.isArray(rows) ? rows : [])
    .map((bar) => getBarNumber(bar, key))
    .filter((value) => value !== null);
}

function activeValuesOf(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((bar) => getActiveValue(bar))
    .filter((value) => value !== null);
}

function ratio(current, base) {
  const left = safeNumber(current);
  const right = safeNumber(base);

  if (left === null || right === null || right <= 0) return null;

  return left / right;
}

function countWhere(rows, predicate) {
  return (Array.isArray(rows) ? rows : []).filter((item) => predicate(item)).length;
}

function getClosePositionPct(bar) {
  const high = getBarNumber(bar, 'high');
  const low = getBarNumber(bar, 'low');
  const close = getBarNumber(bar, 'close');

  if (high === null || low === null || close === null || high <= low) return null;

  return clamp((close - low) / (high - low) * 100, 0, 100);
}

function getAmplitudePct(bar, prevBar) {
  const high = getBarNumber(bar, 'high');
  const low = getBarNumber(bar, 'low');
  const prevClose = getBarNumber(prevBar, 'close');

  if (high === null || low === null || prevClose === null || prevClose <= 0) return null;

  return (high - low) / prevClose * 100;
}

function getActiveValue(bar) {
  const amount = getBarNumber(bar, 'amount');

  if (amount !== null && amount > 0) {
    return amount;
  }

  const close = getBarNumber(bar, 'close');
  const volume = getBarNumber(bar, 'volume');

  if (close === null || volume === null || close <= 0 || volume <= 0) {
    return null;
  }

  return close * volume;
}

function getLiquidityRegime(score, riskScore, supportScore, dryScore) {
  if (dryScore >= 1.4 && Math.abs(score) < 0.6) {
    return 'HK_LIQUIDITY_DRY_UP';
  }

  if (riskScore >= 2.4 && score <= -0.6) {
    return 'HK_LIQUIDITY_RISK_RELEASE';
  }

  if (riskScore >= 1.6 && score <= -0.2) {
    return 'HK_LIQUIDITY_DIVERGENCE_RISK';
  }

  if (supportScore >= 2.5 && score >= 1) {
    return 'HK_LIQUIDITY_CONFIRMING';
  }

  if (supportScore >= 1.2 && score >= 0.35) {
    return 'HK_LIQUIDITY_WARMING';
  }

  return 'HK_LIQUIDITY_NEUTRAL';
}

function getLiquidityRegimeLabel(regime) {
  const labels = {
    HK_LIQUIDITY_NEUTRAL: '港股量价中性',
    HK_LIQUIDITY_WARMING: '港股成交预热',
    HK_LIQUIDITY_CONFIRMING: '港股量价确认',
    HK_LIQUIDITY_DIVERGENCE_RISK: '港股放量滞涨风险',
    HK_LIQUIDITY_RISK_RELEASE: '港股放量风险释放',
    HK_LIQUIDITY_DRY_UP: '港股缩量衰减'
  };

  return labels[regime] || regime || '港股量价未知';
}

function buildSignal(label, reason, contribution, details = {}) {
  return {
    label,
    reason,
    contribution: roundNumber(contribution, 3),
    details
  };
}

function buildHkLiquidityBendAnalysisFromBars(options = {}) {
  const bars = Array.isArray(options.bars) ? options.bars : [];
  const clickedIndex = Number(options.clickedIndex);
  const symbol = String(options.symbol || options.code || '').trim();

  if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex >= bars.length) {
    return {
      version: HK_LIQUIDITY_BEND_VERSION,
      ok: false,
      reason: 'INVALID_CLICKED_INDEX',
      regime: 'HK_LIQUIDITY_NEUTRAL',
      score: 0,
      bendByDayPct: { 1: 0, 2: 0, 4: 0, 6: 0, 7: 0, 8: 0, 9: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 18: 0, 19: 0 },
      signals: []
    };
  }

  const currentBar = bars[clickedIndex] || {};
  const prevBar = bars[clickedIndex - 1] || null;
  const before20 = sliceBeforeOnly(bars, clickedIndex, 20);
  const window5 = sliceBeforeAndAt(bars, clickedIndex, 5);
  const window20 = sliceBeforeAndAt(bars, clickedIndex, 20);

  const current = {
    date: getBarNumber(currentBar, 'tradeDate'),
    close: roundNumber(getBarNumber(currentBar, 'close'), 4),
    volume: roundNumber(getBarNumber(currentBar, 'volume'), 4),
    amount: roundNumber(getBarNumber(currentBar, 'amount'), 4),
    activeValue: roundNumber(getActiveValue(currentBar), 4),
    pctChange: roundNumber(getBarNumber(currentBar, 'pctChange'), 4),
    amplitudePct: roundNumber(getAmplitudePct(currentBar, prevBar), 4),
    closePositionPct: roundNumber(getClosePositionPct(currentBar), 4)
  };

  const avg = {
    volume5: average(valuesOf(window5, 'volume')),
    volume20: average(valuesOf(window20, 'volume')),
    activeValue5: average(activeValuesOf(window5)),
    activeValue20: average(activeValuesOf(window20)),
    preVolume20: average(valuesOf(before20, 'volume')),
    preActiveValue20: average(activeValuesOf(before20))
  };

  const ratios = {
    volumeT0To20: roundNumber(ratio(current.volume, avg.preVolume20), 4),
    activeValueT0To20: roundNumber(ratio(current.activeValue, avg.preActiveValue20), 4),
    volume5To20: roundNumber(ratio(avg.volume5, avg.volume20), 4),
    activeValue5To20: roundNumber(ratio(avg.activeValue5, avg.activeValue20), 4)
  };

  const highActiveDays5 = countWhere(window5, (bar) => {
    const value = getActiveValue(bar);
    return value !== null && avg.activeValue20 !== null && avg.activeValue20 > 0 && value >= avg.activeValue20 * 1.35;
  });

  const highVolumeDays5 = countWhere(window5, (bar) => {
    const value = getBarNumber(bar, 'volume');
    return value !== null && avg.volume20 !== null && avg.volume20 > 0 && value >= avg.volume20 * 1.35;
  });

  let score = 0;
  let supportScore = 0;
  let riskScore = 0;
  let dryScore = 0;
  const signals = [];

  const addSupport = (label, reason, value, details) => {
    const contribution = Math.abs(Number(value) || 0);
    signals.push(buildSignal(label, reason, contribution, details));
    score += contribution;
    supportScore += contribution;
  };

  const addRisk = (label, reason, value, details) => {
    const contribution = -Math.abs(Number(value) || 0);
    signals.push(buildSignal(label, reason, contribution, details));
    score += contribution;
    riskScore += Math.abs(contribution);
  };

  const addDry = (label, reason, value, details) => {
    const contribution = -Math.abs(Number(value) || 0);
    signals.push(buildSignal(label, reason, contribution, details));
    score += contribution * 0.45;
    dryScore += Math.abs(contribution);
  };

  const pctChange = current.pctChange;
  const closePositionPct = current.closePositionPct;
  const amplitudePct = current.amplitudePct;
  const activeRatio = ratios.activeValueT0To20;
  const volumeRatio = ratios.volumeT0To20;
  const activeTrendRatio = ratios.activeValue5To20;
  const volumeTrendRatio = ratios.volume5To20;

  if (activeRatio !== null && activeRatio >= 1.28 && pctChange !== null && pctChange >= 0.9 && closePositionPct !== null && closePositionPct >= 58) {
    addSupport('HK_ACTIVE_PRICE_CONFIRM', '成交活跃代理放大、价格上行、收盘位置偏强', 1.05, {
      activeRatio,
      pctChange,
      closePositionPct
    });
  }

  if (volumeRatio !== null && volumeRatio >= 1.22 && pctChange !== null && pctChange >= 0.8 && closePositionPct !== null && closePositionPct >= 55) {
    addSupport('HK_VOLUME_PRICE_CONFIRM', '成交量放大且价格同步确认', 0.8, {
      volumeRatio,
      pctChange,
      closePositionPct
    });
  }

  if (activeTrendRatio !== null && activeTrendRatio >= 1.12 && volumeTrendRatio !== null && volumeTrendRatio >= 1.08) {
    addSupport('HK_RECENT_LIQUIDITY_WARMING', '近 5 日成交活跃度和成交量高于近 20 日均值', 0.65, {
      activeTrendRatio,
      volumeTrendRatio
    });
  }

  if (activeRatio !== null && activeRatio >= 1.32 && pctChange !== null && pctChange < 0.65 && closePositionPct !== null && closePositionPct < 55) {
    addRisk('HK_ACTIVE_STALL', '成交活跃度放大但价格和收盘位置没有确认', 1.15, {
      activeRatio,
      pctChange,
      closePositionPct
    });
  }

  if (pctChange !== null && pctChange <= -2.5 && activeRatio !== null && activeRatio >= 1.18) {
    addRisk('HK_SELLING_ACTIVE_RELEASE', '放量下跌，风险释放', 1.1, {
      pctChange,
      activeRatio
    });
  }

  if (amplitudePct !== null && amplitudePct >= 4.2 && closePositionPct !== null && closePositionPct <= 38 && activeRatio !== null && activeRatio >= 1.12) {
    addRisk('HK_WIDE_SWING_WEAK_CLOSE', '大振幅叠加弱收盘，承接不足', 0.8, {
      amplitudePct,
      closePositionPct,
      activeRatio
    });
  }

  if (activeRatio !== null && activeRatio <= 0.72 && volumeRatio !== null && volumeRatio <= 0.75) {
    addDry('HK_LIQUIDITY_DRY', '成交活跃度和成交量明显低于近 20 日', 0.75, {
      activeRatio,
      volumeRatio
    });
  }

  if (highActiveDays5 >= 2 && highVolumeDays5 >= 2 && pctChange !== null && pctChange < 1.1) {
    addRisk('HK_MULTI_DAY_ACTIVE_NO_PRICE_CONFIRM', '多日成交活跃但价格没有确认', 0.62, {
      highActiveDays5,
      highVolumeDays5,
      pctChange
    });
  }
  const normalizedScore = roundNumber(clamp(score, -4, 4), 3);
  const regime = getLiquidityRegime(normalizedScore, riskScore, supportScore, dryScore);

  const rawBend = clamp(normalizedScore * 0.55, -1.8, 1.8);
  const confidenceScale = signals.length >= 4 ? 1 : signals.length >= 2 ? 0.78 : 0.52;
  const bend = roundNumber(rawBend * confidenceScale, 2);

  const frontBend = roundNumber(bend * 0.9, 2);
  const midBend = roundNumber(bend * 0.55, 2);
  const tailBend = roundNumber(bend * 0.25, 2);

  return {
    version: HK_LIQUIDITY_BEND_VERSION,
    ok: true,
    market: 'HK',
    symbol,
    clickedDate: current.date,
    current,
    averages: Object.fromEntries(Object.entries(avg).map(([key, value]) => [key, roundNumber(value, 4)])),
    ratios,
    counts: {
      highActiveDays5,
      highVolumeDays5
    },
    score: normalizedScore,
    supportScore: roundNumber(supportScore, 3),
    riskScore: roundNumber(riskScore, 3),
    dryScore: roundNumber(dryScore, 3),
    regime,
    regimeLabel: getLiquidityRegimeLabel(regime),
    confidence: roundNumber(clamp(signals.length / 5, 0.18, 0.9), 3),

    // 注意：这是折度，不是涨幅加成。
    // 只给 T+1/T+2/T+4/T+6... 这些中间交易日使用。
    // 不改 T+3/T+5/T+10/T+20 锚点。
    bendByDayPct: {
      1: frontBend,
      2: frontBend,
      4: frontBend,
      6: midBend,
      7: midBend,
      8: midBend,
      9: midBend,
      11: tailBend,
      12: tailBend,
      13: tailBend,
      14: tailBend,
      15: tailBend,
      16: tailBend,
      17: tailBend,
      18: tailBend,
      19: tailBend
    },
    anchorAdjustmentByDayPct: {
      3: 0,
      5: 0,
      10: 0,
      20: 0
    },
    signals,
    summaryText: `${getLiquidityRegimeLabel(regime)}｜折度 ${bend}%｜分 ${normalizedScore}｜信号 ${signals.length}｜无换手率`
  };
}

module.exports = {
  HK_LIQUIDITY_BEND_VERSION,
  buildHkLiquidityBendAnalysisFromBars
};