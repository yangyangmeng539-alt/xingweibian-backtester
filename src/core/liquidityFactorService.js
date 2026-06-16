const LIQUIDITY_FACTOR_VERSION = 'xwb-a-share-liquidity-factor-v1';

function safeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 2) {
  const number = safeNumber(value);

  if (number === null) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) {
    return null;
  }

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function ratio(current, base) {
  const left = safeNumber(current);
  const right = safeNumber(base);

  if (left === null || right === null || right <= 0) {
    return null;
  }

  return left / right;
}

function isAshareSymbol(symbol, market) {
  const cleanMarket = String(market || '').trim().toUpperCase();
  const cleanSymbol = String(symbol || '').trim().toUpperCase();

  if (cleanMarket && cleanMarket !== 'CN_A' && cleanMarket !== 'A') {
    return false;
  }

  if (cleanSymbol.includes('HK')) {
    return false;
  }

  return /^\d{6}$/.test(cleanSymbol);
}

function getBarNumber(bar, key) {
  if (!bar) {
    return null;
  }

  if (key === 'pctChange') {
    return safeNumber(bar.pctChange !== undefined ? bar.pctChange : bar.pct_change);
  }

  if (key === 'changeAmount') {
    return safeNumber(bar.changeAmount !== undefined ? bar.changeAmount : bar.change_amount);
  }

  return safeNumber(bar[key]);
}

function sliceBeforeOnly(bars, clickedIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex) || clickedIndex <= 0) {
    return [];
  }

  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, clickedIndex - size);

  return bars.slice(start, clickedIndex).filter(Boolean);
}

function sliceBeforeAndAt(bars, clickedIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(clickedIndex) || clickedIndex < 0) {
    return [];
  }

  const size = Math.max(1, Number(days) || 1);
  const start = Math.max(0, clickedIndex - size + 1);

  return bars.slice(start, clickedIndex + 1).filter(Boolean);
}

function valuesOf(rows, key) {
  return (Array.isArray(rows) ? rows : [])
    .map((bar) => getBarNumber(bar, key))
    .filter((value) => value !== null);
}

function getCurrentStateType(currentState, groupKey) {
  return String(
    currentState
      && currentState[groupKey]
      && currentState[groupKey].type
      ? currentState[groupKey].type
      : ''
  );
}

function countField(rows, key) {
  const total = Array.isArray(rows) ? rows.length : 0;
  const present = (Array.isArray(rows) ? rows : []).filter((bar) => {
    const value = getBarNumber(bar, key);
    return value !== null && Number.isFinite(value);
  }).length;

  return {
    total,
    present,
    ratePct: total > 0 ? roundNumber(present / total * 100, 2) : null
  };
}

function getFieldCoverage(rows) {
  return {
    volume: countField(rows, 'volume'),
    amount: countField(rows, 'amount'),
    amplitude: countField(rows, 'amplitude'),
    pctChange: countField(rows, 'pctChange'),
    changeAmount: countField(rows, 'changeAmount'),
    turnover: countField(rows, 'turnover')
  };
}

function getLiquidityRegime(score, supportScore, riskScore) {
  if (riskScore >= 2.6 && score <= -0.8) {
    return 'LIQUIDITY_RISK_RELEASE';
  }

  if (supportScore >= 2.4 && score >= 1) {
    return 'LIQUIDITY_CONFIRMING';
  }

  if (supportScore >= 1.2 && score >= 0.45) {
    return 'LIQUIDITY_WARMING';
  }

  if (riskScore >= 1.4 && score <= -0.25) {
    return 'LIQUIDITY_DIVERGENCE_RISK';
  }

  if (Math.abs(score) < 0.35) {
    return 'LIQUIDITY_NEUTRAL';
  }

  return score > 0 ? 'LIQUIDITY_SLIGHT_SUPPORT' : 'LIQUIDITY_SLIGHT_RISK';
}

function getLiquidityRegimeLabel(regime) {
  const labels = {
    LIQUIDITY_CONFIRMING: '量价确认',
    LIQUIDITY_WARMING: '量能预热',
    LIQUIDITY_SLIGHT_SUPPORT: '轻度支撑',
    LIQUIDITY_NEUTRAL: '量价中性',
    LIQUIDITY_SLIGHT_RISK: '轻度风险',
    LIQUIDITY_DIVERGENCE_RISK: '量价背离风险',
    LIQUIDITY_RISK_RELEASE: '放量风险释放'
  };

  return labels[regime] || regime || '量价未知';
}

function hasLiquiditySignal(signals, label) {
  return (Array.isArray(signals) ? signals : []).some((signal) => {
    return signal && signal.label === label;
  });
}

function makePathAdjustment(shape, shapeLabel, d5, d10, d20) {
  return {
    shape,
    shapeLabel,
    d5: roundNumber(d5, 2),
    d10: roundNumber(d10, 2),
    d20: roundNumber(d20, 2)
  };
}

function scaleLiquidityPathAdjustment(pathAdjustment, options = {}) {
  const source = pathAdjustment && typeof pathAdjustment === 'object'
    ? pathAdjustment
    : {};

  const read = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const scaleD5 = Number.isFinite(Number(options.d5)) ? Number(options.d5) : 1;
  const scaleD10 = Number.isFinite(Number(options.d10)) ? Number(options.d10) : 1;
  const scaleD20 = Number.isFinite(Number(options.d20)) ? Number(options.d20) : 1;
  const label = String(options.label || '').trim();

  return {
    ...source,
    d5: roundNumber(read(source.d5) * scaleD5, 2),
    d10: roundNumber(read(source.d10) * scaleD10, 2),
    d20: roundNumber(read(source.d20) * scaleD20, 2),
    validationGate: String(options.gate || ''),
    shapeLabel: label
      ? `${source.shapeLabel || '量价路径'}｜${label}`
      : source.shapeLabel
  };
}

function applyLiquidityValidationGate(pathAdjustment, regime) {
  const key = String(regime || '');

    if (key === 'LIQUIDITY_WARMING') {
        return scaleLiquidityPathAdjustment(pathAdjustment, {
        gate: 'WARMING_PATH_ONLY_NO_TAIL',
        label: '验证定版：预热只改路径，不改终点',
        d5: 0.95,
        d10: 0.72,
        d20: 0
        });
    }

  if (key === 'LIQUIDITY_SLIGHT_SUPPORT') {
    return scaleLiquidityPathAdjustment(pathAdjustment, {
      gate: 'PATH_ONLY_SLIGHT_SUPPORT',
      label: '验证收敛：只保留弱支撑纹理',
      d5: 0.65,
      d10: 0.50,
      d20: 0.22
    });
  }

  if (key === 'LIQUIDITY_CONFIRMING') {
    return scaleLiquidityPathAdjustment(pathAdjustment, {
      gate: 'NO_TAIL_CONFIRMING',
      label: '验证收敛：确认只看短冲击，不推终点',
      d5: 0.45,
      d10: 0.30,
      d20: 0
    });
  }

  if (key === 'LIQUIDITY_RISK_RELEASE') {
    return scaleLiquidityPathAdjustment(pathAdjustment, {
      gate: 'NO_TAIL_RISK_RELEASE',
      label: '验证收敛：释放只看路径，不改方向',
      d5: 0.55,
      d10: 0.30,
      d20: 0
    });
  }

  if (key === 'LIQUIDITY_DIVERGENCE_RISK') {
    return scaleLiquidityPathAdjustment(pathAdjustment, {
      gate: 'NO_TAIL_DIVERGENCE_LOW_SAMPLE',
      label: '样本偏少：只保留背离纹理',
      d5: 0.35,
      d10: 0.20,
      d20: 0
    });
  }

  if (key === 'LIQUIDITY_SLIGHT_RISK') {
    return scaleLiquidityPathAdjustment(pathAdjustment, {
      gate: 'DISABLE_SLIGHT_RISK',
      label: '验证关闭：轻微风险不参与终点',
      d5: 0,
      d10: 0,
      d20: 0
    });
  }

  return pathAdjustment;
}

function buildLiquidityPathAdjustment(options = {}) {
  const regime = String(options.regime || '');
  const signals = Array.isArray(options.signals) ? options.signals : [];
  const score = safeNumber(options.score) || 0;
  const supportScore = Math.max(0, safeNumber(options.supportScore) || 0);
  const riskScore = Math.max(0, safeNumber(options.riskScore) || 0);
  const signalCount = signals.length;
  const confidenceScale = signalCount >= 4 ? 1 : signalCount >= 2 ? 0.82 : 0.58;

  const supportBase = clamp(Math.max(Math.abs(score), supportScore) * 0.78 * confidenceScale, 0, 3.1);
  const riskBase = clamp(Math.max(Math.abs(score), riskScore) * 0.78 * confidenceScale, 0, 3.1);
  const neutralBase = clamp(Math.abs(score) * 0.62 * confidenceScale, 0, 2.2);

  if (!signalCount || regime === 'LIQUIDITY_NEUTRAL') {
    return makePathAdjustment('FLAT', '量价中性平滑', 0, 0, 0);
  }

  if (hasLiquiditySignal(signals, 'HIGH_AREA_AMOUNT_STALL')) {
    const base = Math.max(riskBase, 0.6);
    return makePathAdjustment(
      'SPIKE_THEN_FADE',
      '高位放量滞涨：先冲后回落',
      base * 0.22,
      -base * 0.62,
      -base * 1.05
    );
  }

  if (
    hasLiquiditySignal(signals, 'WIDE_AMPLITUDE_NO_PRICE_CONFIRM')
    || hasLiquiditySignal(signals, 'RECENT_WIDE_SWING_WITH_AMOUNT')
    || regime === 'LIQUIDITY_DIVERGENCE_RISK'
  ) {
    const base = Math.max(riskBase, 0.5);
    return makePathAdjustment(
      'DIVERGENCE_FADE',
      '量价背离：前段犹豫，中段回落，终点保守',
      base * 0.08,
      -base * 0.28,
      -base * 0.12
    );
  }

  if (
    hasLiquiditySignal(signals, 'SELLING_AMOUNT_RELEASE')
    || hasLiquiditySignal(signals, 'TURNOVER_PANIC_RELEASE')
    || regime === 'LIQUIDITY_RISK_RELEASE'
  ) {
    const base = Math.max(riskBase, 0.65);
    return makePathAdjustment(
      'FAST_DROP_WEAK_REPAIR',
      '放量风险释放：先急杀，后弱修复',
      -base * 0.82,
      -base * 1.08,
      -base * 0.72
    );
  }

  if (hasLiquiditySignal(signals, 'SHRINK_PULLBACK')) {
    const base = Math.max(supportBase, 0.45);
    return makePathAdjustment(
      'PULLBACK_THEN_REPAIR',
      '缩量回踩：先下探，后修复',
      -base * 0.35,
      base * 0.18,
      base * 0.62
    );
  }

  if (regime === 'LIQUIDITY_CONFIRMING') {
    const base = Math.max(supportBase, 0.75);
    return makePathAdjustment(
      'FRONT_IMPULSE_CONFIRM',
      '量价确认：前段冲击，后段收敛',
      base * 0.48,
      base * 0.42,
      base * 0.12
    );
  }

  if (regime === 'LIQUIDITY_WARMING') {
    const base = Math.max(supportBase, 0.55);
    return makePathAdjustment(
      'BACK_LOADED_WARMING',
      '量能预热：后段上弯',
      base * 0.26,
      base * 0.64,
      base * 0.96
    );
  }

  if (regime === 'LIQUIDITY_SLIGHT_SUPPORT') {
    const base = Math.max(supportBase || neutralBase, 0.28);
    return makePathAdjustment(
      'SLOW_SUPPORT',
      '轻度支撑：缓慢抬升',
      base * 0.18,
      base * 0.36,
      base * 0.52
    );
  }

  if (regime === 'LIQUIDITY_SLIGHT_RISK') {
    const base = Math.max(riskBase || neutralBase, 0.28);
    return makePathAdjustment(
      'SLOW_RISK',
      '轻度风险：缓慢压低',
      -base * 0.12,
      -base * 0.22,
      -base * 0.28
    );
  }

  if (score > 0) {
    const base = Math.max(supportBase || neutralBase, 0.25);
    return makePathAdjustment(
      'MILD_UP_CURVE',
      '温和上弯',
      base * 0.2,
      base * 0.42,
      base * 0.58
    );
  }

  const base = Math.max(riskBase || neutralBase, 0.25);
  return makePathAdjustment(
    'MILD_DOWN_CURVE',
    '温和下弯',
    -base * 0.2,
    -base * 0.42,
    -base * 0.58
  );
}

function interpolateLiquidityAdjustment(day, adjustmentByDayPct = {}) {
  const targetDay = Number(day);

  if (!Number.isFinite(targetDay) || targetDay <= 0) {
    return 0;
  }

  const d5 = safeNumber(adjustmentByDayPct[5]) || 0;
  const d10 = safeNumber(adjustmentByDayPct[10]) || 0;
  const d20 = safeNumber(adjustmentByDayPct[20]) || 0;

  if (targetDay <= 5) {
    return roundNumber(d5 * targetDay / 5, 2);
  }

  if (targetDay <= 10) {
    return roundNumber(d5 + (d10 - d5) * (targetDay - 5) / 5, 2);
  }

  if (targetDay <= 20) {
    return roundNumber(d10 + (d20 - d10) * (targetDay - 10) / 10, 2);
  }

  return roundNumber(d20, 2);
}

function addLiquidityAdjustment(value, adjustment, scale = 1) {
  const number = safeNumber(value);
  const delta = safeNumber(adjustment);

  if (number === null || delta === null) {
    return value;
  }

  return roundNumber(number + delta * scale, 2);
}

function applyLiquidityAdjustmentToFuturePathStats(futurePathStats, liquidityAnalysis) {
  const rows = Array.isArray(futurePathStats) ? futurePathStats : [];

  if (!liquidityAnalysis || !liquidityAnalysis.ok) {
    return rows.map((row) => ({ ...row }));
  }

  const adjustmentByDayPct = liquidityAnalysis.adjustmentByDayPct || {};
  const shape = liquidityAnalysis.pathShape || '';
  const shapeLabel = liquidityAnalysis.pathShapeLabel || '';

  return rows.map((row) => {
    const day = Number(row && row.day);
    const adjustment = interpolateLiquidityAdjustment(day, adjustmentByDayPct);
    const probabilityDelta = clamp(adjustment * 3.2, -12, 12);
    const positiveRate = safeNumber(row && row.positiveRatePct);

    return {
      ...row,
      baselineAverageReturnPct: row.averageReturnPct,
      baselineMedianReturnPct: row.medianReturnPct,
      baselineLowerQuartileReturnPct: row.lowerQuartileReturnPct,
      baselineUpperQuartileReturnPct: row.upperQuartileReturnPct,
      baselineMinReturnPct: row.minReturnPct,
      baselineMaxReturnPct: row.maxReturnPct,
      baselinePositiveRatePct: row.positiveRatePct,
      liquidityAdjustmentPct: adjustment,
      liquidityPathShape: shape,
      liquidityPathShapeLabel: shapeLabel,
      averageReturnPct: addLiquidityAdjustment(row.averageReturnPct, adjustment, 0.82),
      medianReturnPct: addLiquidityAdjustment(row.medianReturnPct, adjustment, 1),
      lowerQuartileReturnPct: addLiquidityAdjustment(row.lowerQuartileReturnPct, adjustment, 0.72),
      upperQuartileReturnPct: addLiquidityAdjustment(row.upperQuartileReturnPct, adjustment, 0.88),
      minReturnPct: addLiquidityAdjustment(row.minReturnPct, adjustment, 0.48),
      maxReturnPct: addLiquidityAdjustment(row.maxReturnPct, adjustment, 0.7),
      positiveRatePct: positiveRate === null
        ? row.positiveRatePct
        : roundNumber(clamp(positiveRate + probabilityDelta, 0, 100), 2)
    };
  });
}

function buildLiquidityFactorAnalysisFromBars(options = {}) {
  const symbol = String(options.symbol || '').trim();
  const market = String(options.market || '').trim();
  const bars = Array.isArray(options.bars) ? options.bars : [];
  const clickedIndex = Number(options.clickedIndex);
  const currentState = options.currentState || null;

  if (!isAshareSymbol(symbol, market)) {
    return {
      version: LIQUIDITY_FACTOR_VERSION,
      ok: false,
      reason: 'A_SHARE_ONLY',
      score: 0,
      adjustmentByDayPct: { 5: 0, 10: 0, 20: 0 },
      signals: []
    };
  }

  if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex >= bars.length) {
    return {
      version: LIQUIDITY_FACTOR_VERSION,
      ok: false,
      reason: 'INVALID_CLICKED_INDEX',
      score: 0,
      adjustmentByDayPct: { 5: 0, 10: 0, 20: 0 },
      signals: []
    };
  }

  const currentBar = bars[clickedIndex] || {};
  const before20 = sliceBeforeOnly(bars, clickedIndex, 20);
  const window5 = sliceBeforeAndAt(bars, clickedIndex, 5);
  const window20 = sliceBeforeAndAt(bars, clickedIndex, 20);
  const historyRows = bars.slice(0, clickedIndex + 1);

  const current = {
    date: currentBar.date || currentBar.trade_date || '',
    close: roundNumber(getBarNumber(currentBar, 'close'), 4),
    volume: roundNumber(getBarNumber(currentBar, 'volume'), 4),
    amount: roundNumber(getBarNumber(currentBar, 'amount'), 4),
    amplitude: roundNumber(getBarNumber(currentBar, 'amplitude'), 4),
    pctChange: roundNumber(getBarNumber(currentBar, 'pctChange'), 4),
    changeAmount: roundNumber(getBarNumber(currentBar, 'changeAmount'), 4),
    turnover: roundNumber(getBarNumber(currentBar, 'turnover'), 4)
  };

  const averages = {
    preVolume20: average(valuesOf(before20, 'volume')),
    preAmount20: average(valuesOf(before20, 'amount')),
    preAmplitude20: average(valuesOf(before20, 'amplitude')),
    preTurnover20: average(valuesOf(before20, 'turnover')),
    volume5: average(valuesOf(window5, 'volume')),
    volume20: average(valuesOf(window20, 'volume')),
    amount5: average(valuesOf(window5, 'amount')),
    amount20: average(valuesOf(window20, 'amount')),
    amplitude5: average(valuesOf(window5, 'amplitude')),
    amplitude20: average(valuesOf(window20, 'amplitude')),
    turnover5: average(valuesOf(window5, 'turnover')),
    turnover20: average(valuesOf(window20, 'turnover'))
  };

  const ratios = {
    volumeT0To20: roundNumber(ratio(current.volume, averages.preVolume20), 4),
    amountT0To20: roundNumber(ratio(current.amount, averages.preAmount20), 4),
    amplitudeT0To20: roundNumber(ratio(current.amplitude, averages.preAmplitude20), 4),
    turnoverT0To20: roundNumber(ratio(current.turnover, averages.preTurnover20), 4),
    volume5To20: roundNumber(ratio(averages.volume5, averages.volume20), 4),
    amount5To20: roundNumber(ratio(averages.amount5, averages.amount20), 4),
    amplitude5To20: roundNumber(ratio(averages.amplitude5, averages.amplitude20), 4),
    turnover5To20: roundNumber(ratio(averages.turnover5, averages.turnover20), 4)
  };

  const positionType = getCurrentStateType(currentState, 'position');
  const shapeType = getCurrentStateType(currentState, 'shape');
  const changeType = getCurrentStateType(currentState, 'change');

  const amountRatio = ratios.amountT0To20;
  const volumeRatio = ratios.volumeT0To20;
  const amplitudeRatio = ratios.amplitudeT0To20;
  const turnoverRatio = ratios.turnoverT0To20;
  const amountTrendRatio = ratios.amount5To20;
  const volumeTrendRatio = ratios.volume5To20;
  const amplitudeTrendRatio = ratios.amplitude5To20;
  const pctChange = current.pctChange;

  let score = 0;
  let supportScore = 0;
  let riskScore = 0;
  const signals = [];

  const addSignal = (type, label, reason, contribution, details = {}) => {
    const value = roundNumber(contribution, 3);

    signals.push({
      type,
      label,
      reason,
      contribution: value,
      scoreBefore: roundNumber(score, 3),
      scoreAfter: roundNumber(score + value, 3),
      details
    });

    score += value;

    if (value > 0) {
      supportScore += value;
    } else if (value < 0) {
      riskScore += Math.abs(value);
    }
  };

  if (amountRatio !== null && amountRatio >= 1.8 && pctChange !== null && pctChange >= 1.2) {
    addSignal('support', 'AMOUNT_PRICE_CONFIRM', '成交额放大并且价格同步上行', 1.1, { amountRatio, pctChange });
  }

  if (volumeRatio !== null && volumeRatio >= 1.6 && pctChange !== null && pctChange >= 1) {
    addSignal('support', 'VOLUME_PRICE_CONFIRM', '成交量放大并且价格同步上行', 0.8, { volumeRatio, pctChange });
  }

  if (turnoverRatio !== null && turnoverRatio >= 1.5 && pctChange !== null && pctChange >= 1) {
    addSignal('support', 'TURNOVER_PRICE_CONFIRM', '换手率抬升并且价格同步上行', 0.65, { turnoverRatio, pctChange });
  }

  if (amountTrendRatio !== null && amountTrendRatio >= 1.25 && volumeTrendRatio !== null && volumeTrendRatio >= 1.15) {
    addSignal('support', 'RECENT_LIQUIDITY_WARMING', '近 5 日成交额和成交量高于近 20 日均值', 0.55, { amountTrendRatio, volumeTrendRatio });
  }

  if (positionType === 'LOW_AREA' && amountTrendRatio !== null && amountTrendRatio >= 1.15 && pctChange !== null && pctChange < 5) {
    addSignal('support', 'LOW_AREA_GENTLE_AMOUNT_EXPANSION', '低位温和放量，且 T0 未过热', 0.55, { positionType, amountTrendRatio, pctChange });
  }

  if (positionType === 'MID_AREA' && changeType === 'STRENGTHENING' && amountRatio !== null && amountRatio >= 1.25) {
    addSignal('support', 'MID_AREA_STRENGTH_WITH_AMOUNT', '中位转强并有成交额确认', 0.45, { positionType, changeType, amountRatio });
  }

  if (pctChange !== null && pctChange < 0 && amountRatio !== null && amountRatio <= 0.78 && amplitudeRatio !== null && amplitudeRatio <= 1.05) {
    addSignal('support', 'SHRINK_PULLBACK', '回落时成交额未放大，振幅未扩张', 0.35, { pctChange, amountRatio, amplitudeRatio });
  }

  if (positionType === 'HIGH_AREA' && amountRatio !== null && amountRatio >= 1.7 && pctChange !== null && pctChange < 2.2) {
    addSignal('risk', 'HIGH_AREA_AMOUNT_STALL', '高位放量但价格跟随不足', -1.25, { positionType, amountRatio, pctChange });
  }

  if (pctChange !== null && pctChange <= -3 && amountRatio !== null && amountRatio >= 1.5) {
    addSignal('risk', 'SELLING_AMOUNT_RELEASE', '下跌日成交额放大', -1.05, { pctChange, amountRatio });
  }

  if (pctChange !== null && pctChange <= -3 && turnoverRatio !== null && turnoverRatio >= 1.5) {
    addSignal('risk', 'TURNOVER_PANIC_RELEASE', '下跌日换手率明显放大', -0.85, { pctChange, turnoverRatio });
  }

  if (amplitudeRatio !== null && amplitudeRatio >= 1.4 && pctChange !== null && pctChange < 0.8) {
    addSignal('risk', 'WIDE_AMPLITUDE_NO_PRICE_CONFIRM', '振幅扩张但价格没有同步确认', -0.7, { amplitudeRatio, pctChange });
  }

  if (amplitudeTrendRatio !== null && amplitudeTrendRatio >= 1.3 && amountTrendRatio !== null && amountTrendRatio >= 1.2 && pctChange !== null && pctChange < 1) {
    addSignal('risk', 'RECENT_WIDE_SWING_WITH_AMOUNT', '近 5 日振幅和成交额同步放大但涨幅不足', -0.65, { amplitudeTrendRatio, amountTrendRatio, pctChange });
  }

  if (shapeType === 'HIGH_WAVE_RISK' && amountRatio !== null && amountRatio >= 1.2) {
    addSignal('risk', 'HIGH_WAVE_WITH_AMOUNT', '冲高回落风险形态叠加成交额放大', -0.6, { shapeType, amountRatio });
  }

  const normalizedScore = roundNumber(clamp(score, -4, 4), 3);
  const normalizedSupportScore = roundNumber(supportScore, 3);
  const normalizedRiskScore = roundNumber(riskScore, 3);
  const regime = getLiquidityRegime(normalizedScore, normalizedSupportScore, normalizedRiskScore);
  const confidence = roundNumber(clamp(signals.length / 5, 0.18, 0.92), 3);
  const rawPathAdjustment = buildLiquidityPathAdjustment({
        regime,
        signals,
        score: normalizedScore,
        supportScore: normalizedSupportScore,
        riskScore: normalizedRiskScore
        });

  const pathAdjustment = applyLiquidityValidationGate(rawPathAdjustment, regime);

  return {
    version: LIQUIDITY_FACTOR_VERSION,
    ok: true,
    market: 'CN_A',
    symbol,
    clickedDate: current.date,
    fieldCoverage: getFieldCoverage(historyRows),
    current,
    averages: Object.fromEntries(
      Object.entries(averages).map(([key, value]) => [key, roundNumber(value, 4)])
    ),
    ratios,
    stateHints: {
      positionType,
      shapeType,
      changeType
    },
    score: normalizedScore,
    supportScore: normalizedSupportScore,
    riskScore: normalizedRiskScore,
    regime,
    regimeLabel: getLiquidityRegimeLabel(regime),
    confidence,
    pathShape: pathAdjustment.shape,
    pathShapeLabel: pathAdjustment.shapeLabel,
    adjustmentByDayPct: {
      5: pathAdjustment.d5,
      10: pathAdjustment.d10,
      20: pathAdjustment.d20
    },
    signals,
    summaryText: `${getLiquidityRegimeLabel(regime)}｜${pathAdjustment.shapeLabel}｜分 ${normalizedScore}｜T+5/T+10/T+20 校正 ${pathAdjustment.d5}%/${pathAdjustment.d10}%/${pathAdjustment.d20}%｜信号 ${signals.length}`
  };
}

function getHorizonForKey(horizonSummary, key) {
  return horizonSummary && horizonSummary[key]
    ? horizonSummary[key]
    : {
      day: key === 'd5' ? 5 : key === 'd10' ? 10 : 20,
      sampleCount: 0,
      upProbabilityPct: null,
      averageReturnPct: null,
      medianReturnPct: null,
      lowerQuartileReturnPct: null,
      upperQuartileReturnPct: null,
      maxAdverseReturnPct: null,
      maxFavorableReturnPct: null
    };
}

function adjustHorizon(horizon, adjustmentPct) {
  const adjustment = safeNumber(adjustmentPct);

  if (adjustment === null || !horizon) {
    return horizon;
  }

  const adjustValue = (value, scale = 1) => {
    const number = safeNumber(value);
    return number === null ? null : roundNumber(number + adjustment * scale, 2);
  };

  const upProbability = safeNumber(horizon.upProbabilityPct);
  const probabilityDelta = clamp(adjustment * 3.2, -12, 12);

  return {
    ...horizon,
    liquidityAdjustmentPct: roundNumber(adjustment, 2),
    medianReturnPct: adjustValue(horizon.medianReturnPct, 1),
    averageReturnPct: adjustValue(horizon.averageReturnPct, 0.82),
    lowerQuartileReturnPct: adjustValue(horizon.lowerQuartileReturnPct, 0.72),
    upperQuartileReturnPct: adjustValue(horizon.upperQuartileReturnPct, 0.88),
    maxAdverseReturnPct: adjustValue(horizon.maxAdverseReturnPct, 0.48),
    maxFavorableReturnPct: adjustValue(horizon.maxFavorableReturnPct, 0.7),
    upProbabilityPct: upProbability === null
      ? null
      : roundNumber(clamp(upProbability + probabilityDelta, 0, 100), 2)
  };
}

function buildLiquidityEnhancedPrediction(options = {}) {
  const horizonSummary = options.horizonSummary || {};
  const liquidityAnalysis = options.liquidityAnalysis || null;

  if (!liquidityAnalysis || !liquidityAnalysis.ok) {
    return {
      version: LIQUIDITY_FACTOR_VERSION,
      ok: false,
      reason: liquidityAnalysis && liquidityAnalysis.reason ? liquidityAnalysis.reason : 'NO_LIQUIDITY_ANALYSIS',
      horizonSummary: {
        d5: getHorizonForKey(horizonSummary, 'd5'),
        d10: getHorizonForKey(horizonSummary, 'd10'),
        d20: getHorizonForKey(horizonSummary, 'd20')
      }
    };
  }

  return {
    version: LIQUIDITY_FACTOR_VERSION,
    ok: true,
    source: 'baseline_horizon_plus_a_share_liquidity_factor',
    regime: liquidityAnalysis.regime,
    regimeLabel: liquidityAnalysis.regimeLabel,
    score: liquidityAnalysis.score,
    confidence: liquidityAnalysis.confidence,
    adjustmentByDayPct: liquidityAnalysis.adjustmentByDayPct,
    horizonSummary: {
      d5: adjustHorizon(getHorizonForKey(horizonSummary, 'd5'), liquidityAnalysis.adjustmentByDayPct[5]),
      d10: adjustHorizon(getHorizonForKey(horizonSummary, 'd10'), liquidityAnalysis.adjustmentByDayPct[10]),
      d20: adjustHorizon(getHorizonForKey(horizonSummary, 'd20'), liquidityAnalysis.adjustmentByDayPct[20])
    },
    summaryText: liquidityAnalysis.summaryText
  };
}

module.exports = {
  LIQUIDITY_FACTOR_VERSION,
  buildLiquidityFactorAnalysisFromBars,
  buildLiquidityEnhancedPrediction,
  applyLiquidityAdjustmentToFuturePathStats
};