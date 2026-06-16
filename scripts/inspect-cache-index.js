const fs = require('fs');
const {
  cacheIndexExists,
  getCacheIndexPath,
  loadCacheIndex
} = require('../src/data/cacheIndexService');
const { getUniversePath } = require('../src/data/stockUniverseService');

function loadUniverseStocksFromDisk() {
  const universePath = getUniversePath();

  if (!fs.existsSync(universePath)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(universePath, 'utf8'));
    return Array.isArray(payload.stocks) ? payload.stocks : [];
  } catch (_error) {
    return [];
  }
}

function topEndDates(items) {
  const counts = new Map();

  for (const item of items) {
    const endDate = item && item.endDate ? item.endDate : '';

    if (!endDate) {
      continue;
    }

    counts.set(endDate, (counts.get(endDate) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([endDate, count]) => ({ endDate, count }))
    .sort((a, b) => {
      if (a.endDate === b.endDate) {
        return b.count - a.count;
      }

      return a.endDate < b.endDate ? 1 : -1;
    })
    .slice(0, 10);
}

async function main() {
  const exists = cacheIndexExists();
  const index = loadCacheIndex({ reload: true });
  const items = Object.values(index.items || {});
  const universeStocks = loadUniverseStocksFromDisk();

  const universeSymbols = new Set(universeStocks.map((stock) => stock.symbol));
  const indexSymbols = new Set(items.map((item) => item.symbol));
  const missingFromUniverse = items.filter((item) => !universeSymbols.has(item.symbol)).length;
  const pendingIndex = universeStocks.filter((stock) => !indexSymbols.has(stock.symbol)).length;

  console.log(JSON.stringify({
    exists,
    cacheIndexPath: getCacheIndexPath(),
    indexedSymbols: items.length,
    sample: items
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .slice(0, 10)
      .map((item) => ({
        symbol: item.symbol,
        barCount: item.barCount,
        startDate: item.startDate,
        endDate: item.endDate
      })),
    missingFromUniverse,
    pendingIndex,
    latestEndDateTop10: topEndDates(items)
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  main
};
