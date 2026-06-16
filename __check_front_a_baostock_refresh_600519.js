(async () => {
  const { getAshareDailyBars } = require("./src/data/aShareDataService");

  const result = await getAshareDailyBars({
    symbol: "600519",
    startDate: "20180101",
    endDate: "20260611",
    refresh: true,
    cacheOnly: false,
    sourceMode: "auto"
  });

  const bars = result.bars || [];
  const pct = (field) => {
    if (!bars.length) return 0;
    const n = bars.filter((r) => r && r[field] !== null && r[field] !== undefined && Number(r[field]) > 0).length;
    return Math.round(n / bars.length * 10000) / 100;
  };

  console.log({
    source: result.source,
    rows: bars.length,
    amountPct: pct("amount"),
    turnoverPct: pct("turnover"),
    first: bars[0],
    last: bars[bars.length - 1]
  });
})();
