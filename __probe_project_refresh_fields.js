function pickArrayResult(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.bars)) return result.bars;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

function summarizeBars(label, result) {
  const bars = pickArrayResult(result);
  const countPositive = (field) => bars.filter((r) => r && r[field] !== null && r[field] !== undefined && Number(r[field]) > 0).length;
  const first = bars[0] || null;
  const last = bars[bars.length - 1] || null;

  const summary = {
    label,
    source: result && result.source,
    warning: result && result.warning,
    bars: bars.length,
    dateStart: first && (first.date || first.trade_date || first.tradeDate),
    dateEnd: last && (last.date || last.trade_date || last.tradeDate),
    volumePct: bars.length ? Math.round(countPositive('volume') / bars.length * 10000) / 100 : 0,
    amountPct: bars.length ? Math.round(countPositive('amount') / bars.length * 10000) / 100 : 0,
    turnoverPct: bars.length ? Math.round(countPositive('turnover') / bars.length * 10000) / 100 : 0,
    first,
    last
  };

  console.log('\n=== ' + label + ' ===');
  console.log(JSON.stringify(summary, null, 2));
}

async function run() {
  const { getAshareDailyBars } = require('./src/data/ashareDataService');
  const { getHongKongDailyBars } = require('./src/data/hkDataService');

  const tests = [
    {
      label: 'A 600519 refresh',
      fn: getAshareDailyBars,
      args: {
        symbol: '600519',
        startDate: '20180101',
        endDate: '20260610',
        refresh: true,
        cacheOnly: false,
        sourceMode: 'auto'
      }
    },
    {
      label: 'A 300750 refresh',
      fn: getAshareDailyBars,
      args: {
        symbol: '300750',
        startDate: '20180101',
        endDate: '20260610',
        refresh: true,
        cacheOnly: false,
        sourceMode: 'auto'
      }
    },
    {
      label: 'HK HK:00700 refresh',
      fn: getHongKongDailyBars,
      args: {
        symbol: 'HK:00700',
        startDate: '20180101',
        endDate: '20260610',
        refresh: true,
        cacheOnly: false,
        sourceMode: 'auto'
      }
    },
    {
      label: 'HK HK:09888 refresh',
      fn: getHongKongDailyBars,
      args: {
        symbol: 'HK:09888',
        startDate: '20180101',
        endDate: '20260610',
        refresh: true,
        cacheOnly: false,
        sourceMode: 'auto'
      }
    }
  ];

  for (const test of tests) {
    try {
      const result = await test.fn(test.args);
      summarizeBars(test.label, result);
    } catch (error) {
      console.log('\n=== ' + test.label + ' FAILED ===');
      console.log(error && error.stack ? error.stack : error);
    }
  }
}

run();
