const path = require('path');
const { runPythonAdapter } = require('../workers/pythonWorker');
const { getDailyBars, upsertDailyBars, getCachePath } = require('../core/localCache');
const { normalizeMarketSymbol } = require('./marketSymbolService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const HK_DAILY_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'hkDailyAdapter.py');

const CACHE_FALLBACK_MIN_BARS = 80;
const CACHE_FALLBACK_SOURCE = 'SQLite 本地缓存｜港股';
const CACHE_FALLBACK_WARNING = '港股联网拉取失败，已使用本地缓存。';

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

function hasEnoughCacheForBacktest(bars) {
  return Array.isArray(bars) && bars.length > CACHE_FALLBACK_MIN_BARS;
}

function normalizeFetchedResult(result) {
  if (Array.isArray(result)) {
    return {
      bars: result,
      source: result.source || 'akshare_hk'
    };
  }

  if (result && typeof result === 'object') {
    return {
      bars: Array.isArray(result.bars) ? result.bars : [],
      source: result.source || 'akshare_hk'
    };
  }

  return {
    bars: [],
    source: 'akshare_hk'
  };
}

function buildCacheResult(identity, bars, source, warning) {
  return {
    market: identity.market,
    symbol: identity.symbol,
    displaySymbol: identity.displaySymbol,
    cacheSymbol: identity.cacheSymbol,
    currency: identity.currency,
    exchange: identity.exchange,
    bars: sortBars(bars),
    source,
    warning,
    cachePath: getCachePath()
  };
}

function getFetchedSourceLabel(source) {
  if (source === 'eastmoney_hk_direct') {
    return '东方财富港股直连 + SQLite 缓存';
  }

  if (source === 'tencent_hk_direct') {
    return '腾讯港股直连 + SQLite 缓存';
  }

  if (source === 'akshare_hk') {
    return 'AKShare 港股日线 + SQLite 缓存';
  }

  return '港股日线多源直连 + SQLite 缓存';
}

async function getHongKongDailyBars(options = {}) {
  const identity = normalizeMarketSymbol(options.symbol);

  if (identity.market !== 'HK') {
    throw new Error(`getHongKongDailyBars 只支持港股代码：${options.symbol}`);
  }

  const startDate = toAkDate(options.startDate || '19700101', '19700101');
  const endDate = toAkDate(options.endDate || getTodayAkDate(), getTodayAkDate());
  const refresh = Boolean(options.refresh);

  const cacheOnly = Boolean(options.cacheOnly)
    || String(options.sourceMode || '') === 'sqlite_cache_only';

  let cachedBars = await getDailyBars(identity.cacheSymbol, startDate, endDate);

  if (hasEnoughCacheForBacktest(cachedBars) && !refresh) {
    return buildCacheResult(
      identity,
      cachedBars,
      cacheOnly ? 'SQLite 本地缓存｜港股观察只读' : CACHE_FALLBACK_SOURCE
    );
  }

  if (cacheOnly) {
    const cachedCount = Array.isArray(cachedBars) ? cachedBars.length : 0;

    throw new Error(
      `SQLite 本地港股日线不足：${identity.displaySymbol} 当前 ${cachedCount} 条。请先联网拉取该港股历史数据。`
    );
  }

  let fetchedBars = [];
  let fetchedSource = 'akshare_hk';

  try {
    const fetchResult = await runPythonAdapter(HK_DAILY_ADAPTER_PATH, {
      symbol: identity.symbol,
      startDate,
      endDate,
      adjust: options.adjust || 'qfq',
      networkMode: options.networkMode || 'auto'
    });

    const normalizedFetchResult = normalizeFetchedResult(fetchResult);
    fetchedBars = normalizedFetchResult.bars;
    fetchedSource = normalizedFetchResult.source;

    if (!Array.isArray(fetchedBars) || fetchedBars.length === 0) {
      throw new Error(`没有拉到 ${identity.displaySymbol} 的港股历史日线数据。`);
    }
  } catch (error) {
    if (hasEnoughCacheForBacktest(cachedBars)) {
      return buildCacheResult(
        identity,
        cachedBars,
        CACHE_FALLBACK_SOURCE,
        CACHE_FALLBACK_WARNING
      );
    }

    throw error;
  }

  await upsertDailyBars(identity.cacheSymbol, fetchedBars);

  cachedBars = await getDailyBars(identity.cacheSymbol, startDate, endDate);

  return buildCacheResult(
    identity,
    cachedBars,
    getFetchedSourceLabel(fetchedSource)
  );
}

module.exports = {
  getHongKongDailyBars
};