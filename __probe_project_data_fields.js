function pickArrayResult(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.bars)) return result.bars;
  if (result && Array.isArray(result.data)) return result.data;
  if (result && result.result && Array.isArray(result.result.bars)) return result.result.bars;
  return [];
}

function summarizeBars(label, result) {
  const bars = pickArrayResult(result);
  const first = bars[0] || null;
  const last = bars[bars.length - 1] || null;

  const keys = new Set();
  for (const row of bars.slice(0, 20)) {
    Object.keys(row || {}).forEach((k) => keys.add(k));
  }

  const count = (field) => bars.filter((r) => r && r[field] !== null && r[field] !== undefined && Number(r[field]) > 0).length;

  console.log('\n===', label, '===');
  console.log('resultType =', Array.isArray(result) ? 'array' : typeof result);
  console.log('topKeys =', result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []);
  console.log('bars.length =', bars.length);
  console.log('barKeys =', Array.from(keys));
  console.log('dateStart =', first && (first.trade_date || first.tradeDate || first.date));
  console.log('dateEnd   =', last && (last.trade_date || last.tradeDate || last.date));

  console.log('positive coverage =', {
    volume: bars.length ? Math.round(count('volume') / bars.length * 10000) / 100 : 0,
    amount: bars.length ? Math.round(count('amount') / bars.length * 10000) / 100 : 0,
    turnover: bars.length ? Math.round(count('turnover') / bars.length * 10000) / 100 : 0,
    turnoverRate: bars.length ? Math.round(count('turnoverRate') / bars.length * 10000) / 100 : 0
  });

  console.log('first =', first);
  console.log('last  =', last);
}

async function tryCall(label, fn, calls) {
  for (const call of calls) {
    try {
      const result = await call(fn);
      const bars = pickArrayResult(result);

      if (bars.length > 0) {
        summarizeBars(label, result);
        return;
      }

      console.log('\n===', label, 'empty with one call shape ===');
      console.log(result && typeof result === 'object' ? Object.keys(result) : result);
    } catch (error) {
      console.log('\n===', label, 'call failed ===');
      console.log(error && error.message ? error.message : error);
    }
  }

  console.log('\n===', label, 'ALL CALL SHAPES FAILED OR EMPTY ===');
}

(async () => {
  const { getAshareDailyBars } = require('./src/data/ashareDataService');
  const { getHongKongDailyBars } = require('./src/data/hkDataService');
  const { getDailyBarsForMarket } = require('./src/data/dailyBarDataService');

  console.log('function lengths =', {
    getAshareDailyBars: getAshareDailyBars.length,
    getHongKongDailyBars: getHongKongDailyBars.length,
    getDailyBarsForMarket: getDailyBarsForMarket.length
  });

  const common = {
    startDate: '20180101',
    endDate: '20260610',
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only'
  };

  await tryCall('A getAshareDailyBars 600519 cacheOnly', getAshareDailyBars, [
    (fn) => fn('600519', common),
    (fn) => fn({ symbol: '600519', ...common }),
    (fn) => fn('600519', '20180101', '20260610', common)
  ]);

  await tryCall('A getAshareDailyBars 300750 cacheOnly', getAshareDailyBars, [
    (fn) => fn('300750', common),
    (fn) => fn({ symbol: '300750', ...common }),
    (fn) => fn('300750', '20180101', '20260610', common)
  ]);

  await tryCall('HK getHongKongDailyBars HK:00700 cacheOnly', getHongKongDailyBars, [
    (fn) => fn('HK:00700', common),
    (fn) => fn({ symbol: 'HK:00700', ...common }),
    (fn) => fn('00700', common),
    (fn) => fn('00700', '20180101', '20260610', common)
  ]);

  await tryCall('HK getHongKongDailyBars HK:09888 cacheOnly', getHongKongDailyBars, [
    (fn) => fn('HK:09888', common),
    (fn) => fn({ symbol: 'HK:09888', ...common }),
    (fn) => fn('09888', common),
    (fn) => fn('09888', '20180101', '20260610', common)
  ]);

  await tryCall('UNIFIED getDailyBarsForMarket A 600519 cacheOnly', getDailyBarsForMarket, [
    (fn) => fn({ market: 'A', symbol: '600519', ...common }),
    (fn) => fn('A', '600519', common),
    (fn) => fn('600519', common)
  ]);

  await tryCall('UNIFIED getDailyBarsForMarket HK HK:00700 cacheOnly', getDailyBarsForMarket, [
    (fn) => fn({ market: 'HK', symbol: 'HK:00700', ...common }),
    (fn) => fn('HK', 'HK:00700', common),
    (fn) => fn('HK:00700', common)
  ]);
})();
