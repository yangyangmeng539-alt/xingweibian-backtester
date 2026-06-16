const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');
const structure = require('../src/core/nodeStructurePredictionService');
const observation = require('../src/core/observationContextService');
const marketEnvironment = require('../src/core/marketEnvironmentService');
const { buildMarketGraphFromSeed } = require('../src/marketGraph/marketGraphBuilder');
const supplyChainService = require('../src/services/marketSupplyChainSeedService');

function parseArgs(argv) {
  const out = {};

  for (const item of argv) {
    const match = String(item || '').match(/^--([^=]+)=(.*)$/);

    if (match) {
      out[match[1]] = match[2];
    }
  }

  return out;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value, digits = 2) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  const number = Number(value);

  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '-';
}

function average(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!list.length) {
    return null;
  }

  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (!list.length) {
    return null;
  }

  const mid = Math.floor(list.length / 2);

  return list.length % 2
    ? list[mid]
    : (list[mid - 1] + list[mid]) / 2;
}

function direction(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return '';
  }

  if (number > 0) {
    return 'UP';
  }

  if (number < 0) {
    return 'DOWN';
  }

  return 'FLAT';
}

function directionHit(forecast, actual) {
  if (!Number.isFinite(Number(forecast)) || !Number.isFinite(Number(actual))) {
    return null;
  }

  const forecastDirection = direction(forecast);
  const actualDirection = direction(actual);

  return Boolean(
    forecastDirection
    && actualDirection
    && forecastDirection !== 'FLAT'
    && actualDirection !== 'FLAT'
    && forecastDirection === actualDirection
  );
}

function getActualReturnPctFromBars(bars, currentIndex, day) {
  const offset = Number(day);

  if (!Array.isArray(bars) || !Number.isInteger(currentIndex) || !Number.isFinite(offset)) {
    return null;
  }

  const currentBar = bars[currentIndex];
  const futureBar = bars[currentIndex + offset];

  const currentClose = toNumber(currentBar && currentBar.close);
  const futureClose = toNumber(futureBar && futureBar.close);

  if (!Number.isFinite(currentClose) || !Number.isFinite(futureClose) || currentClose <= 0) {
    return null;
  }

  return (futureClose / currentClose - 1) * 100;
}

function getDailyStates(backtestResult) {
  return backtestResult
    && backtestResult.xwbStateAnalysis
    && Array.isArray(backtestResult.xwbStateAnalysis.dailyStates)
    ? backtestResult.xwbStateAnalysis.dailyStates
    : [];
}

function getForecastMilestone(nodePredictionAnalysis, day) {
  const key = `d${Number(day)}`;
  const milestones = nodePredictionAnalysis && nodePredictionAnalysis.forecastMilestones
    ? nodePredictionAnalysis.forecastMilestones
    : {};

  if (milestones[key]) {
    return milestones[key];
  }

  const stats = Array.isArray(nodePredictionAnalysis && nodePredictionAnalysis.futurePathStats)
    ? nodePredictionAnalysis.futurePathStats
    : [];

  return stats.find((item) => Number(item && item.day) === Number(day)) || {};
}

function getRawForecastPct(nodePredictionAnalysis, day) {
  const item = getForecastMilestone(nodePredictionAnalysis, day);

  return toNumber(item && item.medianReturnPct);
}

function getStructureForecastPct(nodePredictionAnalysis, day) {
  const rawForecast = getRawForecastPct(nodePredictionAnalysis, day);

  if (!Number.isFinite(Number(rawForecast))) {
    return null;
  }

  return structure.getStructureAdjustedForecastReturnPct(
    nodePredictionAnalysis,
    Number(day),
    rawForecast,
    'median'
  );
}

function getActualPct(nodePredictionAnalysis, day) {
  const targetDay = Number(day);
  const key = `d${targetDay}`;

  const pathSummary = nodePredictionAnalysis && nodePredictionAnalysis.actualPathSummary
    ? nodePredictionAnalysis.actualPathSummary
    : {};
  const milestones = pathSummary && pathSummary.milestones
    ? pathSummary.milestones
    : {};

  if (milestones[key]) {
    return toNumber(milestones[key].returnPct);
  }

  const comparison = nodePredictionAnalysis && nodePredictionAnalysis.actualComparison
    ? nodePredictionAnalysis.actualComparison
    : {};
  const legacy = comparison[key];

  if (legacy && legacy.hasActual) {
    return toNumber(legacy.actualReturnPct);
  }

  const actualFuturePath = Array.isArray(nodePredictionAnalysis && nodePredictionAnalysis.actualFuturePath)
    ? nodePredictionAnalysis.actualFuturePath
    : [];

  const exact = actualFuturePath.find((item) => Number(item && item.day) === targetDay);

  if (exact) {
    const exactReturn = toNumber(
      exact.returnPct !== undefined
        ? exact.returnPct
        : exact.actualReturnPct
    );

    if (Number.isFinite(exactReturn)) {
      return exactReturn;
    }
  }

  const nearby = actualFuturePath
    .map((item) => ({
      item,
      day: Number(item && item.day)
    }))
    .filter((entry) => Number.isFinite(entry.day) && entry.day >= targetDay)
    .sort((left, right) => left.day - right.day)[0];

  if (nearby && nearby.item) {
    const nearbyReturn = toNumber(
      nearby.item.returnPct !== undefined
        ? nearby.item.returnPct
        : nearby.item.actualReturnPct
    );

    if (Number.isFinite(nearbyReturn)) {
      return nearbyReturn;
    }
  }

  return null;
}

function getPathFields(nodePredictionAnalysis) {
  const pathSummary = nodePredictionAnalysis && nodePredictionAnalysis.actualPathSummary
    ? nodePredictionAnalysis.actualPathSummary
    : {};

  if (!pathSummary || !pathSummary.ok) {
    return {
      actualPathType: '路径不足',
      actualMaxUpPct: null,
      actualMaxUpDay: null,
      actualMaxDownPct: null,
      actualMaxDownDay: null
    };
  }

  return {
    actualPathType: String(pathSummary.pathType || '未知路径'),
    actualMaxUpPct: toNumber(pathSummary.maxUpPct),
    actualMaxUpDay: toNumber(pathSummary.maxUpDay),
    actualMaxDownPct: toNumber(pathSummary.maxDownPct),
    actualMaxDownDay: toNumber(pathSummary.maxDownDay)
  };
}

function getChainForSymbol(symbol) {
  const stock = supplyChainService.queryStockSupplyChain(symbol, {
    maxChains: 100
  });

  const assignment = stock && Array.isArray(stock.assignments)
    ? stock.assignments[0]
    : null;

  const chainId = assignment ? String(assignment.chainId || '') : '';

  if (!chainId) {
    return {
      stock,
      assignment,
      chain: null
    };
  }

  return {
    stock,
    assignment,
    chain: supplyChainService.queryChain(chainId, {
      layerLimits: {
        upstream: 20000,
        midstream: 20000,
        downstream: 20000,
        service: 20000,
        terminal: 20000
      }
    })
  };
}

async function buildContextForDate(input) {
  let context = observation.buildObservationContextFromInputs({
    code: input.symbol,
    clickedDate: input.clickedDate,
    currentResult: input.currentResult,
    relationGraph: input.relationGraph,
    supplyChain: input.chain,
    lookbackDays: 20,
    forwardDays: 20,
    maxRelationStocks: 120,
    maxSupplyChainStocks: 300
  });

  context = await observation.hydrateObservationRelatedStockMatrix(context, {
    runBacktestForSymbol,
    startDate: input.startDate,
    endDate: input.endDate,
    batchLimit: input.batchLimit
  });

  return context;
}

function classifyRapidChange(row) {
  const d3 = toNumber(row && row.actualD3Pct);
  const d5 = toNumber(row && row.actualD5Pct);
  const d10 = toNumber(row && row.actualD10Pct);
  const d20 = toNumber(row && row.actualD20Pct);
  const maxUp = toNumber(row && row.actualMaxUpPct);
  const maxDown = toNumber(row && row.actualMaxDownPct);

  const hasD3 = Number.isFinite(d3);
  const hasD5 = Number.isFinite(d5);
  const hasD10 = Number.isFinite(d10);
  const hasD20 = Number.isFinite(d20);

  if (!hasD3 && !hasD5 && !hasD10 && !hasD20) {
    return {
      rapidType: 'NO_ACTUAL_PATH',
      rapidTitle: '无真实路径',
      rapidSignal: 'unknown',
      rapidScore: 0
    };
  }

  if (
    hasD3 && hasD5 && hasD20
    && d3 >= 3
    && d5 >= 5
    && d20 < 0
  ) {
    return {
      rapidType: 'FAST_TAKE_PROFIT_DECAY',
      rapidTitle: '急拉后回落',
      rapidSignal: 'take_profit',
      rapidScore: 5
    };
  }

  if (
    hasD3 && hasD5 && hasD10
    && d3 <= -3
    && d5 <= -5
    && d10 <= -5
  ) {
    return {
      rapidType: 'FAST_BREAKDOWN',
      rapidTitle: '急杀确认',
      rapidSignal: 'danger',
      rapidScore: -5
    };
  }

  if (
    hasD3 && hasD5 && hasD20
    && d3 <= -3
    && d5 <= -3
    && d20 > 3
  ) {
    return {
      rapidType: 'KILL_THEN_REPAIR',
      rapidTitle: '先杀后修',
      rapidSignal: 'repair',
      rapidScore: 4
    };
  }

  if (
    Number.isFinite(maxUp)
    && Number.isFinite(maxDown)
    && hasD20
    && maxUp >= 6
    && d20 <= 1
  ) {
    return {
      rapidType: 'INTRADAY_WINDOW_ONLY',
      rapidTitle: '窗口短促',
      rapidSignal: 'short_window',
      rapidScore: 3
    };
  }

  if (
    hasD3 && hasD5 && hasD10 && hasD20
    && d3 > 0
    && d5 > 0
    && d10 > 0
    && d20 > 0
  ) {
    return {
      rapidType: 'FAST_TREND_EXTEND',
      rapidTitle: '急启延续',
      rapidSignal: 'trend',
      rapidScore: 5
    };
  }

  if (
    hasD3 && hasD5 && hasD10 && hasD20
    && d3 < 0
    && d5 < 0
    && d10 < 0
    && d20 < 0
  ) {
    return {
      rapidType: 'SLOW_BLEED',
      rapidTitle: '持续走弱',
      rapidSignal: 'danger',
      rapidScore: -4
    };
  }

  if (
    hasD3 && hasD5 && hasD10 && hasD20
    && Math.abs(d3) <= 1.5
    && Math.abs(d5) <= 2.5
    && d10 > 0
    && d20 > 3
  ) {
    return {
      rapidType: 'SLOW_START_EXTEND',
      rapidTitle: '慢启动延续',
      rapidSignal: 'trend',
      rapidScore: 4
    };
  }

  if (
    hasD3 && hasD5 && hasD10 && hasD20
    && d3 > 0
    && d5 > 0
    && d10 < 0
    && d20 < 0
  ) {
    return {
      rapidType: 'REBOUND_DECAY',
      rapidTitle: '反抽衰减',
      rapidSignal: 'decay',
      rapidScore: -2
    };
  }

  if (
    hasD3
    && d3 >= 3
  ) {
    return {
      rapidType: 'D3_FAST_UP',
      rapidTitle: 'D3急拉',
      rapidSignal: 'fast_up',
      rapidScore: 2
    };
  }

  if (
    hasD3
    && d3 <= -3
  ) {
    return {
      rapidType: 'D3_FAST_DOWN',
      rapidTitle: 'D3急杀',
      rapidSignal: 'fast_down',
      rapidScore: -2
    };
  }

  return {
    rapidType: 'NORMAL_DRIFT',
    rapidTitle: '普通漂移',
    rapidSignal: 'neutral',
    rapidScore: 0
  };
}

function hitRate(rows, fieldName, actualFieldName) {
  const valid = rows.filter((row) => {
    return Number.isFinite(Number(row[actualFieldName]))
      && typeof row[fieldName] === 'boolean';
  });

  if (!valid.length) {
    return null;
  }

  return valid.filter((row) => row[fieldName]).length / valid.length * 100;
}

function summarizeRows(rows) {
  const valid = rows.filter((row) => Number.isFinite(Number(row.actualD20Pct)));

  return [{
    样本: rows.length,
    有真实D20: valid.length,

    历史D3均值: formatPct(average(valid.map((row) => row.historyD3Pct))),
    结构D3均值: formatPct(average(valid.map((row) => row.structureD3Pct))),
    真实D3均值: formatPct(average(valid.map((row) => row.actualD3Pct))),

    历史D5均值: formatPct(average(valid.map((row) => row.historyD5Pct))),
    结构D5均值: formatPct(average(valid.map((row) => row.structureD5Pct))),
    真实D5均值: formatPct(average(valid.map((row) => row.actualD5Pct))),

    历史D10均值: formatPct(average(valid.map((row) => row.historyD10Pct))),
    结构D10均值: formatPct(average(valid.map((row) => row.structureD10Pct))),
    真实D10均值: formatPct(average(valid.map((row) => row.actualD10Pct))),

    历史D20均值: formatPct(average(valid.map((row) => row.historyD20Pct))),
    结构D20均值: formatPct(average(valid.map((row) => row.structureD20Pct))),
    真实D20均值: formatPct(average(valid.map((row) => row.actualD20Pct))),
    真实D20中位: formatPct(median(valid.map((row) => row.actualD20Pct))),

    最大上冲均值: formatPct(average(valid.map((row) => row.actualMaxUpPct))),
    最大回撤均值: formatPct(average(valid.map((row) => row.actualMaxDownPct))),

    rawD3命中: formatPct(hitRate(valid, 'rawD3Hit', 'actualD3Pct'), 1),
    结构D3命中: formatPct(hitRate(valid, 'structureD3Hit', 'actualD3Pct'), 1),

    rawD5命中: formatPct(hitRate(valid, 'rawD5Hit', 'actualD5Pct'), 1),
    结构D5命中: formatPct(hitRate(valid, 'structureD5Hit', 'actualD5Pct'), 1),

    rawD10命中: formatPct(hitRate(valid, 'rawD10Hit', 'actualD10Pct'), 1),
    结构D10命中: formatPct(hitRate(valid, 'structureD10Hit', 'actualD10Pct'), 1),

    rawD20命中: formatPct(hitRate(valid, 'rawD20Hit', 'actualD20Pct'), 1),
    结构D20命中: formatPct(hitRate(valid, 'structureD20Hit', 'actualD20Pct'), 1)
  }];
}

function summarizeBy(rows, key, labelName) {
  const map = new Map();

  rows.forEach((row) => {
    const groupKey = String(row[key] || 'UNKNOWN');
    const group = map.get(groupKey) || [];

    group.push(row);
    map.set(groupKey, group);
  });

  return Array.from(map.entries()).map(([name, group]) => {
    const valid = group.filter((row) => Number.isFinite(Number(row.actualD20Pct)));

    return {
      [labelName]: name,
      样本: group.length,

      真实D3均值: formatPct(average(valid.map((row) => row.actualD3Pct))),
      真实D5均值: formatPct(average(valid.map((row) => row.actualD5Pct))),
      真实D10均值: formatPct(average(valid.map((row) => row.actualD10Pct))),
      真实D20均值: formatPct(average(valid.map((row) => row.actualD20Pct))),
      真实D20中位: formatPct(median(valid.map((row) => row.actualD20Pct))),

      最大上冲均值: formatPct(average(valid.map((row) => row.actualMaxUpPct))),
      最大回撤均值: formatPct(average(valid.map((row) => row.actualMaxDownPct))),

    rawD3命中: formatPct(hitRate(valid, 'rawD3Hit', 'actualD3Pct'), 1),
    结构D3命中: formatPct(hitRate(valid, 'structureD3Hit', 'actualD3Pct'), 1),

    rawD5命中: formatPct(hitRate(valid, 'rawD5Hit', 'actualD5Pct'), 1),
    结构D5命中: formatPct(hitRate(valid, 'structureD5Hit', 'actualD5Pct'), 1),

    rawD10命中: formatPct(hitRate(valid, 'rawD10Hit', 'actualD10Pct'), 1),
    结构D10命中: formatPct(hitRate(valid, 'structureD10Hit', 'actualD10Pct'), 1),

    rawD20命中: formatPct(hitRate(valid, 'rawD20Hit', 'actualD20Pct'), 1),
    结构D20命中: formatPct(hitRate(valid, 'structureD20Hit', 'actualD20Pct'), 1)
    };
  }).sort((left, right) => right.样本 - left.样本);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbol = String(args.symbol || '600519').replace(/\D/g, '').padStart(6, '0').slice(-6);
  const startDate = String(args.start || '20180101');
  const endDate = String(args.end || '20260601');
  const step = Math.max(1, Number(args.step || 10));
  const max = Math.max(1, Number(args.max || 120));
  const warmup = Math.max(0, Number(args.warmup || 120));
  const forecastDays = Math.max(1, Number(args.forecastDays || 20));
  const maxSamples = Math.max(1, Number(args.samples || 160));
  const batchLimit = Math.max(1, Number(args.batch || 80));

  console.log('[RUN_PATH_VALIDATION]', {
    symbol,
    startDate,
    endDate,
    step,
    max,
    warmup,
    forecastDays,
    maxSamples,
    batchLimit
  });

  const currentResult = await runBacktestForSymbol({
    symbol,
    startDate,
    endDate,
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only',
    forecastDays,
    maxSamples
  });

  const bars = Array.isArray(currentResult && currentResult.priceSeries)
    ? currentResult.priceSeries
    : [];
  const dailyStates = getDailyStates(currentResult);

  console.log('[CURRENT_DATA]', {
    bars: bars.length,
    dailyStates: dailyStates.length,
    first: bars[0] ? bars[0].date : '',
    last: bars[bars.length - 1] ? bars[bars.length - 1].date : ''
  });

  const relationGraph = buildMarketGraphFromSeed({
    viewPreset: 'stockFocus',
    focusCode: symbol,
    hideNoise: true,
    hideWeak: true,
    showBoards: false,
    showStyleRegion: false,
    maxConceptsPerStock: 20,
    maxPlatesPerStock: 20
  });

  const chainPack = getChainForSymbol(symbol);

  console.log('[CONTEXT_SOURCE]', {
    relationGraphNodes: Array.isArray(relationGraph && relationGraph.nodes) ? relationGraph.nodes.length : 0,
    relationGraphEdges: Array.isArray(relationGraph && relationGraph.edges) ? relationGraph.edges.length : 0,
    supplyFound: Boolean(chainPack.stock && chainPack.stock.found),
    chainId: chainPack.assignment ? chainPack.assignment.chainId : '',
    chainFound: Boolean(chainPack.chain && chainPack.chain.found)
  });

  const rows = [];
  const errors = [];

  for (let index = warmup; index < bars.length && rows.length + errors.length < max; index += step) {
    const bar = bars[index];
    const clickedDate = bar && bar.date;

    if (!clickedDate) {
      continue;
    }

    try {
      const raw = buildNodePredictionAnalysis({
        bars,
        dailyStates,
        clickedDate,
        forecastDays,
        maxSamples
      });

      const context = await buildContextForDate({
        symbol,
        clickedDate,
        currentResult,
        relationGraph,
        chain: chainPack.chain,
        startDate,
        endDate,
        batchLimit
      });

      const enrichedBase = structure.enrichNodePredictionWithObservationContext(raw, context);
      const env = marketEnvironment.buildMarketEnvironmentContext(context);
      const enriched = {
        ...predictionSafeNode,
        observationMatrixStatus: context && context.related && context.related.matrixStatus
          ? { ...context.related.matrixStatus }
          : null,
        observationRefinement,
        marketEnvironment
      };

      const refinement = enriched && enriched.observationRefinement
        ? enriched.observationRefinement
        : null;

      const row = {
        symbol,
        index,
        date: clickedDate,
        close: toNumber(bar.close),

        structureType: refinement && refinement.type ? refinement.type : '',
        structureTitle: refinement && refinement.title ? refinement.title : '',
        tone: refinement && refinement.tone ? refinement.tone : '',

        marketRegime: env && env.ok ? env.regime : '',
        marketTitle: env && env.ok ? env.title : '',
        marketBias: env && env.ok ? env.bias : '',

        matrixLoaded: context && context.related && context.related.matrixStatus ? context.related.matrixStatus.loaded : null,
        matrixTotal: context && context.related && context.related.matrixStatus ? context.related.matrixStatus.total : null,

        historyD3Pct: getRawForecastPct(enriched, 3),
        structureD3Pct: getStructureForecastPct(enriched, 3),
        actualD3Pct: getActualReturnPctFromBars(bars, index, 3),

        historyD5Pct: getRawForecastPct(enriched, 5),
        structureD5Pct: getStructureForecastPct(enriched, 5),
        actualD5Pct: getActualReturnPctFromBars(bars, index, 5),

        historyD10Pct: getRawForecastPct(enriched, 10),
        structureD10Pct: getStructureForecastPct(enriched, 10),
        actualD10Pct: getActualReturnPctFromBars(bars, index, 10),

        historyD20Pct: getRawForecastPct(enriched, 20),
        structureD20Pct: getStructureForecastPct(enriched, 20),
        actualD20Pct: getActualReturnPctFromBars(bars, index, 20),

        ...getPathFields(enriched)
      };

      const rapidChange = classifyRapidChange(row);

        row.rapidType = rapidChange.rapidType;
        row.rapidTitle = rapidChange.rapidTitle;
        row.rapidSignal = rapidChange.rapidSignal;
        row.rapidScore = rapidChange.rapidScore;

      row.rawD3Hit = directionHit(row.historyD3Pct, row.actualD3Pct);
      row.structureD3Hit = directionHit(row.structureD3Pct, row.actualD3Pct);

      row.rawD5Hit = directionHit(row.historyD5Pct, row.actualD5Pct);
      row.structureD5Hit = directionHit(row.structureD5Pct, row.actualD5Pct);

      row.rawD10Hit = directionHit(row.historyD10Pct, row.actualD10Pct);
      row.structureD10Hit = directionHit(row.structureD10Pct, row.actualD10Pct);

      row.rawD20Hit = directionHit(row.historyD20Pct, row.actualD20Pct);
      row.structureD20Hit = directionHit(row.structureD20Pct, row.actualD20Pct);

      rows.push(row);

      console.log(
        `[${rows.length + errors.length}/${max}] ${clickedDate} ${row.structureTitle}/${row.structureType} env=${row.marketTitle}/${row.marketRegime} ` +
        `rawD3=${formatPct(row.historyD3Pct)} structD3=${formatPct(row.structureD3Pct)} actualD3=${formatPct(row.actualD3Pct)} ` +
        `rawD5=${formatPct(row.historyD5Pct)} structD5=${formatPct(row.structureD5Pct)} actualD5=${formatPct(row.actualD5Pct)} ` +
        `rawD10=${formatPct(row.historyD10Pct)} structD10=${formatPct(row.structureD10Pct)} actualD10=${formatPct(row.actualD10Pct)} ` +
        `rawD20=${formatPct(row.historyD20Pct)} structD20=${formatPct(row.structureD20Pct)} actualD20=${formatPct(row.actualD20Pct)} ` +
        `maxUp=${formatPct(row.actualMaxUpPct)} maxDown=${formatPct(row.actualMaxDownPct)} path=${row.actualPathType} rapid=${row.rapidTitle}/${row.rapidType} ` +
        `rawHit=${row.rawD20Hit} structHit=${row.structureD20Hit}`
      );
    } catch (error) {
      const message = error && error.stack ? error.stack : String(error);

      errors.push({
        index,
        date: clickedDate,
        error: message
      });

      console.log(`[ERROR] ${clickedDate} ${message}`);
    }
  }

  console.log('\n[PATH_VALIDATION_SUMMARY]');
  console.table(summarizeRows(rows));

  console.log('\n[PATH_VALIDATION_BY_STRUCTURE_TYPE]');
  console.table(summarizeBy(rows, 'structureType', '结构类型'));

  console.log('\n[PATH_VALIDATION_BY_MARKET_REGIME]');
  console.table(summarizeBy(rows, 'marketRegime', '市场环境'));

  console.log('\n[PATH_VALIDATION_BY_ACTUAL_PATH]');
  console.table(summarizeBy(rows, 'actualPathType', '真实路径'));

  console.log('\n[PATH_VALIDATION_BY_RAPID_CHANGE]');
  console.table(summarizeBy(rows, 'rapidType', '急变类型'));

  console.log('\n[PATH_VALIDATION_ROWS]');
  console.table(rows);

  if (errors.length) {
    console.log('\n[PATH_VALIDATION_ERRORS]');
    console.table(errors);
  }
}

main().catch((error) => {
  console.error('[PATH_VALIDATION_FATAL]', error && error.stack ? error.stack : error);
  process.exit(1);
});