const MARKET_CN_A = 'CN_A';
const MARKET_HK = 'HK';

function cleanText(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHongKongSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  const digits = raw.replace(/\D/g, '');

  if (!/^\d{1,5}$/.test(digits)) {
    throw new Error(`非法港股代码：${value}。示例：HK:00700 / 00700 / 09866.HK`);
  }

  return digits.padStart(5, '0');
}

function normalizeAshareSymbol(value) {
  const raw = String(value || '').trim();

  if (!/^\d{6}$/.test(raw)) {
    throw new Error(`非法 A 股代码：${value}。示例：600519`);
  }

  return raw;
}

function buildIdentity(market, symbol) {
  if (market === MARKET_HK) {
    return {
      market: MARKET_HK,
      symbol,
      displaySymbol: `HK:${symbol}`,
      cacheSymbol: `HK:${symbol}`,
      currency: 'HKD',
      exchange: 'HKEX',
      isAshare: false,
      isHongKong: true
    };
  }

  return {
    market: MARKET_CN_A,
    symbol,
    displaySymbol: symbol,

    // 第一阶段先不迁移 A 股旧缓存，继续用 600519 这种老 key。
    // 后面真要全市场统一，再单独做 CN_A:600519 迁移脚本。
    cacheSymbol: symbol,
    currency: 'CNY',
    exchange: 'CN_A',
    isAshare: true,
    isHongKong: false
  };
}

function normalizeMarketSymbol(value) {
  const text = cleanText(value);

  if (!text) {
    throw new Error('股票代码不能为空。');
  }

  if (text.startsWith('HK:')) {
    return buildIdentity(MARKET_HK, normalizeHongKongSymbol(text.slice(3)));
  }

  if (text.startsWith('HK')) {
    return buildIdentity(MARKET_HK, normalizeHongKongSymbol(text.slice(2)));
  }

  if (/^\d{1,5}\.HK$/.test(text)) {
    return buildIdentity(MARKET_HK, normalizeHongKongSymbol(text.replace(/\.HK$/, '')));
  }

  if (/^\d{5}$/.test(text)) {
    return buildIdentity(MARKET_HK, normalizeHongKongSymbol(text));
  }

  if (/^\d{6}$/.test(text)) {
    return buildIdentity(MARKET_CN_A, normalizeAshareSymbol(text));
  }

  throw new Error(`暂不支持的股票代码：${value}。示例：600519 / HK:00700 / 09866.HK`);
}

function isAshareInput(value) {
  try {
    return normalizeMarketSymbol(value).market === MARKET_CN_A;
  } catch (_error) {
    return false;
  }
}

function isHongKongInput(value) {
  try {
    return normalizeMarketSymbol(value).market === MARKET_HK;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  MARKET_CN_A,
  MARKET_HK,
  normalizeMarketSymbol,
  normalizeAshareSymbol,
  normalizeHongKongSymbol,
  isAshareInput,
  isHongKongInput
};