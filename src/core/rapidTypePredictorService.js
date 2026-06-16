const RAPID_TYPE_PREDICTOR_VERSION = 'rapid-type-predictor-v1.0.0';

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 2) {
  const number = toNumber(value);

  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '-';
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text;
}

function getClose(bar) {
  return toNumber(bar && bar.close);
}

function average(values) {
  const nums = values
    .map((value) => toNumber(value))
    .filter(Number.isFinite);

  if (!nums.length) {
    return null;
  }

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function getReturnPct(bars, fromIndex, toIndex) {
  if (!Array.isArray(bars)) {
    return null;
  }

  const fromClose = getClose(bars[fromIndex]);
  const toClose = getClose(bars[toIndex]);

  if (!Number.isFinite(fromClose) || !Number.isFinite(toClose) || fromClose <= 0) {
    return null;
  }

  return (toClose / fromClose - 1) * 100;
}

function getPastReturnPct(bars, index, lookback) {
  const offset = Number(lookback);

  if (!Array.isArray(bars) || !Number.isInteger(index) || index - offset < 0) {
    return null;
  }

  return getReturnPct(bars, index - offset, index);
}

function averageClose(bars, endIndex, days) {
  if (!Array.isArray(bars) || !Number.isInteger(endIndex)) {
    return null;
  }

  const startIndex = Math.max(0, endIndex - days + 1);
  const closes = [];

  for (let i = startIndex; i <= endIndex; i += 1) {
    closes.push(getClose(bars[i]));
  }

  return average(closes);
}

function getRangePositionPct(bars, index, days) {
  if (!Array.isArray(bars) || !Number.isInteger(index)) {
    return null;
  }

  const startIndex = Math.max(0, index - days + 1);
  const closes = [];

  for (let i = startIndex; i <= index; i += 1) {
    const close = getClose(bars[i]);

    if (Number.isFinite(close)) {
      closes.push(close);
    }
  }

  if (closes.length < 2) {
    return null;
  }

  const currentClose = getClose(bars[index]);
  const minClose = Math.min(...closes);
  const maxClose = Math.max(...closes);
  const range = maxClose - minClose;

  if (!Number.isFinite(currentClose) || range <= 0) {
    return null;
  }

  return (currentClose - minClose) / range * 100;
}

function getVolatilityPct(bars, index, days) {
  if (!Array.isArray(bars) || !Number.isInteger(index)) {
    return null;
  }

  const returns = [];
  const startIndex = Math.max(1, index - days + 1);

  for (let i = startIndex; i <= index; i += 1) {
    const value = getReturnPct(bars, i - 1, i);

    if (Number.isFinite(value)) {
      returns.push(value);
    }
  }

  if (returns.length < 2) {
    return null;
  }

  const avg = average(returns);
  const variance = average(returns.map((value) => Math.pow(value - avg, 2)));

  return Number.isFinite(variance) ? Math.sqrt(variance) : null;
}

function bucketSignedPct(value, weak = 1, strong = 3) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return 'NA';
  }

  if (number >= strong) {
    return 'STRONG_UP';
  }

  if (number >= weak) {
    return 'UP';
  }

  if (number <= -strong) {
    return 'STRONG_DOWN';
  }

  if (number <= -weak) {
    return 'DOWN';
  }

  return 'FLAT';
}

function bucketRangePosition(value) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return 'NA';
  }

  if (number >= 80) {
    return 'HIGH_80';
  }

  if (number >= 60) {
    return 'MID_HIGH_60';
  }

  if (number >= 40) {
    return 'MID_40';
  }

  if (number >= 20) {
    return 'MID_LOW_20';
  }

  return 'LOW_20';
}

function bucketVolatility(value) {
  const number = toNumber(value);

  if (!Number.isFinite(number)) {
    return 'NA';
  }

  if (number >= 5) {
    return 'VOL_HIGH';
  }

  if (number >= 2.5) {
    return 'VOL_MID';
  }

  return 'VOL_LOW';
}

function getStateFeature(state, path, fallback = '') {
  const parts = String(path || '').split('.');
  let current = state;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return fallback;
    }

    current = current[part];
  }

  return current === undefined || current === null || current === ''
    ? fallback
    : String(current);
}

function buildRapidTypePredictorFeatures(options) {
  const input = options || {};
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const clickedIndex = Number(input.clickedIndex);
  const currentState = input.currentState || {};
  const clickedBar = Number.isInteger(clickedIndex) ? bars[clickedIndex] : null;

  const close = getClose(clickedBar);
  const ma5 = averageClose(bars, clickedIndex, 5);
  const ma20 = averageClose(bars, clickedIndex, 20);
  const ma60 = averageClose(bars, clickedIndex, 60);

  const ret3Pct = getPastReturnPct(bars, clickedIndex, 3);
  const ret5Pct = getPastReturnPct(bars, clickedIndex, 5);
  const ret10Pct = getPastReturnPct(bars, clickedIndex, 10);
  const ret20Pct = getPastReturnPct(bars, clickedIndex, 20);

  const rangePosition20Pct = getRangePositionPct(bars, clickedIndex, 20);
  const rangePosition60Pct = getRangePositionPct(bars, clickedIndex, 60);
  const volatility20Pct = getVolatilityPct(bars, clickedIndex, 20);

  const aboveMa5 = Number.isFinite(close) && Number.isFinite(ma5) ? close >= ma5 : null;
  const aboveMa20 = Number.isFinite(close) && Number.isFinite(ma20) ? close >= ma20 : null;
  const aboveMa60 = Number.isFinite(close) && Number.isFinite(ma60) ? close >= ma60 : null;

  const shapeType = getStateFeature(currentState, 'shape.type', 'UNKNOWN_SHAPE');
  const positionType = getStateFeature(currentState, 'position.type', 'UNKNOWN_POSITION');
  const changeType = getStateFeature(currentState, 'change.type', 'UNKNOWN_CHANGE');
  const stateCode = getStateFeature(currentState, 'stateCode', 'UNKNOWN_STATE');

  return {
    date: normalizeDate(clickedBar && clickedBar.date),
    close,

    stateCode,
    shapeType,
    positionType,
    changeType,

    ret3Pct,
    ret5Pct,
    ret10Pct,
    ret20Pct,

    rangePosition20Pct,
    rangePosition60Pct,
    volatility20Pct,

    ret3Bucket: bucketSignedPct(ret3Pct, 1, 3),
    ret5Bucket: bucketSignedPct(ret5Pct, 2, 5),
    ret10Bucket: bucketSignedPct(ret10Pct, 3, 8),
    ret20Bucket: bucketSignedPct(ret20Pct, 5, 12),
    rangePosition20Bucket: bucketRangePosition(rangePosition20Pct),
    rangePosition60Bucket: bucketRangePosition(rangePosition60Pct),
    volatility20Bucket: bucketVolatility(volatility20Pct),

    aboveMa5,
    aboveMa20,
    aboveMa60,

    aboveMaCombo: [
      aboveMa5 === true ? 'MA5_UP' : 'MA5_DOWN',
      aboveMa20 === true ? 'MA20_UP' : 'MA20_DOWN',
      aboveMa60 === true ? 'MA60_UP' : 'MA60_DOWN'
    ].join('+')
  };
}

function makePrediction(type, title, signal, confidence, sampleCount, avgD20Pct, reasonParts, features) {
  const safeConfidence = Math.max(0, Math.min(1, Number(confidence || 0)));

  const prediction = {
    version: RAPID_TYPE_PREDICTOR_VERSION,
    ok: true,
    predictedRapidGroup: type,
    predictedRapidTitle: title,
    predictedSignal: signal,
    confidence: safeConfidence,
    confidenceText: safeConfidence >= 0.65
      ? '较高'
      : safeConfidence >= 0.5
        ? '中等'
        : safeConfidence >= 0.35
          ? '偏低'
          : '很低',
    referenceSampleCount: sampleCount,
    referenceAvgD20Pct: avgD20Pct,
    reasonParts: reasonParts.filter(Boolean),
    features
  };

  return {
    ...prediction,
    summaryText: buildRapidTypePredictionSummary(prediction)
  };
}

function buildRapidTypePredictionSummary(prediction) {
  if (!prediction || !prediction.ok) {
    return '急变倾向：暂无足够前置特征。';
  }

  const reason = Array.isArray(prediction.reasonParts) && prediction.reasonParts.length
    ? prediction.reasonParts.join('；')
    : '前置特征分歧较大';

  return [
    `急变倾向：${prediction.predictedRapidTitle}`,
    `置信度：${prediction.confidenceText}`,
    `参考样本：${prediction.referenceSampleCount}`,
    `同类D20均值：${formatPct(prediction.referenceAvgD20Pct)}`,
    `依据：${reason}`
  ].join('｜');
}

function predictRapidTypeFromFeatures(features) {
  const f = features || {};

  const stateCode = String(f.stateCode || '');
  const shapeType = String(f.shapeType || '');
  const positionType = String(f.positionType || '');
  const changeType = String(f.changeType || '');
  const ret5Bucket = String(f.ret5Bucket || '');
  const ret20Bucket = String(f.ret20Bucket || '');
  const range20 = String(f.rangePosition20Bucket || '');
  const maCombo = String(f.aboveMaCombo || '');
  const volBucket = String(f.volatility20Bucket || '');

  const ret5 = toNumber(f.ret5Pct);
  const ret10 = toNumber(f.ret10Pct);
  const ret20 = toNumber(f.ret20Pct);
  const rangePosition20 = toNumber(f.rangePosition20Pct);

  const isAllMaUp = maCombo === 'MA5_UP+MA20_UP+MA60_UP';
  const isAllMaDown = maCombo === 'MA5_DOWN+MA20_DOWN+MA60_DOWN';

  if (
    stateCode === 'HIGH_CHASE_RISK'
    && shapeType === 'MA_TURN_STRONG'
    && positionType === 'HIGH_CHASE_RISK'
    && changeType === 'STRENGTHENING'
    && ret5Bucket === 'STRONG_UP'
    && range20 === 'HIGH_80'
    && isAllMaUp
  ) {
    return makePrediction(
      'EXTEND_UP',
      '偏急启延续',
      'trend',
      volBucket === 'VOL_MID' ? 0.56 : 0.50,
      volBucket === 'VOL_MID' ? 22 : 12,
      volBucket === 'VOL_MID' ? 18.57 : 3.79,
      [
        '高位强势',
        '均线转强',
        '近5日强涨',
        '20日区间高位',
        '多头均线排列'
      ],
      f
    );
  }

  if (
    stateCode === 'LOW_WEAK_OBSERVE'
    && positionType === 'LOW_AREA'
    && changeType === 'WEAKENING'
    && ret5Bucket === 'STRONG_DOWN'
    && range20 === 'LOW_20'
    && isAllMaDown
  ) {
    return makePrediction(
      'EXTEND_UP',
      '低位修复倾向',
      'trend',
      0.45,
      21,
      6.90,
      [
        '低位弱势后强跌',
        '20日区间低位',
        '空头均线排列',
        '历史同类更偏修复向上，但分歧仍大'
      ],
      f
    );
  }

  if (
    stateCode === 'HIGH_CHASE_RISK'
    && positionType === 'HIGH_CHASE_RISK'
    && changeType === 'STRENGTHENING'
    && ret5Bucket === 'UP'
    && range20 === 'HIGH_80'
    && isAllMaUp
  ) {
    return makePrediction(
      'MIXED',
      '高位分歧观察',
      'neutral',
      0.30,
      600,
      3.17,
      [
        '高位追涨区',
        '继续强化但近端动能不够强',
        '该结构既可能延续也可能兑现，暂不硬判'
      ],
      f
    );
  }

  if (
    Number.isFinite(ret5)
    && Number.isFinite(ret10)
    && Number.isFinite(ret20)
    && ret5 >= 2
    && ret10 >= 5
    && ret20 >= 7
    && Number.isFinite(rangePosition20)
    && rangePosition20 >= 55
  ) {
    return makePrediction(
      'MIXED',
      '连续上涨后的分歧观察',
      'neutral',
      0.30,
      600,
      3.17,
      [
        'T0前已连续上涨',
        '20日涨幅较高',
        '位置不低',
        '但价格特征不足以区分延续与急杀'
      ],
      f
    );
  }

  if (
    changeType === 'STRENGTHENING'
    && isAllMaUp
    && range20 === 'HIGH_80'
    && (ret5Bucket === 'STRONG_UP' || ret5Bucket === 'UP')
  ) {
    return makePrediction(
      'EXTEND_UP',
      '偏趋势延续',
      'trend',
      0.42,
      174,
      7.25,
      [
        '强化状态',
        '20日区间高位',
        '多头均线',
        '历史高位样本仍偏延续'
      ],
      f
    );
  }

  if (
    isAllMaDown
    && (range20 === 'LOW_20' || range20 === 'MID_LOW_20')
    && (ret5Bucket === 'DOWN' || ret5Bucket === 'STRONG_DOWN')
  ) {
    return makePrediction(
      'MIXED',
      '低位弱势分歧',
      'neutral',
      0.30,
      600,
      3.17,
      [
        '空头均线排列',
        '区间低位',
        '近端走弱',
        '但验证中该结构并不能稳定指向继续下跌'
      ],
      f
    );
  }

  if (
    isAllMaUp
    && (
      stateCode === 'PULLBACK_REPAIR'
      || shapeType === 'HIGH_WAVE_RISK'
      || changeType === 'PULLBACK_STABLE'
    )
    && (
      positionType === 'HIGH_AREA'
      || positionType === 'HIGH_CHASE_RISK'
    )
    && (
      range20 === 'MID_HIGH_60'
      || range20 === 'HIGH_80'
    )
    && (
      ret5Bucket === 'DOWN'
      || ret5Bucket === 'STRONG_DOWN'
      || ret5 < 0
    )
    && (
      ret20Bucket === 'UP'
      || ret20Bucket === 'STRONG_UP'
      || ret20 > 3
    )
  ) {
    return makePrediction(
      'SHORT_WINDOW_DECAY',
      '高位回撤后的短窗兑现',
      'short_window',
      0.46,
      85,
      -5.88,
      [
        '中期仍处高位多头',
        '近5日已经回撤',
        '形态属于高位宽波动/回踩修复',
        '同类短窗衰减组D20偏弱'
      ],
      f
    );
  }

  if (
    Number.isFinite(ret5)
    && Number.isFinite(ret10)
    && ret5 <= 0
    && ret10 <= 1
    && range20 !== 'HIGH_80'
  ) {
    return makePrediction(
      'MIXED',
      '近端弱势分歧',
      'neutral',
      0.30,
      600,
      3.17,
      [
        '近端动能不足',
        '不在强高位',
        '但价格特征不足以确认短窗衰减'
      ],
      f
    );
  }

  return makePrediction(
    'MIXED',
    '混合分歧',
    'neutral',
    0.30,
    600,
    3.17,
    [
      '前置特征未命中强规则',
      '按总体样本仅作低置信度参考'
    ],
    f
  );
}

function buildRapidTypePredictionFromBars(options) {
  const input = options || {};
  const features = buildRapidTypePredictorFeatures({
    bars: input.bars,
    clickedIndex: input.clickedIndex,
    currentState: input.currentState
  });

  return predictRapidTypeFromFeatures(features);
}

module.exports = {
  RAPID_TYPE_PREDICTOR_VERSION,
  toNumber,
  formatPct,
  buildRapidTypePredictorFeatures,
  predictRapidTypeFromFeatures,
  buildRapidTypePredictionFromBars
};