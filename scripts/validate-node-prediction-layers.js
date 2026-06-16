'use strict';

const fs = require('fs');
const path = require('path');

const { runBacktestForSymbol } = require('../src/core/backtestEngine');
const { buildNodePredictionAnalysis } = require('../src/core/xwbNodePredictionEngine');
const structureService = require('../src/core/nodeStructurePredictionService');
const observation = require('../src/core/observationContextService');
const validationService = require('../src/core/nodePredictionValidationService');
const marketEnvironment = require('../src/core/marketEnvironmentService');
const { buildMarketGraphFromSeed } = require('../src/marketGraph/marketGraphBuilder');
const supplyChainService = require('../src/services/marketSupplyChainSeedService');

const DEFAULT_SYMBOLS = [
  '600519',
  '000858',
  '300750',
  '002594',
  '601318'
];

function parseArgs(argv) {
  const args = {};

  argv.slice(2).forEach((item) => {
    const match = String(item || '').match(/^--([^=]+)=(.*)$/);

    if (match) {
      args[match[1]] = match[2];
    }
  });

  return args;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const text = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;

  return fallback;
}

function toNumber(value, fallback = null) {
  return validationService.toNumber(value, fallback);
}

function formatPct(value, digits = 2) {
  const number = toNumber(value);
  if (!Number.isFinite(number)) return '-';
  return `${number.toFixed(digits)}%`;
}

function normalizeSymbolArg(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(6, '0').slice(-6);
}

function normalizeDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;

  return text;
}

function getDailyStates(backtestResult) {
  return backtestResult
    && backtestResult.xwbStateAnalysis
    && Array.isArray(backtestResult.xwbStateAnalysis.dailyStates)
    ? backtestResult.xwbStateAnalysis.dailyStates
    : [];
}

function loadRelationGraphSafe() {
  try {
    return buildMarketGraphFromSeed({
      viewPreset: 'stockFocus',
      viewMode: 'stock',
      targetNodeCount: 1000,
      targetEdgeCount: 2000,
      maxThemeFocusStocks: 1000,
      maxThemeFocusEdges: 2000,
      hideNoise: true,
      hideWeak: false
    });
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      nodes: [],
      edges: []
    };
  }
}

function getSupplyChainForSymbol(symbol) {
  try {
    const stock = supplyChainService.queryStockSupplyChain(symbol, {
      maxChains: 100
    });

    const assignment = stock && Array.isArray(stock.assignments)
      ? stock.assignments[0]
      : null;
    const chainId = assignment ? String(assignment.chainId || '') : '';

    if (!chainId) {
      return { stock, assignment, chain: null };
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
  } catch (error) {
    return {
      stock: null,
      assignment: null,
      chain: null,
      error: error && error.message ? error.message : String(error)
    };
  }
}

async function buildObservationRefinementForNode(input) {
  const relationGraphOk = input.relationGraph && input.relationGraph.ok !== false;
  const supplyChainOk = input.supplyChain && input.supplyChain.chain;

  if (!relationGraphOk && !supplyChainOk) {
    return {
      ok: false,
      error: '关系图和产业链数据均不可用。'
    };
  }

  let context = observation.buildObservationContextFromInputs({
    code: input.symbol,
    clickedDate: input.clickedDate,
    currentResult: input.currentResult,
    relationGraph: relationGraphOk ? input.relationGraph : null,
    supplyChain: supplyChainOk ? input.supplyChain.chain : null,
    lookbackDays: input.lookbackDays,
    forwardDays: input.forwardDays,
    maxRelationStocks: input.maxRelationStocks,
    maxSupplyChainStocks: input.maxSupplyChainStocks
  });

  if (!context || !context.ok) {
    return context || {
      ok: false,
      error: '观察上下文生成失败。'
    };
  }

  context = await observation.hydrateObservationRelatedStockMatrix(context, {
    runBacktestForSymbol,
    startDate: input.startDate,
    endDate: input.endDate,
    batchLimit: input.batchLimit
  });

  const analysisWithContext = structureService.enrichNodePredictionWithObservationContext(
    input.nodePredictionAnalysis,
    context
  );

  const marketEnvironmentContext = marketEnvironment.buildMarketEnvironmentContext(context);

  return {
    ok: true,
    context,
    observationRefinement: analysisWithContext && analysisWithContext.observationRefinement
      ? analysisWithContext.observationRefinement
      : null,
    marketEnvironment: marketEnvironmentContext
  };
}

function formatSummaryForConsole(summary) {
  const item = summary || {};

  return {
    样本: item.sampleCount,
    类型验证样本: item.typeValidatedCount,
    类型成功率: formatPct(item.typeSuccessRate, 1),
    坏预测率: formatPct(item.badPredictionRate, 1),

    T3正收益率: formatPct(item.positiveRateT3, 1),
    T5正收益率: formatPct(item.positiveRateT5, 1),
    T10正收益率: formatPct(item.positiveRateT10, 1),
    T20正收益率: formatPct(item.positiveRateT20, 1),

    T3均值: formatPct(item.avgReturnT3),
    T5均值: formatPct(item.avgReturnT5),
    T10均值: formatPct(item.avgReturnT10),
    T20均值: formatPct(item.avgReturnT20),

    T3中位: formatPct(item.medianReturnT3),
    T5中位: formatPct(item.medianReturnT5),
    T10中位: formatPct(item.medianReturnT10),
    T20中位: formatPct(item.medianReturnT20),

    T3方向命中: formatPct(item.directionHitT3, 1),
    T5方向命中: formatPct(item.directionHitT5, 1),
    T10方向命中: formatPct(item.directionHitT10, 1),
    T20方向命中: formatPct(item.directionHitT20, 1),

    高置信样本: item.highConfidenceSampleCount,
    高置信类型成功率: formatPct(item.highConfidenceTypeSuccessRate, 1),
    高置信T5正收益率: formatPct(item.highConfidencePositiveRateT5, 1),

    低置信样本: item.lowConfidenceSampleCount,
    低置信类型成功率: formatPct(item.lowConfidenceTypeSuccessRate, 1),
    低置信T5正收益率: formatPct(item.lowConfidencePositiveRateT5, 1)
  };
}

function formatGroupRowsForConsole(rows, keyLabel) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    [keyLabel]: row.key,
    ...formatSummaryForConsole(row)
  }));
}

function groupRowsByCompositeKeys(rows, keyNames) {
  const map = new Map();
  const list = Array.isArray(rows) ? rows : [];
  const keys = Array.isArray(keyNames) ? keyNames : [];

  list.forEach((row) => {
    const key = keys
      .map((keyName) => `${keyName}=${String(row && row[keyName] || 'UNKNOWN')}`)
      .join(' / ');

    const bucket = map.get(key) || [];
    bucket.push(row);
    map.set(key, bucket);
  });

  return Array.from(map.entries())
    .map(([key, bucket]) => ({
      key,
      ...validationService.summarizeValidationRows(bucket)
    }))
    .sort((left, right) => {
      const leftModel = String(left.key || '');
      const rightModel = String(right.key || '');

      if (leftModel.includes('B_SINGLE') && !rightModel.includes('B_SINGLE')) return -1;
      if (!leftModel.includes('B_SINGLE') && rightModel.includes('B_SINGLE')) return 1;

      return Number(right.sampleCount || 0) - Number(left.sampleCount || 0);
    });
}

function formatCompositeRowsForConsole(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    分组: row.key,
    ...formatSummaryForConsole(row)
  }));
}

function ensureDir(dirPath) {
  if (dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJsonIfRequested(filePath, payload) {
  const out = String(filePath || '').trim();

  if (!out) return;

  ensureDir(path.dirname(out));
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[OUTPUT_JSON] ${out}`);
}

async function buildValidationRowsForSymbol(symbol, backtestResult, options, shared) {
  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];
  const dailyStates = getDailyStates(backtestResult);

  const warmup = Math.max(0, Number(options.warmup || 120));
  const step = Math.max(1, Number(options.step || 20));
  const max = Math.max(1, Number(options.max || 60));
  const forecastDays = Math.max(20, Number(options.forecastDays || 20));
  const maxSamples = Math.max(20, Number(options.maxSamples || 160));

  const jobs = [];

  for (let index = warmup; index < bars.length - forecastDays && jobs.length < max; index += step) {
    const bar = bars[index];

    if (!bar || !bar.date || !Number.isFinite(toNumber(bar.close))) {
      continue;
    }

    jobs.push({
      symbol,
      index,
      clickedDate: normalizeDate(bar.date)
    });
  }

  const allRows = [];

  // 故意顺序执行，别 Promise.all。
  // observation 会批量读关系股状态，并发会把 SQLite / 回测引擎打爆。
  for (const job of jobs) {
    const base = {
      symbol,
      index: job.index,
      clickedDate: job.clickedDate
    };

    let rawAnalysis = null;

    try {
      rawAnalysis = buildNodePredictionAnalysis({
        symbol,
        bars,
        dailyStates,
        clickedDate: job.clickedDate,
        forecastDays,
        maxSamples
      });
    } catch (error) {
      allRows.push({
        ...base,
        ok: false,
        modelType: 'error',
        error: error && error.message ? error.message : String(error)
      });
      continue;
    }

    if (!rawAnalysis || !rawAnalysis.ok) {
      allRows.push({
        ...base,
        ok: false,
        modelType: 'error',
        error: rawAnalysis && rawAnalysis.error ? rawAnalysis.error : 'node prediction failed'
      });
      continue;
    }

    const rawValidation = validationService.buildNodePredictionValidation({
      bars,
      clickedIndex: job.index,
      nodePredictionAnalysis: rawAnalysis,
      modelType: 'raw'
    });

    allRows.push(validationService.flattenValidationRow({
      ...base,
      ok: true,
      modelName: 'A_RAW_SINGLE'
    }, rawValidation));

    if (options.withObservation) {
      let structureAnalysis = rawAnalysis;
      let observationStatus = 'NOT_READY';
      let observationError = '';
      let marketEnvironmentContext = null;
      let marketStatus = 'NOT_READY';
      let marketError = '';

      try {
        const observationResult = await buildObservationRefinementForNode({
          symbol,
          clickedDate: job.clickedDate,
          currentResult: backtestResult,
          nodePredictionAnalysis: rawAnalysis,
          relationGraph: shared.relationGraph,
          supplyChain: shared.supplyChain,
          startDate: options.start,
          endDate: options.end,
          lookbackDays: options.lookbackDays,
          forwardDays: options.forwardDays,
          maxRelationStocks: options.maxRelationStocks,
          maxSupplyChainStocks: options.maxSupplyChainStocks,
          batchLimit: options.batchLimit
        });

        if (observationResult && observationResult.ok && observationResult.observationRefinement) {
          structureAnalysis = {
            ...rawAnalysis,
            observationRefinement: observationResult.observationRefinement
          };
          observationStatus = 'OK';

          if (observationResult.marketEnvironment && observationResult.marketEnvironment.ok) {
            marketEnvironmentContext = observationResult.marketEnvironment;
            marketStatus = 'OK';
          } else {
            marketStatus = 'FAILED';
            marketError = observationResult.marketEnvironment && observationResult.marketEnvironment.error
              ? observationResult.marketEnvironment.error
              : 'marketEnvironment not ready';
          }
        } else {
          observationStatus = 'FAILED';
          observationError = observationResult && observationResult.error
            ? observationResult.error
            : 'observation refinement not ready';
        }
      } catch (error) {
        observationStatus = 'FAILED';
        observationError = error && error.message ? error.message : String(error);
        marketStatus = 'FAILED';
        marketError = observationError;
      }

      const structureValidation = validationService.buildNodePredictionValidation({
        bars,
        clickedIndex: job.index,
        nodePredictionAnalysis: structureAnalysis,
        modelType: 'structure'
      });

      allRows.push(validationService.flattenValidationRow({
        ...base,
        ok: true,
        modelName: 'B_SINGLE_PLUS_RELATION_SUPPLY',
        observationStatus,
        observationError
      }, structureValidation));

      if (marketEnvironmentContext && marketEnvironmentContext.ok) {
        const marketAnalysis = {
          ...structureAnalysis,
          marketEnvironment: marketEnvironmentContext
        };

        const marketValidation = validationService.buildNodePredictionValidation({
          bars,
          clickedIndex: job.index,
          nodePredictionAnalysis: marketAnalysis,
          modelType: 'market'
        });

        allRows.push(validationService.flattenValidationRow({
          ...base,
          ok: true,
          modelName: 'C_SINGLE_PLUS_RELATION_SUPPLY_MARKET',
          observationStatus,
          observationError,
          marketStatus,
          marketError,
          marketRegime: marketEnvironmentContext.regime || '',
          marketBias: marketEnvironmentContext.bias || '',
          marketTitle: marketEnvironmentContext.title || '',
          marketOneLine: marketEnvironmentContext.oneLine || ''
        }, marketValidation));
      } else {
        allRows.push({
          ...base,
          ok: true,
          modelName: 'C_SINGLE_PLUS_RELATION_SUPPLY_MARKET',
          modelType: 'market',
          predictionKind: 'NOT_READY',
          validationStatus: 'NOT_READY',
          validationSuccess: null,
          validationReason: marketError || 'marketContext 生成失败。',
          observationStatus,
          observationError,
          marketStatus,
          marketError
        });
      }
    } else {
      allRows.push({
        ...base,
        ok: true,
        modelName: 'C_SINGLE_PLUS_RELATION_SUPPLY_MARKET',
        modelType: 'market',
        predictionKind: 'NOT_READY',
        validationStatus: 'NOT_READY',
        validationSuccess: null,
        validationReason: 'withObservation 未开启，C 层无法生成。'
      });
    }
  }

  return allRows;
}

async function validateSymbol(symbol, options, globalShared) {
  console.log(`\n[SYMBOL_START] ${symbol}`);

  const backtestResult = await runBacktestForSymbol({
    symbol,
    startDate: options.start,
    endDate: options.end,
    refresh: false,
    cacheOnly: true,
    sourceMode: 'sqlite_cache_only'
  });

  const bars = Array.isArray(backtestResult && backtestResult.priceSeries)
    ? backtestResult.priceSeries
    : [];

  const shared = {
    relationGraph: globalShared.relationGraph,
    supplyChain: getSupplyChainForSymbol(symbol)
  };

  const rows = await buildValidationRowsForSymbol(symbol, backtestResult, options, shared);
  const validRows = rows.filter((row) => {
    return row
      && row.ok
      && row.modelType !== 'error'
      && row.predictionKind !== 'NOT_READY'
      && row.validationStatus !== 'NOT_READY';
  });
  const errorRows = rows.filter((row) => row && row.ok === false);

  console.log(`[SYMBOL_DATA] ${symbol} bars=${bars.length} first=${bars[0] ? bars[0].date : '-'} last=${bars[bars.length - 1] ? bars[bars.length - 1].date : '-'} rows=${rows.length} valid=${validRows.length} errors=${errorRows.length}`);

  const byModel = validationService.groupValidationRows(validRows, 'modelName');
  console.log(`[SYMBOL_BY_MODEL] ${symbol}`);
  console.table(formatGroupRowsForConsole(byModel, '模型'));

  const byPredictionKind = validationService.groupValidationRows(validRows, 'predictionKind');
  console.log(`[SYMBOL_BY_PREDICTION_KIND] ${symbol}`);
  console.table(formatGroupRowsForConsole(byPredictionKind, '预判类型'));

  const byModelConfidence = groupRowsByCompositeKeys(validRows, ['modelName', 'confidenceBand']);
  console.log(`[SYMBOL_BY_MODEL_CONFIDENCE] ${symbol}`);
  console.table(formatCompositeRowsForConsole(byModelConfidence));

  return {
    symbol,
    rows,
    validRows,
    errorRows,
    byModel,
    byPredictionKind,
    byModelConfidence
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const symbols = String(args.symbols || '')
    .split(',')
    .map(normalizeSymbolArg)
    .filter(Boolean);

  const options = {
    symbols: symbols.length ? symbols : DEFAULT_SYMBOLS,
    start: args.start || '20180101',
    end: args.end || '20260601',
    step: Number(args.step || 20),
    max: Number(args.max || 60),
    warmup: Number(args.warmup || 120),
    forecastDays: Number(args.forecastDays || 20),
    maxSamples: Number(args.maxSamples || 160),

    withObservation: boolArg(args.withObservation, true),

    lookbackDays: Number(args.lookbackDays || 20),
    forwardDays: Number(args.forwardDays || 20),
    maxRelationStocks: Number(args.maxRelationStocks || 120),
    maxSupplyChainStocks: Number(args.maxSupplyChainStocks || 300),
    batchLimit: Number(args.batchLimit || 20),

    outputJson: args.outputJson || ''
  };

  console.log('[NODE_PREDICTION_LAYER_VALIDATION_OPTIONS]');
  console.log(JSON.stringify(options, null, 2));

  const relationGraph = loadRelationGraphSafe();

  if (!relationGraph || relationGraph.ok === false) {
    console.log('[RELATION_GRAPH_STATUS] FAILED');
    console.log(relationGraph && relationGraph.error ? relationGraph.error : '关系图加载失败');
  } else {
    console.log('[RELATION_GRAPH_STATUS] OK');
  }

  const globalShared = { relationGraph };

  const allRows = [];
  const failures = [];

  for (const symbol of options.symbols) {
    try {
      const result = await validateSymbol(symbol, options, globalShared);
      allRows.push(...result.rows);
    } catch (error) {
      const message = error && error.stack ? error.stack : String(error);
      failures.push({ symbol, error: message });
      console.error(`[SYMBOL_FAIL] ${symbol}`);
      console.error(message);
    }
  }

  const validRows = allRows.filter((row) => {
    return row
      && row.ok
      && row.modelType !== 'error'
      && row.predictionKind !== 'NOT_READY'
      && row.validationStatus !== 'NOT_READY';
  });

  const byModel = validationService.groupValidationRows(validRows, 'modelName');
  const byPredictionKind = validationService.groupValidationRows(validRows, 'predictionKind');
  const byConfidence = validationService.groupValidationRows(validRows, 'confidenceBand');
  const byModelConfidence = groupRowsByCompositeKeys(validRows, ['modelName', 'confidenceBand']);
  const byStructureType = validationService.groupValidationRows(
    validRows.filter((row) => row.modelType === 'structure'),
    'structureType'
  );

  const byMarketRegime = validationService.groupValidationRows(
    validRows.filter((row) => row.modelType === 'market'),
    'marketRegime'
  );

  console.log('\n[TOTAL_BY_MODEL]');
  console.table(formatGroupRowsForConsole(byModel, '模型'));

  console.log('\n[TOTAL_BY_PREDICTION_KIND]');
  console.table(formatGroupRowsForConsole(byPredictionKind, '预判类型'));

  console.log('\n[TOTAL_BY_MODEL_CONFIDENCE]');
  console.table(formatCompositeRowsForConsole(byModelConfidence));

  console.log('\n[TOTAL_STRUCTURE_BY_TYPE]');
  console.table(formatGroupRowsForConsole(byStructureType, '结构类型'));

  console.log('\n[TOTAL_MARKET_BY_REGIME]');
  console.table(formatGroupRowsForConsole(byMarketRegime, '市场态'));

  console.log('\n[FAILURES]');
  console.table(failures);

  const payload = {
    options,
    generatedAt: new Date().toISOString(),
    rows: allRows,
    failures,
    summary: {
      byModel,
      byPredictionKind,
      byConfidence,
      byStructureType,
      byMarketRegime
    }
  };

  writeJsonIfRequested(options.outputJson, payload);

  console.log('\n[NODE_PREDICTION_LAYER_VALIDATION_DONE]');
  console.log(JSON.stringify({
    symbols: options.symbols.length,
    rows: allRows.length,
    validRows: validRows.length,
    failures: failures.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});