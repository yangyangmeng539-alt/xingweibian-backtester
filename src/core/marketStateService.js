const MARKET_STATE_VERSION = 'xwb-market-state-v1';

const MARKET_REGIME_LABELS = {
  MARKET_STRONG_TREND: '强趋势',
  MARKET_WARM: '温和扩散',
  MARKET_REBOUND: '反抽修复',
  MARKET_SIDEWAYS: '震荡',
  MARKET_WEAK: '弱环境',
  MARKET_REBOUND_RISK: '反抽风险',
  MARKET_SIDEWAYS_WEAK: '震荡偏弱',
  MARKET_BREAKDOWN_RISK: '破位风险',
  MARKET_PANIC: '恐慌释放'
};

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

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text.slice(0, 10);
}

function getBarDate(bar) {
  return normalizeDate(bar && (bar.date || bar.tradeDate || bar.trade_date));
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) return null;

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (!list.length) return null;

  const mid = Math.floor(list.length / 2);

  return list.length % 2 === 1
    ? list[mid]
    : (list[mid - 1] + list[mid]) / 2;
}

function getReturnPct(currentClose, previousClose) {
  const current = safeNumber(currentClose);
  const previous = safeNumber(previousClose);

  if (current === null || previous === null || previous <= 0) {
    return null;
  }

  return (current - previous) / previous * 100;
}

function getPctChange(bar, prevBar) {
  const direct = safeNumber(bar && (bar.pctChange !== undefined ? bar.pctChange : bar.pct_change));

  if (direct !== null) {
    return direct;
  }

  return getReturnPct(
    bar && bar.close,
    prevBar && prevBar.close
  );
}

function getActiveValue(bar, market) {
  const amount = safeNumber(bar && bar.amount);

  if (String(market || '').toUpperCase() !== 'HK' && amount !== null && amount > 0) {
    return amount;
  }

  // 港股当前 amount/turnover 常为空，用 close * volume 做成交活跃代理。
  const close = safeNumber(bar && bar.close);
  const volume = safeNumber(bar && bar.volume);

  if (close === null || volume === null || close <= 0 || volume <= 0) {
    return null;
  }

  return close * volume;
}

function getMa(bars, index, days) {
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, index - size + 1);
  const rows = bars.slice(start, index + 1);
  return average(rows.map((bar) => safeNumber(bar && bar.close)));
}

function getPreviousClose(bars, index, days) {
  const targetIndex = index - Number(days);
  const bar = bars[targetIndex];

  return safeNumber(bar && bar.close);
}

function getPreviousWindow(bars, index, days) {
  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, index - size);
  return bars.slice(start, index);
}

function getRecentLow(bars, index, days) {
  const rows = getPreviousWindow(bars, index, days);
  const lows = rows
    .map((bar) => safeNumber(bar && bar.low))
    .filter(Number.isFinite);

  return lows.length ? Math.min(...lows) : null;
}

function buildSymbolMarketSnapshot(symbol, bars, targetDate, market) {
  const list = (Array.isArray(bars) ? bars : [])
    .filter(Boolean)
    .sort((left, right) => String(getBarDate(left)).localeCompare(String(getBarDate(right))));

  const cleanDate = normalizeDate(targetDate);
  const index = list.findIndex((bar) => getBarDate(bar) === cleanDate);

  if (index < 20) {
    return {
      ok: false,
      symbol,
      reason: index < 0 ? 'DATE_NOT_FOUND' : 'INSUFFICIENT_LOOKBACK'
    };
  }

  const bar = list[index];
  const prevBar = list[index - 1];
  const close = safeNumber(bar.close);
  const pctChange = getPctChange(bar, prevBar);
  const return5Pct = getReturnPct(close, getPreviousClose(list, index, 5));
  const return20Pct = getReturnPct(close, getPreviousClose(list, index, 20));
  const ma20 = getMa(list, index, 20);
  const ma60 = getMa(list, index, 60);
  const activeValue = getActiveValue(bar, market);
  const activeWindow20 = getPreviousWindow(list, index, 20)
    .map((item) => getActiveValue(item, market))
    .filter((value) => value !== null);
  const activeAvg20 = average(activeWindow20);
  const activeRatio = activeValue !== null && activeAvg20 !== null && activeAvg20 > 0
    ? activeValue / activeAvg20
    : null;
  const recentLow20 = getRecentLow(list, index, 20);

  const marketName = String(market || '').toUpperCase();
  const bigUpThreshold = marketName === 'HK' ? 4 : 5;
  const bigDropThreshold = marketName === 'HK' ? -4 : -5;

  const up = pctChange !== null && pctChange > 0;
  const down = pctChange !== null && pctChange < 0;
  const bigUp = pctChange !== null && pctChange >= bigUpThreshold;
  const bigDrop = pctChange !== null && pctChange <= bigDropThreshold;
  const aboveMa20 = close !== null && ma20 !== null && close >= ma20;
  const aboveMa60 = close !== null && ma60 !== null && close >= ma60;
  const belowMa20 = close !== null && ma20 !== null && close < ma20;
  const belowMa60 = close !== null && ma60 !== null && close < ma60;
  const breakdown = close !== null && recentLow20 !== null && close <= recentLow20 * 1.005;

  const strong = (
    return20Pct !== null
    && return5Pct !== null
    && return20Pct >= 6
    && return5Pct >= 0
    && aboveMa20
  );

  const weak = (
    (return20Pct !== null && return20Pct <= -6)
    || (belowMa20 && belowMa60)
    || (return5Pct !== null && return5Pct <= -4)
  );

  return {
    ok: true,
    symbol,
    date: cleanDate,
    close,
    pctChange,
    return5Pct,
    return20Pct,
    ma20,
    ma60,
    activeValue,
    activeRatio,
    flags: {
      up,
      down,
      bigUp,
      bigDrop,
      aboveMa20,
      aboveMa60,
      belowMa20,
      belowMa60,
      breakdown,
      strong,
      weak
    }
  };
}

function ratioOf(list, predicate) {
  const rows = Array.isArray(list) ? list : [];

  if (!rows.length) return 0;

  return rows.filter(predicate).length / rows.length;
}

function buildMarketRegime({
  score,
  upRatio,
  downRatio,
  strongRatio,
  weakRatio,
  bigDropRatio,
  breakdownRatio,
  equalWeightReturn5Pct,
  equalWeightReturn20Pct,
  activeRatioMedian
}) {
  const hasActiveConfirm = activeRatioMedian === null || activeRatioMedian >= 0.95;

  // 恐慌释放必须有“急跌宽度”或“大面积单日杀跌”确认。
  // 不能只因为 20 日趋势弱就叫恐慌。
  if (
    hasActiveConfirm
    && (
      (bigDropRatio >= 0.08 && downRatio >= 0.65)
      || (score <= -82 && bigDropRatio >= 0.04 && downRatio >= 0.58)
    )
  ) {
    return 'MARKET_PANIC';
  }

  if (
    score <= -52
    || breakdownRatio >= 0.35
    || (equalWeightReturn20Pct !== null && equalWeightReturn20Pct <= -8)
  ) {
    return 'MARKET_BREAKDOWN_RISK';
  }

  if (
    equalWeightReturn5Pct !== null
    && equalWeightReturn20Pct !== null
    && equalWeightReturn5Pct >= 2
    && equalWeightReturn20Pct <= -4
    && weakRatio >= 0.32
  ) {
    return 'MARKET_REBOUND_RISK';
  }

  if (
    score <= -35
    || (downRatio >= 0.58 && weakRatio >= 0.32)
  ) {
    return 'MARKET_WEAK';
  }

  if (
    score <= -22
    && (
      weakRatio >= 0.45
      || breakdownRatio >= 0.18
      || (equalWeightReturn20Pct !== null && equalWeightReturn20Pct <= -3)
    )
  ) {
    return 'MARKET_SIDEWAYS_WEAK';
  }

  if (
    equalWeightReturn5Pct !== null
    && equalWeightReturn20Pct !== null
    && equalWeightReturn5Pct >= 2
    && equalWeightReturn20Pct <= 1
    && upRatio >= 0.55
  ) {
    return 'MARKET_REBOUND';
  }

  if (
    score >= 45
    && equalWeightReturn20Pct !== null
    && equalWeightReturn20Pct >= 4
    && strongRatio >= 0.25
  ) {
    return 'MARKET_STRONG_TREND';
  }

  if (
    score >= 18
    || (upRatio >= 0.55 && strongRatio >= 0.15)
  ) {
    return 'MARKET_WARM';
  }

  return 'MARKET_SIDEWAYS';
}

function buildMarketStateAnalysis(options = {}) {
  const market = String(options.market || 'CN_A').toUpperCase();
  const targetDate = normalizeDate(options.date);
  const barsBySymbol = options.barsBySymbol || options.marketBarsBySymbol || {};

  if (!targetDate) {
    return {
      version: MARKET_STATE_VERSION,
      ok: false,
      reason: 'MISSING_DATE',
      market,
      date: ''
    };
  }

  const snapshots = Object.entries(barsBySymbol)
    .map(([symbol, bars]) => buildSymbolMarketSnapshot(symbol, bars, targetDate, market))
    .filter((item) => item && item.ok);

  const totalInput = Object.keys(barsBySymbol).length;

  if (snapshots.length < Math.max(5, Math.floor(totalInput * 0.25))) {
    return {
      version: MARKET_STATE_VERSION,
      ok: false,
      reason: 'INSUFFICIENT_MARKET_SAMPLE',
      market,
      date: targetDate,
      totalInput,
      sampleCount: snapshots.length
    };
  }

  const upRatio = ratioOf(snapshots, (item) => item.flags.up);
  const downRatio = ratioOf(snapshots, (item) => item.flags.down);
  const bigUpRatio = ratioOf(snapshots, (item) => item.flags.bigUp);
  const bigDropRatio = ratioOf(snapshots, (item) => item.flags.bigDrop);
  const strongRatio = ratioOf(snapshots, (item) => item.flags.strong);
  const weakRatio = ratioOf(snapshots, (item) => item.flags.weak);
  const breakdownRatio = ratioOf(snapshots, (item) => item.flags.breakdown);

  const equalWeightReturn1Pct = average(snapshots.map((item) => item.pctChange));
  const equalWeightReturn5Pct = average(snapshots.map((item) => item.return5Pct));
  const equalWeightReturn20Pct = average(snapshots.map((item) => item.return20Pct));
  const activeRatioMedian = median(snapshots.map((item) => item.activeRatio));
  const activeRatioAverage = average(snapshots.map((item) => item.activeRatio));

  const breadthScore = (upRatio - downRatio) * 45;
  const trendScore = clamp(
    (Number(equalWeightReturn5Pct) || 0) * 2.8
    + (Number(equalWeightReturn20Pct) || 0) * 2.2,
    -28,
    28
  );
  const structureScore = (strongRatio - weakRatio) * 35;
  const liquidityScore = activeRatioMedian !== null
    ? clamp((activeRatioMedian - 1) * 22, -12, 16)
    : 0;
  const riskScore = bigDropRatio * 70 + breakdownRatio * 30;

  const score = roundNumber(clamp(
    breadthScore + trendScore + structureScore + liquidityScore - riskScore,
    -100,
    100
  ), 2);

  const regime = buildMarketRegime({
    score,
    upRatio,
    downRatio,
    strongRatio,
    weakRatio,
    bigDropRatio,
    breakdownRatio,
    equalWeightReturn5Pct,
    equalWeightReturn20Pct,
    activeRatioMedian
  });

  const label = MARKET_REGIME_LABELS[regime] || regime;

  const pct = (value) => roundNumber((Number(value) || 0) * 100, 2);

  return {
    version: MARKET_STATE_VERSION,
    ok: true,
    market,
    date: targetDate,
    regime,
    label,
    score,
    sampleCount: snapshots.length,
    totalInput,
    coveragePct: pct(totalInput > 0 ? snapshots.length / totalInput : 0),
    breadth: {
      upRatioPct: pct(upRatio),
      downRatioPct: pct(downRatio),
      bigUpRatioPct: pct(bigUpRatio),
      bigDropRatioPct: pct(bigDropRatio),
      strongRatioPct: pct(strongRatio),
      weakRatioPct: pct(weakRatio),
      breakdownRatioPct: pct(breakdownRatio)
    },
    trend: {
      equalWeightReturn1Pct: roundNumber(equalWeightReturn1Pct, 2),
      equalWeightReturn5Pct: roundNumber(equalWeightReturn5Pct, 2),
      equalWeightReturn20Pct: roundNumber(equalWeightReturn20Pct, 2)
    },
    liquidity: {
      method: market === 'HK' ? 'close_volume_proxy' : 'amount_or_close_volume_proxy',
      activeRatioMedian: roundNumber(activeRatioMedian, 3),
      activeRatioAverage: roundNumber(activeRatioAverage, 3)
    },
    risk: {
      bigDropRatioPct: pct(bigDropRatio),
      breakdownRatioPct: pct(breakdownRatio),
      weakRatioPct: pct(weakRatio)
    },
    scoreParts: {
      breadthScore: roundNumber(breadthScore, 2),
      trendScore: roundNumber(trendScore, 2),
      structureScore: roundNumber(structureScore, 2),
      liquidityScore: roundNumber(liquidityScore, 2),
      riskScore: roundNumber(riskScore, 2)
    },
    summaryText: `${market}市场态：${label}｜${regime}｜分 ${score}｜上涨 ${pct(upRatio)}%｜下跌 ${pct(downRatio)}%｜强 ${pct(strongRatio)}%｜弱 ${pct(weakRatio)}%`
  };
}

module.exports = {
  MARKET_STATE_VERSION,
  MARKET_REGIME_LABELS,
  buildMarketStateAnalysis
};