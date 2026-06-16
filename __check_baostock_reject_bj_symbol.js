const {
  loadStockUniverse,
  filterStocksForSync,
  filterStocksForBaoStockAshareSync
} = require("./src/data/stockUniverseService");

(async () => {
  const universe = await loadStockUniverse();

  const selected = filterStocksForSync({
    mode: "symbols",
    symbols: ["600519", "920118"],
    universe: universe.stocks
  });

  console.log("selected:", selected);

  const supported = filterStocksForBaoStockAshareSync(selected, {
    mode: "symbols"
  });

  console.log("supported:", supported);
})();
