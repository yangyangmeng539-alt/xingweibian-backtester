const {
  getDailyBarsForMarket,
  normalizeMarketSymbol
} = require('../data/dailyBarDataService');
const { classifyXwbStates } = require('./xwbStateClassifier');
const { buildStateStats } = require('./xwbStateStatsEngine');
const { buildPredictionAnalysis, XWB_PREDICTION_VERSION } = require('./xwbPredictionEngine');
const { buildNodePredictionAnalysis, XWB_NODE_PREDICTION_VERSION } = require('./xwbNodePredictionEngine');
const {
  buildHkLiquidityBendAnalysisFromBars
} = require('./hkLiquidityBendFactorService');

const DEFAULT_PREDICTION_OPTIONS = {
  clickedDate: '',
  forecastDays: 20,
  maxSamples: 160
};

const PREDICTION_WARNING = '预判结果仅用于历史同构结构对照，不构成买卖建议。';

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function getPositiveInteger(value, fallback) {
  if (isMissing(value)) {
    return fallback;
  }

  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function normalizePredictionOptions(options) {
  const raw = options || {};

  return {
    clickedDate: isMissing(raw.clickedDate) ? DEFAULT_PREDICTION_OPTIONS.clickedDate : String(raw.clickedDate),
    forecastDays: getPositiveInteger(raw.forecastDays, DEFAULT_PREDICTION_OPTIONS.forecastDays),
    maxSamples: getPositiveInteger(raw.maxSamples, DEFAULT_PREDICTION_OPTIONS.maxSamples)
  };
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

function cleanBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => {
      const source = bar || {};

      return {
        ...source,
        date: source.date || source.trade_date,
        open: Number(source.open),
        close: Number(source.close),
        high: Number(source.high),
        low: Number(source.low),
        volume: toOptionalNumber(source.volume),
        amount: toOptionalNumber(source.amount),
        amplitude: toOptionalNumber(source.amplitude),
        pctChange: toOptionalNumber(
          source.pctChange !== undefined ? source.pctChange : source.pct_change
        ),
        changeAmount: toOptionalNumber(
          source.changeAmount !== undefined ? source.changeAmount : source.change_amount
        ),
        turnover: toOptionalNumber(source.turnover)
      };
    })
    .filter((bar) => {
      return (
        bar &&
        bar.date &&
        Number.isFinite(bar.open) &&
        Number.isFinite(bar.close) &&
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        bar.open > 0 &&
        bar.close > 0 &&
        bar.high > 0 &&
        bar.low > 0 &&
        bar.volume !== null &&
        Number.isFinite(bar.volume)
      );
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

function buildPriceSeries(bars) {
  return (Array.isArray(bars) ? bars : []).map((bar) => {
    const source = bar || {};

    return {
      date: source.date || source.trade_date,
      open: Number(source.open),
      high: Number(source.high),
      low: Number(source.low),
      close: Number(source.close),

      volume: toOptionalNumber(source.volume),
      amount: toOptionalNumber(source.amount),
      amplitude: toOptionalNumber(source.amplitude),
      pctChange: toOptionalNumber(
        source.pctChange !== undefined ? source.pctChange : source.pct_change
      ),
      changeAmount: toOptionalNumber(
        source.changeAmount !== undefined ? source.changeAmount : source.change_amount
      ),
      turnover: toOptionalNumber(source.turnover)
    };
  });
}

function buildXwbStateAnalysis(bars) {
  const dailyStates = classifyXwbStates(bars);
  const stateStats = buildStateStats(dailyStates);

  return {
    dailyStates,
    stateStats
  };
}

function getClickedDate(bars, options) {
  if (options.clickedDate) {
    return options.clickedDate;
  }

  return bars.length ? bars[bars.length - 1].date : '';
}

function buildWarning(inputWarning) {
  if (!inputWarning) {
    return PREDICTION_WARNING;
  }

  return `${PREDICTION_WARNING} 数据提示：${inputWarning}`;
}

function isHkMarketIdentity(identity) {
  const market = String(identity && identity.market || '').toUpperCase();
  const displaySymbol = String(identity && identity.displaySymbol || '').toUpperCase();
  const cacheSymbol = String(identity && identity.cacheSymbol || '').toUpperCase();

  return market === 'HK'
    || displaySymbol.startsWith('HK:')
    || cacheSymbol.endsWith('.HK')
    || /^\d{5}\.HK$/.test(cacheSymbol);
}

function attachHkLiquidityBendToNodePrediction(nodePredictionAnalysis, {
  identity,
  bars,
  selectedNodeDate,
  forecastDays
}) {
  if (!isHkMarketIdentity(identity)) {
    return nodePredictionAnalysis;
  }

  const clickedIndex = Array.isArray(bars)
    ? bars.findIndex((bar) => String(bar && bar.date || '') === String(selectedNodeDate || ''))
    : -1;

  if (!Number.isInteger(clickedIndex) || clickedIndex < 0) {
    return {
      ...nodePredictionAnalysis,
      hkLiquidityBendAnalysis: {
        ok: false,
        reason: 'HK_CLICKED_INDEX_NOT_FOUND',
        regime: 'HK_LIQUIDITY_NEUTRAL',
        bendByDayPct: {}
      }
    };
  }

  const hkLiquidityBendAnalysis = buildHkLiquidityBendAnalysisFromBars({
    symbol: identity.displaySymbol || identity.cacheSymbol || '',
    bars,
    clickedIndex,
    forecastDays
  });

  return {
    ...nodePredictionAnalysis,
    hkLiquidityBendAnalysis
  };
}

function runModelsOnBars(input, options) {
  const safeInput = Array.isArray(input)
    ? { ...(options || {}), bars: input }
    : (input || {});
  const bars = cleanBars(safeInput.bars);
  const identity = normalizeMarketSymbol(safeInput.displaySymbol || safeInput.symbol);
  const symbol = identity.displaySymbol;
  const predictionOptions = normalizePredictionOptions({
    ...(safeInput.options || {}),
    ...(options || {})
  });

  if (bars.length < 140) {
    throw new Error(`历史日线数量不足，当前只有 ${bars.length} 条，至少需要 140 条。`);
  }

  const xwbStateAnalysis = buildXwbStateAnalysis(bars);
  const predictionAnalysis = buildPredictionAnalysis(
    xwbStateAnalysis.dailyStates,
    xwbStateAnalysis.stateStats
  );
  const selectedNodeDate = getClickedDate(bars, predictionOptions);
  const baseNodePredictionAnalysis = buildNodePredictionAnalysis({
    symbol,
    market: identity.market,
    bars,
    dailyStates: xwbStateAnalysis.dailyStates,
    clickedDate: selectedNodeDate,
    forecastDays: predictionOptions.forecastDays,
    maxSamples: predictionOptions.maxSamples
  });

  const nodePredictionAnalysis = attachHkLiquidityBendToNodePrediction(baseNodePredictionAnalysis, {
    identity,
    bars,
    selectedNodeDate,
    forecastDays: predictionOptions.forecastDays
  });

  return {
    symbol,
    market: identity.market,
    displaySymbol: identity.displaySymbol,
    cacheSymbol: identity.cacheSymbol,
    currency: identity.currency,
    exchange: identity.exchange,
    barStart: bars[0].date,
    barEnd: bars[bars.length - 1].date,
    barCount: bars.length,
    source: safeInput.source || '',
    cachePath: safeInput.cachePath || '',
    warning: buildWarning(safeInput.warning),
    priceSeries: buildPriceSeries(bars),
    options: predictionOptions,
    selectedNodeDate,
    algoVersion: XWB_PREDICTION_VERSION,
    xwbStateAnalysis,
    predictionAnalysis,
    nodePredictionAnalysis,
    predictionVersion: XWB_PREDICTION_VERSION,
    nodePredictionVersion: XWB_NODE_PREDICTION_VERSION,
    debugTradingModels: {
      enabled: false,
      models: []
    }
  };
}

async function runBacktestForSymbol(payload) {
  const input = payload || {};
  const identity = normalizeMarketSymbol(input.symbol);
  const predictionOptions = normalizePredictionOptions(input);
  const dataResult = await getDailyBarsForMarket({
    symbol: identity.displaySymbol,
    startDate: input.startDate || (identity.market === 'HK' ? '19700101' : '20180101'),
    endDate: input.endDate || '',
    refresh: Boolean(input.refresh),
    cacheOnly: Boolean(input.cacheOnly),
    sourceMode: input.sourceMode || '',
    adjust: input.adjust || 'qfq'
  });

  return runModelsOnBars({
    symbol: dataResult.displaySymbol || identity.displaySymbol,
    market: dataResult.market || identity.market,
    displaySymbol: dataResult.displaySymbol || identity.displaySymbol,
    cacheSymbol: dataResult.cacheSymbol || identity.cacheSymbol,
    currency: dataResult.currency || identity.currency,
    exchange: dataResult.exchange || identity.exchange,
    bars: dataResult.bars,
    source: dataResult.source,
    cachePath: dataResult.cachePath,
    warning: dataResult.warning
  }, predictionOptions);
}

module.exports = {
  runBacktestForSymbol,
  runModelsOnBars
};
