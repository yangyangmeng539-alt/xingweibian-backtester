#!/usr/bin/env node
const {
  syncMarketIndexDailyBars,
  getMarketIndexSummary
} = require('../src/data/indexDailyDataService');

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const startDate = readArg('start', '20180101');
  const endDate = readArg('end', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  const codes = readArg('codes', '');
  const preferSource = readArg('prefer-source', '');

  if (hasFlag('summary')) {
    const summary = await getMarketIndexSummary({ codes });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await syncMarketIndexDailyBars({
    startDate,
    endDate,
    codes,
    preferSource
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.failCount > 0 && result.okCount === 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});