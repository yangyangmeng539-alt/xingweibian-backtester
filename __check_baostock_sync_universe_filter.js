const {
  loadStockUniverse,
  filterStocksForSync,
  filterStocksForBaoStockAshareSync
} = require("./src/data/stockUniverseService");

(async () => {
  const universe = await loadStockUniverse();

  const all = filterStocksForSync({
    mode: "full",
    universe: universe.stocks
  });

  const supported = filterStocksForBaoStockAshareSync(all, {
    mode: "full"
  });

  const unsupported = all.filter((stock) => !supported.some((item) => item.symbol === stock.symbol));

  console.log({
    universeTotal: universe.stocks.length,
    activeTotal: all.length,
    baostockSupported: supported.length,
    excluded: unsupported.length,
    supportedSample: supported.slice(0, 10),
    excludedSample: unsupported.slice(0, 20)
  });
})();
