const { getDailyBarsBySymbols, getCachePath } = require('./localCache');
const { buildMarketStateAnalysis } = require('./marketStateService');
const { loadStockUniverse } = require('../data/stockUniverseService');
const { loadHongKongStockUniverse } = require('../data/hkStockUniverseService');
const { loadCacheIndex } = require('../data/cacheIndexService');

const MARKET_STATE_RUNNER_VERSION = 'xwb-market-state-runner-v1';

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return text.slice(0, 10);
}

function toRequestDate(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function getTodayDateText() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addCalendarDays(dateText, offsetDays) {
  const normalized = normalizeDate(dateText) || getTodayDateText();
  const date = new Date(`${normalized}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return normalizeDate(getTodayDateText());
  }

  date.setDate(date.getDate() + Number(offsetDays || 0));

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function normalizeMarket(value) {
  const text = String(value || '').trim().toUpperCase();

  if (text === 'HK' || text === 'HKG') {
    return 'HK';
  }

  return 'CN_A';
}

function normalizeAshareSymbol(value) {
  const text = String(value || '').trim().toUpperCase();
  const match = text.match(/(\d{6})/);
  return match ? match[1] : '';
}

function normalizeHongKongSymbol(value) {
  const text = String(value || '').trim().toUpperCase();

  if (/^HK:\d{5}$/.test(text)) {
    return text;
  }

  if (/^\d{1,5}$/.test(text)) {
    return `HK:${text.padStart(5, '0')}`;
  }

  if (/^\d{1,5}\.HK$/.test(text)) {
    return `HK:${text.replace(/\.HK$/, '').padStart(5, '0')}`;
  }

  return '';
}

function normalizeManualSymbols(symbols, market) {
  const rawList = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(/[,，\s]+/);

  const seen = new Set();
  const result = [];

  for (const item of rawList) {
    const symbol = market === 'HK'
      ? normalizeHongKongSymbol(item)
      : normalizeAshareSymbol(item);

    if (!symbol || seen.has(symbol)) {
      continue;
    }

    seen.add(symbol);
    result.push(symbol);
  }

  return result;
}

function getCacheIndexSymbolsByMarket(market) {
  try {
    const index = loadCacheIndex({ reload: true });
    const items = index && index.items && typeof index.items === 'object'
      ? index.items
      : {};

    return Object.keys(items)
      .filter((symbol) => {
        if (market === 'HK') {
          return /^HK:\d{5}$/.test(symbol);
        }

        return /^\d{6}$/.test(symbol);
      })
      .sort();
  } catch (_error) {
    return [];
  }
}

async function getUniverseSymbolsByMarket(market, options = {}) {
  const manualSymbols = normalizeManualSymbols(options.symbols, market);

  if (manualSymbols.length > 0) {
    return {
      sampleMode: 'manual_symbols',
      symbols: manualSymbols,
      universeCount: manualSymbols.length,
      universeSource: 'manual'
    };
  }

  if (market === 'HK') {
    const universe = loadHongKongStockUniverse();
    const symbols = Array.from(new Set(
      (Array.isArray(universe && universe.stocks) ? universe.stocks : [])
        .map((stock) => normalizeHongKongSymbol(stock && stock.symbol))
        .filter(Boolean)
    ));

    if (symbols.length > 0) {
      return {
        sampleMode: 'hk_universe',
        symbols,
        universeCount: symbols.length,
        universeSource: universe.source || 'hk-stock-universe.json'
      };
    }

    const fallback = getCacheIndexSymbolsByMarket('HK');

    return {
      sampleMode: 'cache_index_hk',
      symbols: fallback,
      universeCount: fallback.length,
      universeSource: 'cache-index'
    };
  }

  const universe = await loadStockUniverse();
  const symbols = Array.from(new Set(
    (Array.isArray(universe && universe.stocks) ? universe.stocks : [])
      .filter((stock) => String(stock && stock.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
      .map((stock) => normalizeAshareSymbol(stock && stock.symbol))
      .filter(Boolean)
  ));

  if (symbols.length > 0) {
    return {
      sampleMode: 'a_share_universe',
      symbols,
      universeCount: symbols.length,
      universeSource: universe.source || 'stock-universe.json'
    };
  }

  const fallback = getCacheIndexSymbolsByMarket('CN_A');

  return {
    sampleMode: 'cache_index_a_share',
    symbols: fallback,
    universeCount: fallback.length,
    universeSource: 'cache-index'
  };
}

function pickLatestCoveredDate(barsBySymbol, minCount, maxDate = '') {
  const countByDate = new Map();
  const normalizedMaxDate = normalizeDate(maxDate);

  Object.values(barsBySymbol || {}).forEach((bars) => {
    (Array.isArray(bars) ? bars : []).forEach((bar) => {
      const date = normalizeDate(bar && bar.date);

      if (!date) {
        return;
      }

      if (normalizedMaxDate && date > normalizedMaxDate) {
        return;
      }

      countByDate.set(date, (countByDate.get(date) || 0) + 1);
    });
  });

  const dates = Array.from(countByDate.entries())
    .filter(([, count]) => count >= minCount)
    .map(([date]) => date)
    .sort();

  return dates[dates.length - 1] || '';
}

async function runMarketStateForMarket(payload = {}) {
  const input = payload || {};
  const market = normalizeMarket(input.market);
  const universe = await getUniverseSymbolsByMarket(market, input);
  const symbols = universe.symbols;

  if (!symbols.length) {
    return {
      version: MARKET_STATE_RUNNER_VERSION,
      ok: false,
      market,
      reason: 'EMPTY_MARKET_UNIVERSE',
      sampleMode: universe.sampleMode,
      universeSource: universe.universeSource,
      symbols: []
    };
  }

  const requestedDate = normalizeDate(
    input.date
    || input.clickedDate
    || input.selectedNodeDate
    || ''
  );

  const queryEndDate = normalizeDate(
    input.endDate
    || requestedDate
    || getTodayDateText()
  );

  const lookbackCalendarDays = Math.max(
    90,
    Math.min(420, Number(input.lookbackCalendarDays) || 220)
  );

  const queryStartDate = normalizeDate(
    input.startDate
    || addCalendarDays(queryEndDate, -lookbackCalendarDays)
  );

  const batchResult = await getDailyBarsBySymbols(
    symbols,
    toRequestDate(queryStartDate),
    toRequestDate(queryEndDate)
  );

  const barsBySymbol = batchResult.barsBySymbol || {};
  const minCoveredCount = Math.max(5, Math.ceil(symbols.length * 0.25));
  const targetDate = pickLatestCoveredDate(
    barsBySymbol,
    minCoveredCount,
    requestedDate || queryEndDate
  ) || requestedDate;

  const analysis = buildMarketStateAnalysis({
    market,
    date: targetDate,
    barsBySymbol
  });

  return {
    version: MARKET_STATE_RUNNER_VERSION,
    ok: Boolean(analysis && analysis.ok),
    market,
    date: targetDate,
    requestedDate,
    queryStartDate,
    queryEndDate,
    sampleMode: universe.sampleMode,
    universeSource: universe.universeSource,
    universeCount: universe.universeCount,
    symbolCount: symbols.length,
    cachePath: getCachePath(),
    batch: {
      rowCount: batchResult.rowCount || 0,
      backend: batchResult.backend || ''
    },
    analysis
  };
}

module.exports = {
  MARKET_STATE_RUNNER_VERSION,
  runMarketStateForMarket
};