const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');
const {
  buildLiquidityFactorAnalysisFromBars,
  buildLiquidityEnhancedPrediction
} = require('../src/core/liquidityFactorService');

const DEFAULT_SYMBOLS = [
  '600519', '000858', '300750', '002594', '601318',
  '600036', '000001', '600276', '603259', '600887',
  '000333', '000651', '600900', '601899', '000725',
  '002475', '603986', '601012', '600438', '600030'
];

const HORIZONS = [5, 10, 20];

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((item) => {
    const match = String(item || '').match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  });
  return args;
}

function normalizeAshareSymbol(value) {
  const raw = String(value || '').trim();

  if (!raw) return '';

  if (/^(HK:|\d{5}\.HK$)/i.test(raw)) {
    return raw;
  }

  const digits = raw.replace(/\D/g, '');

  if (/^\d{1,6}$/.test(digits)) {
    return digits.padStart(6, '0');
  }

  return raw;
}

function splitSymbols(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_SYMBOLS;
  return raw
    .split(/[，,\s]+/)
    .map((item) => normalizeAshareSymbol(item))
    .filter(Boolean);
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 2) {
  const number = toNumber(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '-';
}

function average(values) {
  const list = values.map((value) => toNumber(value)).filter(Number.isFinite);
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function direction(value) {
  const number = toNumber(value);
  if (!Number.isFinite(number)) return '';
  if (number > 0) return 'UP';
  if (number < 0) return 'DOWN';
  return 'FLAT';
}

function isDirectionHit(forecast, actual) {
  const forecastDirection = direction(forecast);
  const actualDirection = direction(actual);

  if (
    !forecastDirection
    || !actualDirection
    || forecastDirection === 'FLAT'
    || actualDirection === 'FLAT'
  ) {
    return null;
  }

  return forecastDirection === actualDirection;
}

function normalizeDateKey(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function getDailyStateDate(state) {
  return state
    && (
      state.date
      || state.tradeDate
      || state.trade_date
      || state.day
      || state.t
    )
    ? String(state.date || state.tradeDate || state.trade_date || state.day || state.t)
    : '';
}

function buildDailyStateMap(dailyStates) {
  const map = new Map();

  (Array.isArray(dailyStates) ? dailyStates : []).forEach((state) => {
    const key = normalizeDateKey(getDailyStateDate(state));
    if (key) map.set(key, state);
  });

  return map;
}

function getDailyStates(result) {
  return result
    && result.xwbStateAnalysis
    && Array.isArray(result.xwbStateAnalysis.dailyStates)
    ? result.xwbStateAnalysis.dailyStates
    : [];
}

function getRawForecastPct(analysis, day) {
  const key = `d${Number(day)}`;
  const row = analysis
    && analysis.horizonSummary
    && analysis.horizonSummary[key]
    ? analysis.horizonSummary[key]
    : null;

  return toNumber(row && row.medianReturnPct);
}

function getEnhancedForecastPct(analysis, day) {
  const raw = getRawForecastPct(analysis, day);
  const liquidity = analysis && analysis.liquidityAnalysis ? analysis.liquidityAnalysis : {};
  const adjustmentByDayPct = liquidity && liquidity.adjustmentByDayPct
    ? liquidity.adjustmentByDayPct
    : {};

  const dayNumber = Number(day);
  const adjustment = toNumber(
    adjustmentByDayPct[dayNumber]
      ?? adjustmentByDayPct[String(dayNumber)]
      ?? 0,
    0
  );

  if (!Number.isFinite(raw)) {
    return null;
  }

  return Number((raw + adjustment).toFixed(4));
}

function getActualPct(analysis, day) {
  const key = `d${Number(day)}`;
  const comparison = analysis && analysis.actualComparison
    ? analysis.actualComparison
    : {};
  const row = comparison[key];

  if (row && row.hasActual) {
    return toNumber(row.actualReturnPct);
  }

  const path = Array.isArray(analysis && analysis.actualFuturePath)
    ? analysis.actualFuturePath
    : [];
  const item = path.find((entry) => Number(entry && entry.day) === Number(day));

  return item && item.exists ? toNumber(item.returnPct) : null;
}

function getRegime(analysis) {
  const liquidity = analysis && analysis.liquidityAnalysis ? analysis.liquidityAnalysis : {};
  const enhanced = analysis && analysis.liquidityEnhancedPrediction ? analysis.liquidityEnhancedPrediction : {};

  return (
    liquidity.regime
    || liquidity.regimeKey
    || liquidity.type
    || liquidity.kind
    || enhanced.regime
    || enhanced.regimeKey
    || enhanced.type
    || enhanced.kind
    || 'UNKNOWN'
  );
}

function getScore(analysis) {
  return toNumber(
    (
      analysis
      && analysis.liquidityAnalysis
      && analysis.liquidityAnalysis.score
    )
    || (
      analysis
      && analysis.liquidityEnhancedPrediction
      && analysis.liquidityEnhancedPrediction.score
    )
  );
}

function buildAshareLiquidityAnalysisForPath({
  symbol,
  bars,
  clickedIndex,
  currentState,
  forecastDays
}) {
  const cleanSymbol = normalizeAshareSymbol(symbol);

  const attempts = [
    {
      bars,
      clickedIndex,
      currentState,
      forecastDays,
      symbol: cleanSymbol,
      code: cleanSymbol,
      market: 'A_SHARE',
      marketType: 'A_SHARE',
      marketScope: 'A_SHARE',
      assetMarket: 'A_SHARE',
      isAshare: true,
      isAShare: true
    },
    {
      bars,
      clickedIndex,
      currentState,
      forecastDays,
      symbol: cleanSymbol,
      code: cleanSymbol,
      market: 'A',
      marketType: 'A',
      marketScope: 'A',
      assetMarket: 'A',
      isAshare: true,
      isAShare: true
    },
    {
      bars,
      clickedIndex,
      currentState,
      forecastDays,
      symbol: cleanSymbol,
      code: cleanSymbol,
      market: 'CN_A',
      marketType: 'CN_A',
      marketScope: 'CN_A',
      assetMarket: 'CN_A',
      isAshare: true,
      isAShare: true
    },
    {
      bars,
      clickedIndex,
      currentState,
      forecastDays,
      symbol: cleanSymbol,
      code: cleanSymbol
    },
    {
      bars,
      clickedIndex,
      currentState,
      forecastDays
    }
  ];

  let firstResult = null;

  for (const attempt of attempts) {
    const result = buildLiquidityFactorAnalysisFromBars(attempt);

    if (!firstResult) {
      firstResult = result;
    }

    if (result && result.ok) {
      return result;
    }
  }

  return firstResult || {
    ok: false,
    reason: 'NO_LIQUIDITY_RESULT',
    score: 0,
    adjustmentByDayPct: { 5: 0, 10: 0, 20: 0 },
    signals: []
  };
}

function summarizeByDay(rows, day, label) {
  const rawKey = `rawD${day}`;
  const enhancedKey = `enhancedD${day}`;
  const actualKey = `actualD${day}`;

  const valid = rows.filter((row) => (
    Number.isFinite(toNumber(row[rawKey]))
    && Number.isFinite(toNumber(row[enhancedKey]))
    && Number.isFinite(toNumber(row[actualKey]))
  ));

  const rawHits = valid.filter((row) => isDirectionHit(row[rawKey], row[actualKey]) === true).length;
  const enhancedHits = valid.filter((row) => isDirectionHit(row[enhancedKey], row[actualKey]) === true).length;

  const rawMae = average(valid.map((row) => Math.abs(row[rawKey] - row[actualKey])));
  const enhancedMae = average(valid.map((row) => Math.abs(row[enhancedKey] - row[actualKey])));

  const dropThreshold = day <= 5 ? -4 : day <= 10 ? -6 : -8;

  const rawBullDrop = valid.filter((row) => row[rawKey] > 0 && row[actualKey] <= dropThreshold).length;
  const enhancedBullDrop = valid.filter((row) => row[enhancedKey] > 0 && row[actualKey] <= dropThreshold).length;

  return {
    label,
    day,
    samples: valid.length,
    rawDirectionHitPct: valid.length ? rawHits / valid.length * 100 : null,
    enhancedDirectionHitPct: valid.length ? enhancedHits / valid.length * 100 : null,
    directionDeltaPct: valid.length ? (enhancedHits - rawHits) / valid.length * 100 : null,
    rawMae,
    enhancedMae,
    maeDelta: Number.isFinite(rawMae) && Number.isFinite(enhancedMae) ? enhancedMae - rawMae : null,
    rawBullDrop,
    enhancedBullDrop,
    bullDropDelta: enhancedBullDrop - rawBullDrop
  };
}

function summarizeReboundFailure(rows, label) {
  const valid = rows.filter((row) => (
    Number.isFinite(toNumber(row.actualD5))
    && Number.isFinite(toNumber(row.actualD20))
    && Number.isFinite(toNumber(row.rawD5))
    && Number.isFinite(toNumber(row.rawD20))
    && Number.isFinite(toNumber(row.enhancedD5))
    && Number.isFinite(toNumber(row.enhancedD20))
  ));

  const actualReboundFailure = valid.filter((row) => row.actualD5 > 1 && row.actualD20 <= -4);

  const rawCapture = actualReboundFailure.filter((row) => (
    row.rawD5 > row.rawD20
    && row.rawD20 <= 0
  ));

  const enhancedCapture = actualReboundFailure.filter((row) => (
    row.enhancedD5 > row.enhancedD20
    && row.enhancedD20 <= 0
  ));

  const rawFalseRebound = valid.filter((row) => row.rawD5 > 1 && row.actualD5 <= -4).length;
  const enhancedFalseRebound = valid.filter((row) => row.enhancedD5 > 1 && row.actualD5 <= -4).length;

  return {
    label,
    samples: valid.length,
    actualReboundFailure: actualReboundFailure.length,
    rawCapturePct: actualReboundFailure.length ? rawCapture.length / actualReboundFailure.length * 100 : null,
    enhancedCapturePct: actualReboundFailure.length ? enhancedCapture.length / actualReboundFailure.length * 100 : null,
    captureDeltaPct: actualReboundFailure.length ? (enhancedCapture.length - rawCapture.length) / actualReboundFailure.length * 100 : null,
    rawFalseRebound,
    enhancedFalseRebound,
    falseReboundDelta: enhancedFalseRebound - rawFalseRebound
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();

  rows.forEach((row) => {
    const key = String(keyFn(row) || 'UNKNOWN');
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  });

  return map;
}

function printDaySummary(summary) {
  console.log(
    `${summary.label} D${summary.day} | samples=${summary.samples}`
    + ` | direction raw=${formatPct(summary.rawDirectionHitPct)} enhanced=${formatPct(summary.enhancedDirectionHitPct)} delta=${formatPct(summary.directionDeltaPct)}`
    + ` | mae raw=${formatPct(summary.rawMae)} enhanced=${formatPct(summary.enhancedMae)} delta=${formatPct(summary.maeDelta)}`
    + ` | bullDrop raw=${summary.rawBullDrop} enhanced=${summary.enhancedBullDrop} delta=${summary.bullDropDelta}`
  );
}

function printReboundSummary(summary) {
  console.log(
    `${summary.label} REBOUND_FAIL`
    + ` | samples=${summary.samples}`
    + ` | actual=${summary.actualReboundFailure}`
    + ` | capture raw=${formatPct(summary.rawCapturePct)} enhanced=${formatPct(summary.enhancedCapturePct)} delta=${formatPct(summary.captureDeltaPct)}`
    + ` | falseRebound raw=${summary.rawFalseRebound} enhanced=${summary.enhancedFalseRebound} delta=${summary.falseReboundDelta}`
  );
}

function buildRowsForSymbol(symbol, result, options) {
  const bars = Array.isArray(result && result.priceSeries) ? result.priceSeries : [];
  const dailyStates = getDailyStates(result);
  const stateMap = buildDailyStateMap(dailyStates);
  const warmup = Math.max(80, Number(options.warmup || 140));
  const step = Math.max(1, Number(options.step || 20));
  const max = Math.max(1, Number(options.max || 80));
  const forecastDays = Math.max(20, Number(options.forecastDays || 20));
  const maxSamples = Math.max(20, Number(options.maxSamples || 160));
  const rows = [];

  for (let index = warmup; index < bars.length - forecastDays && rows.length < max; index += step) {
    const bar = bars[index];

    if (!bar || !bar.date) continue;

    const analysis = buildNodePredictionAnalysis({
      bars,
      dailyStates,
      clickedDate: bar.date,
      forecastDays,
      maxSamples
    });

    if (!analysis || !analysis.ok) continue;

    let liquidityAnalysis = analysis.liquidityAnalysis || null;
    let liquidityEnhancedPrediction = analysis.liquidityEnhancedPrediction || null;

    // 优先使用引擎已经算好的量价结果。
    // 只有引擎里没有量价结果时，才退回脚本内临时计算。
    if (!liquidityAnalysis || !liquidityAnalysis.regime) {
      const dateKey = normalizeDateKey(bar.date);
      const currentState = stateMap.get(dateKey) || dailyStates[index] || null;

      const fallbackLiquidityAnalysis = buildAshareLiquidityAnalysisForPath({
        symbol,
        bars,
        clickedIndex: index,
        currentState,
        forecastDays
      });

      if (options.diag === 'true' && rows.length < 3) {
        console.log('[FALLBACK_LIQ_RAW]', symbol, bar.date, {
          ok: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.ok,
          reason: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.reason,
          regime: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.regime,
          regimeKey: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.regimeKey,
          type: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.type,
          label: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.label,
          score: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.score,
          supportScore: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.supportScore,
          riskScore: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.riskScore,
          adjustmentByDayPct: fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.adjustmentByDayPct,
          keys: fallbackLiquidityAnalysis ? Object.keys(fallbackLiquidityAnalysis).slice(0, 40) : []
        });
      }

      if (fallbackLiquidityAnalysis && fallbackLiquidityAnalysis.ok) {
        liquidityAnalysis = fallbackLiquidityAnalysis;
      }
    }

    if (
      (!liquidityEnhancedPrediction || !liquidityEnhancedPrediction.horizonSummary)
      && liquidityAnalysis
      && liquidityAnalysis.ok
    ) {
      const fallbackEnhancedPrediction = buildLiquidityEnhancedPrediction({
        horizonSummary: analysis.horizonSummary || {},
        liquidityAnalysis
      });

      if (
        fallbackEnhancedPrediction
        && fallbackEnhancedPrediction.horizonSummary
      ) {
        liquidityEnhancedPrediction = fallbackEnhancedPrediction;
      }
    }

    const mergedAnalysis = {
      ...analysis,
      liquidityAnalysis,
      liquidityEnhancedPrediction
    };

    if (options.diag === 'true' && rows.length < 3) {
      console.log('[PATH_LIQ_DIAG]', symbol, bar.date, {
        engineRegime: analysis.liquidityAnalysis && analysis.liquidityAnalysis.regime,
        pickedRegime: liquidityAnalysis && liquidityAnalysis.regime,
        pickedScore: liquidityAnalysis && liquidityAnalysis.score,
        pickedAdjustment: liquidityAnalysis && liquidityAnalysis.adjustmentByDayPct,
        hasEnhanced: Boolean(
          liquidityAnalysis
          && liquidityAnalysis.adjustmentByDayPct
          && Object.values(liquidityAnalysis.adjustmentByDayPct).some((value) => Number(value) !== 0)
        )
      });
    }

    const row = {
      symbol,
      date: bar.date,
      regime: getRegime(mergedAnalysis),
      score: getScore(mergedAnalysis)
    };

    HORIZONS.forEach((day) => {
      row[`rawD${day}`] = getRawForecastPct(mergedAnalysis, day);
      row[`enhancedD${day}`] = getEnhancedForecastPct(mergedAnalysis, day);
      row[`actualD${day}`] = getActualPct(mergedAnalysis, day);
    });

    rows.push(row);
  }

  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = splitSymbols(args.symbols || args.symbol);
  const startDate = args.start || args.startDate || '20180101';
  const endDate = args.end || args.endDate || '';
  const cacheOnly = args.cacheOnly !== 'false';
  const refresh = args.refresh === 'true';
  const sourceMode = args.sourceMode || 'sqlite_cache_only';

  const allRows = [];
  const failures = [];

  for (const symbol of symbols) {
    try {
      const result = await runBacktestForSymbol({
        symbol,
        startDate,
        endDate,
        cacheOnly,
        refresh,
        sourceMode,
        forecastDays: Number(args.forecastDays || 20),
        maxSamples: Number(args.maxSamples || 160)
      });

      const rows = buildRowsForSymbol(symbol, result, args);
      allRows.push(...rows);

      console.log(`\n=== ${symbol} ===`);
      HORIZONS.forEach((day) => printDaySummary(summarizeByDay(rows, day, symbol)));
      printReboundSummary(summarizeReboundFailure(rows, symbol));
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      failures.push({ symbol, error: message });
      console.log(`\n=== ${symbol} FAILED ===`);
      console.log(message);
    }
  }

  console.log('\n=== ALL_A_SHARE PATH ===');
  HORIZONS.forEach((day) => printDaySummary(summarizeByDay(allRows, day, 'ALL_A_SHARE')));
  printReboundSummary(summarizeReboundFailure(allRows, 'ALL_A_SHARE'));

  console.log('\n=== BY LIQUIDITY REGIME ===');
  Array.from(groupBy(allRows, (row) => row.regime).entries())
    .sort((left, right) => right[1].length - left[1].length)
    .forEach(([regime, rows]) => {
      HORIZONS.forEach((day) => printDaySummary(summarizeByDay(rows, day, regime)));
      printReboundSummary(summarizeReboundFailure(rows, regime));
    });

  if (failures.length) {
    console.log('\n=== FAILURES ===');
    failures.forEach((item) => console.log(`${item.symbol}: ${item.error}`));
  }

  console.log('\nJSON_PATH_SUMMARY ' + JSON.stringify({
    symbols: Array.from(new Set(allRows.map((row) => row.symbol))),
    totalRows: allRows.length,
    byDay: HORIZONS.map((day) => summarizeByDay(allRows, day, 'ALL_A_SHARE')),
    reboundFailure: summarizeReboundFailure(allRows, 'ALL_A_SHARE'),
    byRegime: Array.from(groupBy(allRows, (row) => row.regime).entries())
      .map(([regime, rows]) => ({
        regime,
        samples: rows.length,
        byDay: HORIZONS.map((day) => summarizeByDay(rows, day, regime)),
        reboundFailure: summarizeReboundFailure(rows, regime)
      })),
    failures
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});