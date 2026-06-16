function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }

  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

function calcMaxDrawdownPct(trades, initialCapital) {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += Number(trade.netPnl || 0);

    if (equity > peak) {
      peak = equity;
    }

    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

function computeMetrics(trades, initialCapital) {
  const list = Array.isArray(trades) ? trades : [];
  const tradeCount = list.length;

  if (tradeCount === 0) {
    return {
      tradeCount: 0,
      winRatePct: 0,
      averageReturnPct: 0,
      medianReturnPct: 0,
      maxDrawdownPct: 0,
      maxSingleLoss: 0,
      averageHoldDays: 0,
      grossPnl: 0,
      netPnl: 0,
      totalFees: 0,
      endingCapital: initialCapital,
      netReturnPct: 0
    };
  }

  const wins = list.filter((trade) => Number(trade.netPnl) > 0).length;
  const returns = list.map((trade) => Number(trade.netReturnPct || 0));
  const holdDays = list.map((trade) => Number(trade.holdDays || 0));
  const grossPnl = list.reduce((sum, trade) => sum + Number(trade.grossPnl || 0), 0);
  const netPnl = list.reduce((sum, trade) => sum + Number(trade.netPnl || 0), 0);
  const totalFees = list.reduce((sum, trade) => sum + Number(trade.totalFees || 0), 0);
  const maxSingleLoss = Math.min(...list.map((trade) => Number(trade.netPnl || 0)));
  const endingCapital = initialCapital + netPnl;

  return {
    tradeCount,
    winRatePct: round((wins / tradeCount) * 100),
    averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / tradeCount),
    medianReturnPct: round(median(returns)),
    maxDrawdownPct: round(calcMaxDrawdownPct(list, initialCapital)),
    maxSingleLoss: round(maxSingleLoss),
    averageHoldDays: round(holdDays.reduce((sum, value) => sum + value, 0) / tradeCount),
    grossPnl: round(grossPnl),
    netPnl: round(netPnl),
    totalFees: round(totalFees),
    endingCapital: round(endingCapital),
    netReturnPct: round((netPnl / initialCapital) * 100)
  };
}

module.exports = {
  computeMetrics
};