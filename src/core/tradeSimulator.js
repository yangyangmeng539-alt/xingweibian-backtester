const { evaluateShape } = require('./signalEngine');
const { evaluatePosition } = require('./positionEngine');
const { confirmContinuation, calcFutureReturns } = require('./changeEngine');
const {
  DEFAULT_FEE_CONFIG,
  resolveFeeConfig,
  calculateBuyFee,
  calculateTradeFees,
  applyBuySlippage,
  applySellSlippage,
  roundMoney
} = require('./feeEngine');

function getPositiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getIntegerAtLeast(value, fallback, min) {
  const num = Number(value);
  return Number.isInteger(num) && num >= min ? num : fallback;
}

function getStopLossPct(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 && num < 1 ? num : fallback;
}

function buildSimulationConfig(inputConfig) {
  const defaults = {
    modelId: 'A',
    modelName: 'A 模型',
    requirePosition: false,
    requireChange: false,
    holdDays: 10,
    stopLossPct: 0.08,
    initialCapital: 100000,
    feeConfig: DEFAULT_FEE_CONFIG
  };
  const raw = {
    ...defaults,
    ...(inputConfig || {})
  };

  return {
    ...raw,
    holdDays: getIntegerAtLeast(raw.holdDays, defaults.holdDays, 1),
    stopLossPct: getStopLossPct(raw.stopLossPct, defaults.stopLossPct),
    initialCapital: getPositiveNumber(raw.initialCapital, defaults.initialCapital),
    feeConfig: resolveFeeConfig(raw.feeConfig)
  };
}

function getAffordableShares(capital, buyPrice, feeConfig) {
  let shares = Math.floor(Number(capital) / (Number(buyPrice) * 100)) * 100;

  while (shares >= 100) {
    const buyAmount = shares * buyPrice;
    const buyFee = calculateBuyFee(buyAmount, feeConfig);

    if (buyAmount + buyFee.totalBuyFee <= capital) {
      return shares;
    }

    shares -= 100;
  }

  return 0;
}

function findExit(bars, entryIndex, buyPrice, holdDays, stopLossPct, feeConfig) {
  const forcedExitIndex = Math.min(entryIndex + holdDays, bars.length - 1);
  const stopPrice = buyPrice * (1 - stopLossPct);

  let exitIndex = forcedExitIndex;
  let exitReason = 'TIME_EXIT';
  let rawSellPrice = Number(bars[forcedExitIndex].close);

  for (let index = entryIndex + 1; index <= forcedExitIndex; index += 1) {
    const low = Number(bars[index].low);

    if (Number.isFinite(low) && low <= stopPrice) {
      exitIndex = index;
      exitReason = 'STOP_LOSS';
      rawSellPrice = stopPrice;
      break;
    }
  }

  return {
    exitIndex,
    exitReason,
    sellPrice: applySellSlippage(rawSellPrice, feeConfig)
  };
}

function buildEquityCurve(bars, trades, initialCapital) {
  const sortedTrades = [...trades].sort((a, b) => a.exitIndex - b.exitIndex);
  let equity = Number(initialCapital);
  let cursor = 0;

  return bars.map((bar) => {
    let netPnl = 0;
    let tradeIndex = null;

    while (
      cursor < sortedTrades.length &&
      Number(sortedTrades[cursor].exitIndex) <= Number(bar.index)
    ) {
      const trade = sortedTrades[cursor];
      const tradePnl = Number(trade.netPnl || 0);

      equity += tradePnl;
      netPnl += tradePnl;
      tradeIndex = cursor;
      cursor += 1;
    }

    return {
      date: bar.date,
      equity: roundMoney(equity),
      netPnl: roundMoney(netPnl),
      tradeIndex
    };
  });
}

function simulateModelTrades(input) {
  const bars = input.bars;
  const config = buildSimulationConfig(input.config);
  const feeConfig = config.feeConfig;

  let capital = config.initialCapital;
  let lastExitIndex = -1;
  const trades = [];

  for (let signalIndex = 60; signalIndex < bars.length - 2; signalIndex += 1) {
    if (signalIndex <= lastExitIndex) {
      continue;
    }

    const shape = evaluateShape(bars, signalIndex);

    if (!shape.pass) {
      continue;
    }

    let position = null;

    if (config.requirePosition) {
      position = evaluatePosition(bars, signalIndex);

      if (!position.pass) {
        continue;
      }
    }

    let entryIndex = signalIndex + 1;
    let change = null;

    if (config.requireChange) {
      change = confirmContinuation(bars, signalIndex);

      if (!change.pass) {
        continue;
      }

      entryIndex = change.entryIndex;
    }

    if (entryIndex <= signalIndex || entryIndex >= bars.length - 1) {
      continue;
    }

    const entryBar = bars[entryIndex];
    const rawBuyPrice = Number(entryBar.open);

    if (!Number.isFinite(rawBuyPrice) || rawBuyPrice <= 0) {
      continue;
    }

    const buyPrice = applyBuySlippage(rawBuyPrice, feeConfig);
    const shares = getAffordableShares(capital, buyPrice, feeConfig);

    if (shares < 100) {
      continue;
    }

    const exit = findExit(
      bars,
      entryIndex,
      buyPrice,
      config.holdDays,
      config.stopLossPct,
      feeConfig
    );

    const exitBar = bars[exit.exitIndex];
    const buyAmount = shares * buyPrice;
    const sellAmount = shares * exit.sellPrice;
    const fees = calculateTradeFees({ buyAmount, sellAmount }, feeConfig);

    const grossPnl = sellAmount - buyAmount;
    const netPnl = grossPnl - fees.totalFees;
    const netReturnPct = (netPnl / (buyAmount + fees.totalBuyFee)) * 100;
    const grossReturnPct = (grossPnl / buyAmount) * 100;
    const holdDays = exit.exitIndex - entryIndex;

    capital += netPnl;
    lastExitIndex = exit.exitIndex;

    trades.push({
      modelId: config.modelId,
      modelName: config.modelName,
      signalDate: bars[signalIndex].date,
      entryDate: entryBar.date,
      exitDate: exitBar.date,
      signalIndex,
      entryIndex,
      exitIndex: exit.exitIndex,
      entryPrice: roundMoney(buyPrice),
      exitPrice: roundMoney(exit.sellPrice),
      shares,
      holdDays,
      exitReason: exit.exitReason,
      grossPnl: roundMoney(grossPnl),
      netPnl: roundMoney(netPnl),
      grossReturnPct,
      netReturnPct,
      totalFees: fees.totalFees,
      shapeScore: shape.score,
      shapeReasons: shape.reasons,
      range60: position ? position.range60 : null,
      range120: position ? position.range120 : null,
      range250: position ? position.range250 : null,
      highChase: position ? position.highChase : null,
      lowStart: position ? position.lowStart : null,
      aboveLongMa: position ? position.aboveLongMa : null,
      aboveYearMa: position ? position.aboveYearMa : null,
      notTooHigh: position ? position.notTooHigh : null,
      positionReasons: position ? position.reasons : [],
      changeReasons: change ? change.reasons : [],
      futureReturns: calcFutureReturns(bars, signalIndex)
    });
  }

  return {
    trades,
    equityCurve: buildEquityCurve(
      bars.map((bar, index) => ({
        ...bar,
        index
      })),
      trades,
      config.initialCapital
    ),
    endingCapital: capital
  };
}

module.exports = {
  simulateModelTrades
};
