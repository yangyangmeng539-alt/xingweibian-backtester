const {
  buildCacheIndexFromSqlite
} = require('../src/data/cacheIndexService');

async function main() {
  const result = await buildCacheIndexFromSqlite();

  if (!result.saveResult || !result.saveResult.ok) {
    throw new Error(result.saveResult && result.saveResult.error
      ? result.saveResult.error
      : '缓存索引保存失败。');
  }

  console.log(JSON.stringify({
    indexedSymbols: result.indexedSymbols,
    totalBars: result.totalBars,
    cacheIndexPath: result.cacheIndexPath,
    sqliteModified: result.sqliteModified,
    sqliteBefore: result.sqliteBefore,
    sqliteAfter: result.sqliteAfter
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
