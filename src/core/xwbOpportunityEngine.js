const {
  DEFAULT_FEE_CONFIG,
  resolveFeeConfig,
  calculateBuyFee,
  calculateSellFee,
  applyBuySlippage,
  applySellSlippage,
  roundMoney
} = require('./feeEngine');
const { computeMetrics } = require('./metricsEngine');

const XWB_OPPORTUNITY_VERSION = 'xwb-opportunity';
const XWB_OPPORTUNITY_MODEL_NAME = '象位归纳法评级模型';
const LOT_SIZE = 100;
const GRADE_ORDER = ['A', 'B', 'C', 'D'];

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

function getStateStatsMap(stateStats) {
  const map = new Map();

  for (const item of Array.isArray(stateStats) ? stateStats : []) {
    if (item && item.stateCode) {
      map.set(item.stateCode, item);
    }
  }

  return map;
}

function hasLabel(section, label) {
  return Boolean(section && Array.isArray(section.labels) && section.labels.includes(label));
}

function normalizeStageScore(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return 0;
  }

  return clamp(num, 0, 100) / 10;
}

function addScore(input, points, reason) {
  input.score += points;

  if (reason) {
    input.reasons.push(reason);
  }
}

function subtractScore(input, points, condition) {
  input.score -= points;

  if (condition) {
    input.failConditions.push(condition);
  }
}

function getOpportunityGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

function isRiskState(stateCode) {
  return [
    'HIGH_CHASE_RISK',
    'HIGH_VOLUME_STALL',
    'BREAKDOWN_RISK'
  ].includes(stateCode);
}

function isPositiveState(stateCode) {
  return [
    'LOW_STARTING',
    'PULLBACK_REPAIR',
    'MID_TREND_CONTINUING'
  ].includes(stateCode);
}

function isBadShape(shapeType) {
  return [
    'UNKNOWN_SHAPE',
    'HIGH_WAVE_RISK',
    'WEAK_BREAKDOWN'
  ].includes(shapeType);
}

function isBadChange(changeType) {
  return [
    'WEAKENING',
    'CONTINUING_DOWN',
    'FAILED_BREAKOUT',
    'VOLUME_PRICE_DIVERGENCE',
    'UNKNOWN_CHANGE'
  ].includes(changeType);
}

function capGrade(grade, maxGrade) {
  const order = ['A', 'B', 'C', 'D'];
  const gradeIndex = order.indexOf(grade);
  const maxIndex = order.indexOf(maxGrade);

  if (gradeIndex < 0) return maxGrade;
  if (maxIndex < 0) return grade;

  return gradeIndex < maxIndex ? maxGrade : grade;
}

function getRiskLevel(opportunity) {
  const stateCode = opportunity.stateCode;
  const shapeType = opportunity.shapeType;
  const positionType = opportunity.positionType;
  const changeType = opportunity.changeType;
  const maxLoss20 = Number(opportunity.historicalStats.maxLoss20);

  if (isRiskState(stateCode)) {
    return 'HIGH';
  }

  if (stateCode === 'UNKNOWN_STATE' && (shapeType === 'UNKNOWN_SHAPE' || positionType === 'HIGH_AREA')) {
    return 'HIGH';
  }

  if (positionType === 'HIGH_CHASE_RISK' || (positionType === 'HIGH_AREA' && shapeType === 'UNKNOWN_SHAPE')) {
    return 'HIGH';
  }

  if (shapeType === 'WEAK_BREAKDOWN' || shapeType === 'HIGH_WAVE_RISK') {
    return 'HIGH';
  }

  if (changeType === 'WEAKENING' || changeType === 'CONTINUING_DOWN' || changeType === 'FAILED_BREAKOUT') {
    return 'HIGH';
  }

  if (stateCode === 'LOW_WEAK_OBSERVE') {
    return 'MID';
  }

  if (Number.isFinite(maxLoss20) && maxLoss20 <= -25) {
    return 'MID';
  }

  if (opportunity.opportunityScore >= 75 && Number.isFinite(maxLoss20) && maxLoss20 > -15) {
    return 'LOW';
  }

  return 'MID';
}

function getActionBias(grade, riskLevel) {
  if (riskLevel === 'HIGH') {
    return grade === 'D' ? 'AVOID' : 'WAIT';
  }

  if (grade === 'A') {
    return 'CAN_TRY';
  }

  if (grade === 'B') {
    return 'WATCH';
  }

  if (grade === 'C') {
    return 'WAIT';
  }

  return 'AVOID';
}

function applyGradeCaps(opportunity) {
  let grade = opportunity.opportunityGrade;
  const sampleCount = Number(opportunity.historicalStats.sampleCount);
  const maxLoss20 = Number(opportunity.historicalStats.maxLoss20);

  if (opportunity.stateCode === 'UNKNOWN_STATE') grade = capGrade(grade, 'C');
  if (opportunity.shapeType === 'UNKNOWN_SHAPE') grade = capGrade(grade, 'C');
  if (opportunity.positionType === 'HIGH_AREA' && opportunity.shapeType === 'UNKNOWN_SHAPE') grade = capGrade(grade, 'C');

  if (opportunity.stateCode === 'HIGH_CHASE_RISK') grade = capGrade(grade, 'C');
  if (opportunity.stateCode === 'HIGH_VOLUME_STALL') grade = capGrade(grade, 'C');
  if (opportunity.stateCode === 'BREAKDOWN_RISK') grade = capGrade(grade, 'C');
  if (opportunity.stateCode === 'LOW_WEAK_OBSERVE') grade = capGrade(grade, 'C');

  if (sampleCount < 10) grade = capGrade(grade, 'C');
  if (sampleCount >= 10 && sampleCount < 20) grade = capGrade(grade, 'B');

  if (Number.isFinite(maxLoss20) && maxLoss20 <= -35) grade = capGrade(grade, 'C');

  if (opportunity.changeType === 'WEAKENING') grade = capGrade(grade, 'C');
  if (opportunity.changeType === 'CONTINUING_DOWN') grade = capGrade(grade, 'C');
  if (opportunity.changeType === 'FAILED_BREAKOUT') grade = capGrade(grade, 'C');

  if (opportunity.riskLevel === 'HIGH') grade = capGrade(grade, 'C');

  return grade;
}

function buildHistoricalStats(stateStat) {
  const source = stateStat || {};

  return {
    sampleCount: Number.isFinite(Number(source.sampleCount)) ? Number(source.sampleCount) : 0,
    winRate20: roundNumber(source.winRate20),
    avgReturn20: roundNumber(source.avgReturn20),
    medianReturn20: roundNumber(source.medianReturn20),
    maxLoss20: roundNumber(source.maxLoss20),
    maxGain20: roundNumber(source.maxGain20)
  };
}

function buildDailyOpportunity(dailyState, stateStat) {
  const shape = dailyState && dailyState.shape ? dailyState.shape : {};
  const position = dailyState && dailyState.position ? dailyState.position : {};
  const change = dailyState && dailyState.change ? dailyState.change : {};
  const historicalStats = buildHistoricalStats(stateStat);
  const scoreInput = {
    score: 45,
    reasons: [],
    failConditions: []
  };
  const sampleCount = historicalStats.sampleCount;
  const winRate20 = Number(historicalStats.winRate20);
  const avgReturn20 = Number(historicalStats.avgReturn20);
  const medianReturn20 = Number(historicalStats.medianReturn20);
  const maxLoss20 = Number(historicalStats.maxLoss20);
  const shapeType = shape.type || 'UNKNOWN_SHAPE';
  const positionType = position.type || 'MID_AREA';
  const changeType = change.type || 'UNKNOWN_CHANGE';
  const stateCode = dailyState.stateCode || 'UNKNOWN_STATE';

  if (sampleCount >= 20) addScore(scoreInput, 5, '同类状态样本数达到 20 个以上');
  if (Number.isFinite(winRate20) && winRate20 >= 55) addScore(scoreInput, 8, '同类状态 20 日胜率达到 55% 以上');
  if (Number.isFinite(winRate20) && winRate20 >= 65) addScore(scoreInput, 8, '同类状态 20 日胜率达到 65% 以上');
  if (Number.isFinite(avgReturn20) && avgReturn20 > 0) addScore(scoreInput, 8, '同类状态 20 日平均收益为正');
  if (Number.isFinite(medianReturn20) && medianReturn20 > 0) addScore(scoreInput, 8, '同类状态 20 日中位收益为正');

  if (stateCode === 'LOW_STARTING') addScore(scoreInput, 18, '综合状态为低位启动型变化');
  if (stateCode === 'PULLBACK_REPAIR') addScore(scoreInput, 15, '综合状态为回踩修复');
  if (stateCode === 'MID_TREND_CONTINUING') addScore(scoreInput, 8, '综合状态为中位趋势延续');

  if (!isBadShape(shapeType)) {
    addScore(scoreInput, normalizeStageScore(shape.score) * 2, '观其形评分参与机会定价');
  } else {
    subtractScore(scoreInput, 10, '观其形未形成可用机会形态');
  }

  if (positionType !== 'HIGH_CHASE_RISK' && positionType !== 'HIGH_AREA') {
    addScore(scoreInput, normalizeStageScore(position.score) * 2, '知其位评分参与机会定价');
  } else {
    subtractScore(scoreInput, 10, '知其位显示位置风险偏高');
  }

  if (!isBadChange(changeType)) {
    addScore(scoreInput, normalizeStageScore(change.score) * 2.5, '复察其变评分参与机会定价');
  } else {
    subtractScore(scoreInput, 15, '复察其变未确认有利变化');
  }

  if (sampleCount < 10) subtractScore(scoreInput, 15, '同类状态样本数少于 10 个');
  if (Number.isFinite(maxLoss20) && maxLoss20 <= -15) subtractScore(scoreInput, 6, '同类状态 20 日最大亏损超过 15%');
  if (Number.isFinite(maxLoss20) && maxLoss20 <= -25) subtractScore(scoreInput, 8, '同类状态 20 日最大亏损超过 25%');

  if (stateCode === 'UNKNOWN_STATE') subtractScore(scoreInput, 20, '综合状态未明确');
  if (stateCode === 'HIGH_CHASE_RISK') subtractScore(scoreInput, 30, '综合状态为高位追涨风险');
  if (stateCode === 'HIGH_VOLUME_STALL') subtractScore(scoreInput, 25, '综合状态为高位放量滞涨');
  if (stateCode === 'BREAKDOWN_RISK') subtractScore(scoreInput, 30, '综合状态为破位风险');
  if (stateCode === 'LOW_WEAK_OBSERVE') subtractScore(scoreInput, 15, '综合状态为低位弱势观察');
  if (changeType === 'WEAKENING') subtractScore(scoreInput, 15, '变化阶段转弱');
  if (hasLabel(position, 'HIGH_CHASE_RISK')) subtractScore(scoreInput, 20, '位置标签含高位追涨风险');
  if (shapeType === 'HIGH_WAVE_RISK') subtractScore(scoreInput, 15, '形态为长上影或冲高回落风险');
  if (shapeType === 'WEAK_BREAKDOWN') subtractScore(scoreInput, 20, '形态为破位下跌');

  const opportunityScore = roundNumber(clamp(scoreInput.score, 0, 100));
  const draft = {
    date: dailyState.date,
    close: dailyState.close,
    stateCode,
    stateName: dailyState.stateName,
    shapeType,
    positionType,
    changeType,
    shapeScore: roundNumber(shape.score),
    positionScore: roundNumber(position.score),
    changeScore: roundNumber(change.score),
    historicalStats,
    opportunityScore,
    opportunityGrade: getOpportunityGrade(opportunityScore),
    riskLevel: 'MID',
    actionBias: 'WAIT',
    reasons: scoreInput.reasons,
    failConditions: scoreInput.failConditions
  };

  draft.riskLevel = getRiskLevel(draft);
  draft.opportunityGrade = applyGradeCaps(draft);
  draft.actionBias = getActionBias(draft.opportunityGrade, draft.riskLevel);

  return draft;
}

function buildDailyOpportunities(dailyStates, stateStats) {
  const statsMap = getStateStatsMap(stateStats);

  return (Array.isArray(dailyStates) ? dailyStates : []).map((dailyState) => {
    return buildDailyOpportunity(dailyState, statsMap.get(dailyState && dailyState.stateCode));
  });
}

function buildGradeStats(dailyOpportunities, dailyStates) {
  const stateByDate = new Map((Array.isArray(dailyStates) ? dailyStates : [])
    .map((item) => [String(item && item.date), item]));

  return GRADE_ORDER.map((grade) => {
    const items = (Array.isArray(dailyOpportunities) ? dailyOpportunities : [])
      .filter((item) => item && item.opportunityGrade === grade);
    const future20 = items
      .map((item) => {
        const state = stateByDate.get(String(item.date));
        const value = state && state.futureReturns ? state.futureReturns.d20 : null;
        return value === null || value === undefined || value === '' ? NaN : Number(value);
      })
      .filter(Number.isFinite);
    const scores = items.map((item) => Number(item.opportunityScore)).filter(Number.isFinite);
    const wins = future20.filter((value) => value > 0).length;
    const riskHighCount = items.filter((item) => item.riskLevel === 'HIGH').length;

    return {
      grade,
      count: items.length,
      avgFuture20: future20.length
        ? roundNumber(future20.reduce((sum, value) => sum + value, 0) / future20.length)
        : null,
      winRate20: future20.length ? roundNumber((wins / future20.length) * 100) : null,
      avgScore: scores.length
        ? roundNumber(scores.reduce((sum, value) => sum + value, 0) / scores.length)
        : null,
      riskHighCount
    };
  });
}

function canEnterOpportunity(opportunity) {
  if (!opportunity) {
    return false;
  }

  if (!(opportunity.opportunityGrade === 'A' || opportunity.opportunityGrade === 'B')) {
    return false;
  }

  if (opportunity.riskLevel === 'HIGH') {
    return false;
  }

  if (!(opportunity.actionBias === 'CAN_TRY' || opportunity.actionBias === 'WATCH')) {
    return false;
  }

  if (!isPositiveState(opportunity.stateCode)) {
    return false;
  }

  if (isBadShape(opportunity.shapeType) || isBadChange(opportunity.changeType)) {
    return false;
  }

  return true;
}

function getPlannedHoldDays(opportunity, fallbackHoldDays) {
  if (opportunity && opportunity.opportunityGrade === 'A') {
    return 20;
  }

  if (opportunity && opportunity.opportunityGrade === 'B') {
    return 10;
  }

  return fallbackHoldDays;
}

function getStopLossPct(opportunity, fallbackStopLossPct) {
  if (opportunity && opportunity.opportunityGrade === 'A') {
    return 0.08;
  }

  if (opportunity && opportunity.opportunityGrade === 'B') {
    return 0.05;
  }

  return fallbackStopLossPct;
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

function buildSellDecision(bars, index, position, opportunity) {
  const bar = bars[index] || {};
  const close = getNumber(bar.close);
  const low = getNumber(bar.low);
  const stopPrice = position.buyPrice * (1 - position.stopLossPct);
  const holdDays = index - position.entryIndex;

  if (low !== null && low <= stopPrice) {
    return {
      shouldSell: true,
      exitReason: 'OPPORTUNITY_STOP_LOSS',
      rawSellPrice: stopPrice
    };
  }

  if (opportunity && opportunity.opportunityGrade === 'D' && opportunity.riskLevel === 'HIGH' && close !== null) {
    return {
      shouldSell: true,
      exitReason: 'OPPORTUNITY_HIGH_RISK_D',
      rawSellPrice: close
    };
  }

  if (holdDays >= position.plannedHoldDays && close !== null) {
    return {
      shouldSell: true,
      exitReason: 'OPPORTUNITY_TIME_EXIT',
      rawSellPrice: close
    };
  }

  if (index >= bars.length - 1 && close !== null) {
    return {
      shouldSell: true,
      exitReason: 'OPPORTUNITY_FINAL_EXIT',
      rawSellPrice: close
    };
  }

  return {
    shouldSell: false,
    exitReason: ''
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
  const opportunity = position.signalOpportunity || {};
  const state = position.signalState || {};

  return {
    cashAfterSell,
    trade: {
      algoVersion: XWB_OPPORTUNITY_VERSION,
      modelId: XWB_OPPORTUNITY_VERSION,
      modelName: XWB_OPPORTUNITY_MODEL_NAME,
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
      plannedHoldDays: position.plannedHoldDays,
      exitReason: sellDecision.exitReason,
      grossPnl: roundMoney(grossPnl),
      netPnl: roundMoney(netPnl),
      grossReturnPct,
      netReturnPct,
      totalFees: roundMoney(totalFees),
      opportunityGrade: opportunity.opportunityGrade,
      opportunityScore: opportunity.opportunityScore,
      riskLevel: opportunity.riskLevel,
      actionBias: opportunity.actionBias,
      opportunityReasons: opportunity.reasons,
      opportunityFailConditions: opportunity.failConditions,
      stateCode: opportunity.stateCode,
      stateName: opportunity.stateName,
      shapeType: opportunity.shapeType,
      positionType: opportunity.positionType,
      changeType: opportunity.changeType,
      shapeScore: opportunity.shapeScore,
      positionScore: opportunity.positionScore,
      changeScore: opportunity.changeScore,
      shapeReasons: state.shape && state.shape.reasons,
      positionReasons: state.position && state.position.reasons,
      changeReasons: state.change && state.change.reasons,
      range60: state.position && state.position.range60,
      range120: state.position && state.position.range120,
      range250: state.position && state.position.range250,
      aboveLongMa: state.position && (state.position.aboveMa120 || state.position.aboveMa250),
      highChase: opportunity.stateCode === 'HIGH_CHASE_RISK' || opportunity.riskLevel === 'HIGH',
      lowStart: opportunity.stateCode === 'LOW_STARTING',
      futureReturns: state.futureReturns
    }
  };
}

function calcEquityMaxDrawdownPct(equityCurve) {
  let peak = null;
  let maxDrawdown = 0;

  for (const point of Array.isArray(equityCurve) ? equityCurve : []) {
    const equity = Number(point && point.equity);

    if (!Number.isFinite(equity) || equity <= 0) {
      continue;
    }

    if (peak === null || equity > peak) {
      peak = equity;
    }

    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return roundNumber(maxDrawdown) || 0;
}

function buildDiagnostics(dailyOpportunities) {
  return (Array.isArray(dailyOpportunities) ? dailyOpportunities : []).map((item) => ({
    date: item.date,
    close: item.close,
    stateCode: item.stateCode,
    opportunityGrade: item.opportunityGrade,
    opportunityScore: item.opportunityScore,
    riskLevel: item.riskLevel,
    actionBias: item.actionBias,
    finalAction: canEnterOpportunity(item) ? 'OBSERVE_VALUE' : 'NO_ACTION',
    rejectReason: item.failConditions && item.failConditions[0] ? item.failConditions[0] : ''
  }));
}

function buildConfig(input) {
  const raw = {
    initialCapital: 100000,
    feeConfig: DEFAULT_FEE_CONFIG,
    holdDays: 20,
    stopLossPct: 0.08,
    ...(input || {})
  };
  const initialCapital = Number(raw.initialCapital);
  const holdDays = Number(raw.holdDays);
  const stopLossPct = Number(raw.stopLossPct);

  return {
    initialCapital: Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 100000,
    feeConfig: resolveFeeConfig(raw.feeConfig),
    holdDays: Number.isInteger(holdDays) && holdDays > 0 ? holdDays : 20,
    stopLossPct: Number.isFinite(stopLossPct) && stopLossPct > 0 && stopLossPct < 1 ? stopLossPct : 0.08
  };
}

function runOpportunityBacktest(input) {
  const bars = Array.isArray(input && input.bars) ? input.bars : [];
  const dailyStates = Array.isArray(input && input.dailyStates) ? input.dailyStates : [];
  const stateStats = Array.isArray(input && input.stateStats) ? input.stateStats : [];
  const config = buildConfig(input);
  const feeConfig = config.feeConfig;
  const dailyOpportunities = buildDailyOpportunities(dailyStates, stateStats);
  const gradeStats = buildGradeStats(dailyOpportunities, dailyStates);
  const stateByDate = new Map(dailyStates.map((item) => [String(item && item.date), item]));
  const trades = [];
  const equityCurve = [];

  let cash = config.initialCapital;
  let position = null;
  let pendingBuy = null;

  for (let index = 0; index < bars.length; index += 1) {
    let dayNetPnl = 0;
    let tradeIndex = null;
    const bar = bars[index] || {};
    const opportunity = dailyOpportunities[index];

    if (pendingBuy && pendingBuy.entryIndex === index) {
      const buyAmount = pendingBuy.shares * pendingBuy.buyPrice;
      const buyFee = calculateBuyFee(buyAmount, feeConfig);

      cash -= buyAmount + buyFee.totalBuyFee;
      position = {
        ...pendingBuy,
        buyAmount,
        buyFee
      };
      pendingBuy = null;
    }

    if (position && index > position.entryIndex) {
      const sellDecision = buildSellDecision(bars, index, position, opportunity);

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
        position = null;
      }
    }

    if (!position && !pendingBuy && index < bars.length - 1 && canEnterOpportunity(opportunity)) {
      const entryBar = bars[index + 1] || {};
      const rawBuyPrice = getNumber(entryBar.open);

      if (rawBuyPrice !== null && rawBuyPrice > 0) {
        const buyPrice = applyBuySlippage(rawBuyPrice, feeConfig);
        const shares = getAffordableShares(cash, buyPrice, feeConfig);

        if (shares >= LOT_SIZE) {
          pendingBuy = {
            signalIndex: index,
            entryIndex: index + 1,
            buyPrice,
            shares,
            plannedHoldDays: getPlannedHoldDays(opportunity, config.holdDays),
            stopLossPct: getStopLossPct(opportunity, config.stopLossPct),
            signalOpportunity: opportunity,
            signalState: stateByDate.get(String(opportunity.date))
          };
        }
      }
    }

    equityCurve.push({
      date: bar.date,
      equity: roundMoney(getEquity(cash, position, bar)),
      netPnl: roundMoney(dayNetPnl),
      tradeIndex
    });
  }

  const endingCapital = roundMoney(equityCurve.length ? equityCurve[equityCurve.length - 1].equity : cash);
  const netPnl = endingCapital - config.initialCapital;
  const metrics = {
    ...computeMetrics(trades, config.initialCapital),
    endingCapital,
    netPnl: roundMoney(netPnl),
    netReturnPct: roundNumber((netPnl / config.initialCapital) * 100) || 0,
    maxDrawdownPct: calcEquityMaxDrawdownPct(equityCurve)
  };

  return {
    modelId: XWB_OPPORTUNITY_VERSION,
    modelName: XWB_OPPORTUNITY_MODEL_NAME,
    algoVersion: XWB_OPPORTUNITY_VERSION,
    config,
    metrics,
    trades,
    allTrades: trades,
    equityCurve,
    diagnostics: buildDiagnostics(dailyOpportunities),
    dailyOpportunities,
    gradeStats,
    sampleTrades: trades.slice(-8)
  };
}

module.exports = {
  XWB_OPPORTUNITY_VERSION,
  XWB_OPPORTUNITY_MODEL_NAME,
  buildDailyOpportunities,
  buildGradeStats,
  runOpportunityBacktest
};
