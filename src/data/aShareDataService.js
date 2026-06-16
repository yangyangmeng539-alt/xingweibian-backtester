const { fetchDailyBarsFromPython } = require('../workers/pythonWorker');
const { getDailyBars, upsertDailyBars, getCachePath } = require('../core/localCache');

const CACHE_FALLBACK_MIN_BARS = 80;
const CACHE_FALLBACK_SOURCE = 'SQLite 本地缓存（联网失败，已使用缓存）';
const CACHE_FALLBACK_WARNING = '联网拉取失败，已使用本地缓存。';

function normalizeSymbol(symbol) {
  const clean = String(symbol || '').trim();

  if (!/^\d{6}$/.test(clean)) {
    throw new Error(`请输入 6 位 A 股代码，例如 600519。当前输入：${symbol}`);
  }

  return clean;
}

function toAkDate(value, fallback) {
  const raw = String(value || fallback || '').trim().replace(/-/g, '');

  if (!/^\d{8}$/.test(raw)) {
    throw new Error(`日期格式必须是 YYYYMMDD，例如 20180101。当前输入：${value}`);
  }

  return raw;
}

function getTodayAkDate() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function sortBars(bars) {
  return [...bars].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function buildCacheResult(symbol, bars, source, warning) {
  return {
    symbol,
    bars: sortBars(bars),
    source,
    warning,
    cachePath: getCachePath()
  };
}

function hasEnoughCacheForBacktest(bars) {
  return Array.isArray(bars) && bars.length > CACHE_FALLBACK_MIN_BARS;
}

function getFetchedSourceLabel(source) {
  if (source === 'bj_sina_daily') {
    return '北交所新浪日线 + SQLite 缓存';
  }

  if (source === 'eastmoney_direct') {
    return '东方财富直连 + SQLite 缓存';
  }

  if (source === 'alt_daily' || source === 'tencent_fqkline') {
    return '腾讯备用日线 + SQLite 缓存';
  }

  return 'A股多源日线 + SQLite 缓存';
}

function normalizeFetchedResult(result) {
  if (Array.isArray(result)) {
    return {
      bars: result,
      source: result.source
    };
  }

  if (result && typeof result === 'object') {
    const bars = Array.isArray(result.bars) ? result.bars : [];

    return {
      bars,
      source: result.source || bars.source
    };
  }

  return {
    bars: [],
    source: ''
  };
}

async function getAshareDailyBars(options = {}) {
  const symbol = normalizeSymbol(options.symbol);
  const startDate = toAkDate(options.startDate || '20180101', '20180101');
  const endDate = toAkDate(options.endDate || getTodayAkDate(), getTodayAkDate());
  const refresh = Boolean(options.refresh);

  const cacheOnly = Boolean(options.cacheOnly)
    || String(options.sourceMode || '') === 'sqlite_cache_only';

  let cachedBars = await getDailyBars(symbol, startDate, endDate);

  if (hasEnoughCacheForBacktest(cachedBars) && !refresh) {
    return buildCacheResult(
      symbol,
      cachedBars,
      cacheOnly ? 'SQLite 本地缓存｜观察矩阵只读' : 'SQLite 本地缓存'
    );
  }

  // 关键：观察上下文 / 关系矩阵只允许读本地库。
  // 本地库不够，直接失败，不准继续走 AKShare / 东方财富 / Python worker 现拉。
  if (cacheOnly) {
    const cachedCount = Array.isArray(cachedBars) ? cachedBars.length : 0;

    throw new Error(
      `SQLite 本地日线不足：${symbol} 当前 ${cachedCount} 条，观察矩阵禁止联网现拉。请先同步该股票历史数据。`
    );
  }

  let fetchedBars = [];
  let fetchedSource = '';

  try {
    const fetchResult = await fetchDailyBarsFromPython({
      symbol,
      startDate,
      endDate,
      adjust: 'qfq',
      preferredSource: options.preferredSource || 'baostock_a_share',
      networkMode: options.networkMode || 'direct'
    });

    const normalizedFetchResult = normalizeFetchedResult(fetchResult);
    fetchedBars = normalizedFetchResult.bars;
    fetchedSource = normalizedFetchResult.source;

    if (!Array.isArray(fetchedBars) || fetchedBars.length === 0) {
      throw new Error(`没有拉到 ${symbol} 的历史日线数据。`);
    }
  } catch (error) {
    if (hasEnoughCacheForBacktest(cachedBars)) {
      return buildCacheResult(
        symbol,
        cachedBars,
        CACHE_FALLBACK_SOURCE,
        CACHE_FALLBACK_WARNING
      );
    }

    throw error;
  }

  await upsertDailyBars(symbol, fetchedBars);

  cachedBars = await getDailyBars(symbol, startDate, endDate);

  return {
    symbol,
    bars: sortBars(cachedBars),
    source: getFetchedSourceLabel(fetchedSource),
    cachePath: getCachePath()
  };
}

module.exports = {
  getAshareDailyBars,
  normalizeSymbol
};
