const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');

const DEFAULT_SYMBOLS = [
  '600519',
  '000858',
  '300750',
  '002594',
  '601318'
];

function parseArgs(argv) {
  const args = {};

  argv.slice(2).forEach((item) => {
    const text = String(item || '').trim();
    const match = text.match(/^--([^=]+)=(.*)$/);

    if (match) {
      args[match[1]] = match[2];
    }
  });

  return args;
}

function normalizeSymbolArg(value) {
  const digits = String(value || '').replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  return digits.padStart(6, '0').slice(-6);
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

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatNumber(value, digits = 2) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return num.toFixed(digits);
}

function formatPct(value, digits = 2) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return '-';
  }

  return `${num.toFixed(digits)}%`;
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

function getDailyStates(backtestResult) {
  return backtestResult
    && backtestResult.xwbStateAnalysis
    && Array.isArray(backtestResult.xwbStateAnalysis.dailyStates)
    ? backtestResult.xwbStateAnalysis.dailyStates
    : [];
}

function buildStateByDate(backtestResult) {
  const map = new Map();

  getDailyStates(backtestResult).forEach((item) => {
    const date = normalizeDate(item && item.date);

    if (date) {
      map.set(date, item);
    }
  });

  return map;
}

function getClose(bars, index) {
  return toNumber(bars[index] && bars[index].close);
}

function getVolume(bars, index) {
  return toNumber(
    bars[index] && (
      bars[index].volume !== undefined
        ? bars[index].volume
        : bars[index].vol
    )
  );
}

function getReturnPct(bars, fromIndex, toIndex) {
  const fromClose = getClose(bars, fromIndex);
  const toClose = getClose(bars, toIndex);

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

function sliceNumbers(values) {
  return values
    .map((value) => toNumber(value))
    .filter(Number.isFinite);
}

function averageClose(bars, endIndex, days) {
  const startIndex = Math.max(0, endIndex - days + 1);
  const closes = [];

  for (let i = startIndex; i <= endIndex; i += 1) {
    closes.push(getClose(bars, i));
  }

  return average(closes);
}

function averageVolume(bars, endIndex, days) {
  const startIndex = Math.max(0, endIndex - days + 1);
  const volumes = [];

  for (let i = startIndex; i <= endIndex; i += 1) {
    volumes.push(getVolume(bars, i));
  }

  return average(volumes);
}

function getRangePositionPct(bars, index, days) {
  const startIndex = Math.max(0, index - days + 1);
  const closes = [];

  for (let i = startIndex; i <= index; i += 1) {
    const close = getClose(bars, i);

    if (Number.isFinite(close)) {
      closes.push(close);
    }
  }

  if (closes.length < 2) {
    return null;
  }

  const currentClose = getClose(bars, index);
  const minClose = Math.min(...closes);
  const maxClose = Math.max(...closes);
  const range = maxClose - minClose;

  if (!Number.isFinite(currentClose) || range <= 0) {
    return null;
  }

  return (currentClose - minClose) / range * 100;
}

function getRangeWidthPct(bars, index, days) {
  const startIndex = Math.max(0, index - days + 1);
  const closes = [];

  for (let i = startIndex; i <= index; i += 1) {
    const close = getClose(bars, i);

    if (Number.isFinite(close)) {
      closes.push(close);
    }
  }

  if (closes.length < 2) {
    return null;
  }

  const currentClose = getClose(bars, index);
  const minClose = Math.min(...closes);
  const maxClose = Math.max(...closes);

  if (!Number.isFinite(currentClose) || currentClose <= 0) {
    return null;
  }

  return (maxClose / minClose - 1) * 100;
}

function getVolatilityPct(bars, index, days) {
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
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return 'NA';
  }

  if (num >= strong) {
    return 'STRONG_UP';
  }

  if (num >= weak) {
    return 'UP';
  }

  if (num <= -strong) {
    return 'STRONG_DOWN';
  }

  if (num <= -weak) {
    return 'DOWN';
  }

  return 'FLAT';
}

function bucketRangePosition(value) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return 'NA';
  }

  if (num >= 80) {
    return 'HIGH_80';
  }

  if (num >= 60) {
    return 'MID_HIGH_60';
  }

  if (num >= 40) {
    return 'MID_40';
  }

  if (num >= 20) {
    return 'MID_LOW_20';
  }

  return 'LOW_20';
}

function bucketVolumeRatio(value) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return 'NA';
  }

  if (num >= 2) {
    return 'VOLUME_SURGE_2X';
  }

  if (num >= 1.3) {
    return 'VOLUME_UP';
  }

  if (num <= 0.7) {
    return 'VOLUME_SHRINK';
  }

  return 'VOLUME_NORMAL';
}

function bucketVolatility(value) {
  const num = toNumber(value);

  if (!Number.isFinite(num)) {
    return 'NA';
  }

  if (num >= 5) {
    return 'VOL_HIGH';
  }

  if (num >= 2.5) {
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

function buildT0Features(symbol, bars, index, stateByDate) {
  const bar = bars[index] || {};
  const date = normalizeDate(bar.date);
  const state = stateByDate.get(date) || {};

  const close = getClose(bars, index);
  const ma5 = averageClose(bars, index, 5);
  const ma20 = averageClose(bars, index, 20);
  const ma60 = averageClose(bars, index, 60);
  const ma5Prev = averageClose(bars, index - 5, 5);
  const ma20Prev = averageClose(bars, index - 5, 20);

  const volume5 = averageVolume(bars, index, 5);
  const volume20 = averageVolume(bars, index, 20);
  const volumeRatio5To20 = Number.isFinite(volume5) && Number.isFinite(volume20) && volume20 > 0
    ? volume5 / volume20
    : null;

  const ret1 = getPastReturnPct(bars, index, 1);
  const ret3 = getPastReturnPct(bars, index, 3);
  const ret5 = getPastReturnPct(bars, index, 5);
  const ret10 = getPastReturnPct(bars, index, 10);
  const ret20 = getPastReturnPct(bars, index, 20);

  const rangePosition20 = getRangePositionPct(bars, index, 20);
  const rangePosition60 = getRangePositionPct(bars, index, 60);
  const rangeWidth20 = getRangeWidthPct(bars, index, 20);
  const volatility10 = getVolatilityPct(bars, index, 10);
  const volatility20 = getVolatilityPct(bars, index, 20);

  const ma5Slope5Pct = Number.isFinite(ma5) && Number.isFinite(ma5Prev) && ma5Prev > 0
    ? (ma5 / ma5Prev - 1) * 100
    : null;

  const ma20Slope5Pct = Number.isFinite(ma20) && Number.isFinite(ma20Prev) && ma20Prev > 0
    ? (ma20 / ma20Prev - 1) * 100
    : null;

  const aboveMa5 = Number.isFinite(close) && Number.isFinite(ma5) ? close >= ma5 : null;
  const aboveMa20 = Number.isFinite(close) && Number.isFinite(ma20) ? close >= ma20 : null;
  const aboveMa60 = Number.isFinite(close) && Number.isFinite(ma60) ? close >= ma60 : null;

  const shapeType = getStateFeature(state, 'shape.type', 'UNKNOWN_SHAPE');
  const positionType = getStateFeature(state, 'position.type', 'UNKNOWN_POSITION');
  const changeType = getStateFeature(state, 'change.type', 'UNKNOWN_CHANGE');
  const stateCode = getStateFeature(state, 'stateCode', 'UNKNOWN_STATE');

  return {
    symbol,
    date,
    index,
    close,

    shapeType,
    positionType,
    changeType,
    stateCode,

    ret1Pct: ret1,
    ret3Pct: ret3,
    ret5Pct: ret5,
    ret10Pct: ret10,
    ret20Pct: ret20,

    ma5,
    ma20,
    ma60,
    ma5Slope5Pct,
    ma20Slope5Pct,

    aboveMa5,
    aboveMa20,
    aboveMa60,

    volumeRatio5To20,
    rangePosition20Pct: rangePosition20,
    rangePosition60Pct: rangePosition60,
    rangeWidth20Pct: rangeWidth20,
    volatility10Pct: volatility10,
    volatility20Pct: volatility20,

    ret3Bucket: bucketSignedPct(ret3, 1, 3),
    ret5Bucket: bucketSignedPct(ret5, 2, 5),
    ret10Bucket: bucketSignedPct(ret10, 3, 8),
    ret20Bucket: bucketSignedPct(ret20, 5, 12),

    ma5SlopeBucket: bucketSignedPct(ma5Slope5Pct, 1, 3),
    ma20SlopeBucket: bucketSignedPct(ma20Slope5Pct, 1, 3),

    rangePosition20Bucket: bucketRangePosition(rangePosition20),
    rangePosition60Bucket: bucketRangePosition(rangePosition60),
    volumeRatioBucket: bucketVolumeRatio(volumeRatio5To20),
    volatility20Bucket: bucketVolatility(volatility20),

    aboveMaCombo: [
      aboveMa5 === true ? 'MA5_UP' : 'MA5_DOWN',
      aboveMa20 === true ? 'MA20_UP' : 'MA20_DOWN',
      aboveMa60 === true ? 'MA60_UP' : 'MA60_DOWN'
    ].join('+')
  };
}

function buildFeatureCombo(features) {
  return [
    features.stateCode,
    features.shapeType,
    features.positionType,
    features.changeType,
    features.ret5Bucket,
    features.rangePosition20Bucket,
    features.aboveMaCombo,
    features.volatility20Bucket
  ].join(' | ');
}

function summarizeFeatureRows(rows) {
  return {
    样本: rows.length,
    T0前3日均值: formatPct(average(rows.map((row) => row.ret3Pct))),
    T0前5日均值: formatPct(average(rows.map((row) => row.ret5Pct))),
    T0前10日均值: formatPct(average(rows.map((row) => row.ret10Pct))),
    T0前20日均值: formatPct(average(rows.map((row) => row.ret20Pct))),
    区间位置20均值: formatPct(average(rows.map((row) => row.rangePosition20Pct))),
    价格版样本: 'PRICE_ONLY',
    波动20均值: formatPct(average(rows.map((row) => row.volatility20Pct))),
    真实D3均值: formatPct(average(rows.map((row) => row.actualD3Pct))),
    真实D5均值: formatPct(average(rows.map((row) => row.actualD5Pct))),
    真实D10均值: formatPct(average(rows.map((row) => row.actualD10Pct))),
    真实D20均值: formatPct(average(rows.map((row) => row.actualD20Pct)))
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();

  rows.forEach((row) => {
    const key = String(keyFn(row) || 'UNKNOWN');
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  });

  return map;
}

function summarizeByKey(rows, keyName, labelName, minCount = 1) {
  return Array.from(groupBy(rows, (row) => row[keyName]).entries())
    .map(([key, list]) => ({
      [labelName]: key,
      ...summarizeFeatureRows(list)
    }))
    .filter((row) => Number(row.样本 || 0) >= minCount)
    .sort((left, right) => Number(right.样本 || 0) - Number(left.样本 || 0));
}

function summarizeRapidDistributionByFeature(rows, keyName, minCount = 8) {
  return Array.from(groupBy(rows, (row) => row[keyName]).entries())
    .map(([key, list]) => {
      const rapidMap = groupBy(list, (row) => row.rapidType);
      const topRapid = Array.from(rapidMap.entries())
        .map(([rapidType, rapidRows]) => ({
          rapidType,
          count: rapidRows.length,
          ratio: rapidRows.length / list.length
        }))
        .sort((left, right) => {
          if (right.count !== left.count) {
            return right.count - left.count;
          }

          return right.ratio - left.ratio;
        })[0] || {
          rapidType: 'UNKNOWN',
          count: 0,
          ratio: 0
        };

      return {
        特征: keyName,
        取值: key,
        样本: list.length,
        主导急变: topRapid.rapidType,
        主导占比: formatPct(topRapid.ratio * 100, 1),
        主导样本: topRapid.count,
        真实D20均值: formatPct(average(list.map((row) => row.actualD20Pct))),
        T0前5日均值: formatPct(average(list.map((row) => row.ret5Pct))),
        区间位置20均值: formatPct(average(list.map((row) => row.rangePosition20Pct)))
      };
    })
    .filter((row) => Number(row.样本 || 0) >= minCount)
    .sort((left, right) => Number(right.样本 || 0) - Number(left.样本 || 0));
}

function summarizeComboDominance(rows, minCount = 5) {
  return Array.from(groupBy(rows, (row) => row.featureCombo).entries())
    .map(([combo, list]) => {
      const rapidMap = groupBy(list, (row) => row.rapidType);
      const topRapid = Array.from(rapidMap.entries())
        .map(([rapidType, rapidRows]) => ({
          rapidType,
          count: rapidRows.length,
          ratio: rapidRows.length / list.length
        }))
        .sort((left, right) => {
          if (right.ratio !== left.ratio) {
            return right.ratio - left.ratio;
          }

          return right.count - left.count;
        })[0] || {
          rapidType: 'UNKNOWN',
          count: 0,
          ratio: 0
        };

      return {
        前置组合: combo,
        样本: list.length,
        主导急变: topRapid.rapidType,
        主导占比: formatPct(topRapid.ratio * 100, 1),
        主导样本: topRapid.count,
        真实D3均值: formatPct(average(list.map((row) => row.actualD3Pct))),
        真实D5均值: formatPct(average(list.map((row) => row.actualD5Pct))),
        真实D20均值: formatPct(average(list.map((row) => row.actualD20Pct)))
      };
    })
    .filter((row) => Number(row.样本 || 0) >= minCount)
    .sort((left, right) => {
      const leftRatio = Number(String(left.主导占比 || '').replace('%', ''));
      const rightRatio = Number(String(right.主导占比 || '').replace('%', ''));

      if (rightRatio !== leftRatio) {
        return rightRatio - leftRatio;
      }

      return Number(right.样本 || 0) - Number(left.样本 || 0);
    });
}

function getRapidTargetGroup(rapidType) {
  const value = String(rapidType || '');

  if (value === 'FAST_TREND_EXTEND' || value === 'SLOW_START_EXTEND') {
    return 'EXTEND_UP';
  }

  if (value === 'FAST_BREAKDOWN' || value === 'SLOW_BLEED') {
    return 'BREAKDOWN_DOWN';
  }

  if (value === 'INTRADAY_WINDOW_ONLY' || value === 'FAST_TAKE_PROFIT_DECAY' || value === 'REBOUND_DECAY') {
    return 'SHORT_WINDOW_DECAY';
  }

  if (value === 'KILL_THEN_REPAIR') {
    return 'KILL_THEN_REPAIR';
  }

  return 'OTHER';
}

function buildRowsForSymbol(symbol, backtestResult, options) {
  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];
  const dailyStates = getDailyStates(backtestResult);
  const stateByDate = buildStateByDate(backtestResult);
  const warmup = Math.max(80, Number(options.warmup || 120));
  const step = Math.max(1, Number(options.step || 10));
  const max = Math.max(1, Number(options.max || 120));
  const forecastDays = Math.max(20, Number(options.forecastDays || 20));
  const maxSamples = Math.max(20, Number(options.maxSamples || 160));

  const rows = [];

  for (let index = warmup; index < bars.length - forecastDays && rows.length < max; index += step) {
    const bar = bars[index];

    if (!bar || !bar.date || !Number.isFinite(getClose(bars, index))) {
      continue;
    }

    const clickedDate = normalizeDate(bar.date);
    let analysis = null;

    try {
      analysis = buildNodePredictionAnalysis({
        symbol,
        bars,
        dailyStates,
        clickedDate,
        forecastDays,
        maxSamples
      });
    } catch (error) {
      rows.push({
        symbol,
        index,
        clickedDate,
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
      continue;
    }

    if (!analysis || !analysis.ok || !analysis.rapidChangeAnalysis || !analysis.rapidChangeAnalysis.ok) {
      rows.push({
        symbol,
        index,
        clickedDate,
        ok: false,
        error: analysis && analysis.error ? analysis.error : 'rapid analysis failed'
      });
      continue;
    }

    const rapid = analysis.rapidChangeAnalysis;
    const features = buildT0Features(symbol, bars, index, stateByDate);
    const row = {
      ...features,
      ok: true,

      rapidType: rapid.rapidType || 'UNKNOWN',
      rapidTitle: rapid.rapidTitle || '',
      rapidSignal: rapid.rapidSignal || '',
      rapidScore: toNumber(rapid.rapidScore, 0),
      rapidTargetGroup: getRapidTargetGroup(rapid.rapidType),

      actualD3Pct: toNumber(rapid.d3ReturnPct),
      actualD5Pct: toNumber(rapid.d5ReturnPct),
      actualD10Pct: toNumber(rapid.d10ReturnPct),
      actualD20Pct: toNumber(rapid.d20ReturnPct),
      actualMaxUpPct: toNumber(rapid.maxUpPct),
      actualMaxDownPct: toNumber(rapid.maxDownPct)
    };

    row.featureCombo = buildFeatureCombo(row);
    rows.push(row);
  }

  return rows;
}

async function validateSymbol(symbol, options) {
  console.log(`\n[SYMBOL_START] ${symbol}`);

  const backtestResult = await runBacktestForSymbol({
    symbol,
    startDate: options.start,
    endDate: options.end,
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only'
  });

  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];
  const rows = buildRowsForSymbol(symbol, backtestResult, options);
  const validRows = rows.filter((row) => row && row.ok);

  console.log(`[SYMBOL_DATA] ${symbol} bars=${bars.length} first=${bars[0] ? bars[0].date : '-'} last=${bars[bars.length - 1] ? bars[bars.length - 1].date : '-'} rows=${rows.length} valid=${validRows.length}`);

  console.log(`[SYMBOL_RAPID_FEATURE_BY_TYPE] ${symbol}`);
  console.table(summarizeByKey(validRows, 'rapidType', '急变类型', 1));

  return {
    symbol,
    rows,
    validRows
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = String(args.symbols || '')
    .split(',')
    .map(normalizeSymbolArg)
    .filter(Boolean);

  const options = {
    symbols: symbols.length ? symbols : DEFAULT_SYMBOLS,
    start: args.start || '20180101',
    end: args.end || '20260601',
    step: Number(args.step || 10),
    max: Number(args.max || 120),
    warmup: Number(args.warmup || 120),
    forecastDays: Number(args.forecastDays || 20),
    maxSamples: Number(args.maxSamples || 160),
    minFeatureCount: Number(args.minFeatureCount || 10),
    minComboCount: Number(args.minComboCount || 6)
  };

  console.log('[RAPID_FEATURE_ATTRIBUTION_OPTIONS]');
  console.log(JSON.stringify(options, null, 2));

  const allRows = [];
  const failures = [];

  for (const symbol of options.symbols) {
    try {
      const result = await validateSymbol(symbol, options);
      allRows.push(...result.validRows);
    } catch (error) {
      const message = error && error.stack ? error.stack : String(error);
      failures.push({
        symbol,
        error: message
      });
      console.error(`[SYMBOL_FAIL] ${symbol}`);
      console.error(message);
    }
  }

  console.log('\n[RAPID_FEATURE_TOTAL_BY_RAPID_TYPE]');
  console.table(summarizeByKey(allRows, 'rapidType', '急变类型', 1));

  console.log('\n[RAPID_FEATURE_TOTAL_BY_TARGET_GROUP]');
  console.table(summarizeByKey(allRows, 'rapidTargetGroup', '目标组', 1));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_STATE_CODE]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'stateCode', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_SHAPE]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'shapeType', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_POSITION]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'positionType', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_CHANGE]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'changeType', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_RET5_BUCKET]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'ret5Bucket', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_RANGE20_BUCKET]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'rangePosition20Bucket', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_DISTRIBUTION_BY_MA_COMBO]');
  console.table(summarizeRapidDistributionByFeature(allRows, 'aboveMaCombo', options.minFeatureCount));

  console.log('\n[RAPID_FEATURE_TOP_COMBOS]');
  console.table(summarizeComboDominance(allRows, options.minComboCount).slice(0, 50));

  console.log('\n[RAPID_FEATURE_FAILURES]');
  console.table(failures);

  console.log('\n[RAPID_FEATURE_DONE]');
  console.log(JSON.stringify({
    symbols: options.symbols.length,
    validRows: allRows.length,
    failures: failures.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});