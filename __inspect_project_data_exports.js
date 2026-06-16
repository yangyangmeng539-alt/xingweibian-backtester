const paths = [
  './src/data/dailyBarDataService',
  './src/data/ashareDataService',
  './src/data/hkDataService',
  './src/adapters/hkDailyAdapter',
  './src/core/backtestEngine'
];

for (const p of paths) {
  console.log('\n===', p, '===');
  try {
    const mod = require(p);
    console.log(Object.keys(mod));
  } catch (error) {
    console.log('ERROR:', error.message);
  }
}
