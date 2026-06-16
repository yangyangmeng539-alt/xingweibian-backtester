const {
  loadStockUniverse,
  getUniversePath
} = require('../src/data/stockUniverseService');

function countByMarket(stocks, market) {
  return stocks.filter((stock) => stock.market === market).length;
}

async function main() {
  const universe = await loadStockUniverse();
  const stocks = Array.isArray(universe.stocks) ? universe.stocks : [];

  console.log(`stock-universe.json 路径: ${getUniversePath()}`);
  console.log(`股票池数量: ${stocks.length}`);
  console.log(`SH 数量: ${countByMarket(stocks, 'SH')}`);
  console.log(`SZ 数量: ${countByMarket(stocks, 'SZ')}`);
  console.log(`BJ 数量: ${countByMarket(stocks, 'BJ')}`);
  console.log('前 20 个股票:');

  stocks.slice(0, 20).forEach((stock, index) => {
    console.log(`${index + 1}. ${stock.symbol} ${stock.name || '-'} ${stock.market}`);
  });
}

main().catch((error) => {
  console.error(`inspect-universe 失败: ${error && error.message ? error.message : error}`);
  console.error(`stock-universe.json 路径: ${getUniversePath()}`);
  process.exitCode = 1;
});
