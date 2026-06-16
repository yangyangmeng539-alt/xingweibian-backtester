const { getAshareDailyBars } = require('./aShareDataService');
const { getHongKongDailyBars } = require('./hkDataService');
const { normalizeMarketSymbol } = require('./marketSymbolService');

async function getDailyBarsForMarket(options = {}) {
  const identity = normalizeMarketSymbol(options.symbol);

  if (identity.market === 'HK') {
    return getHongKongDailyBars({
      ...options,
      symbol: identity.displaySymbol
    });
  }

  const result = await getAshareDailyBars({
    ...options,
    symbol: identity.symbol
  });

  return {
    ...result,
    market: identity.market,
    displaySymbol: identity.displaySymbol,
    cacheSymbol: identity.cacheSymbol,
    currency: identity.currency,
    exchange: identity.exchange
  };
}

module.exports = {
  getDailyBarsForMarket,
  normalizeMarketSymbol
};