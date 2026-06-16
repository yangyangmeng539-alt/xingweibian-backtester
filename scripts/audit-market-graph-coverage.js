'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMarketGraph,
  loadRelationSeed
} = require('../src/marketGraph/marketGraphBuilder');
const {
  loadHongKongStockUniverse,
  getHongKongStockUniversePath
} = require('../src/data/hkStockUniverseService');
const {
  CACHE_DB_PATH,
  runSqliteDiskCacheBridge
} = require('../src/core/sqliteDiskCacheBridge');
const {
  loadSupplyChainSeed
} = require('../src/services/marketSupplyChainSeedService');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const A_UNIVERSE_PATH = path.join(PROJECT_ROOT, 'data', 'universe', 'stock-universe.json');
const HK_UNIVERSE_PATH = getHongKongStockUniversePath();
const MARKET_GRAPH_DIR = path.join(PROJECT_ROOT, 'data', 'market-graph');
const RELATION_RAW_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-raw.seed.json');
const CROSS_RELATION_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-relation.seed.json');
const SUPPLY_CHAIN_BASE_PATH = path.join(MARKET_GRAPH_DIR, 'stock-supply-chain.v2.seed.json');
const CROSS_SUPPLY_CHAIN_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-supply-chain.seed.json');
const AUDIT_DIR = path.join(MARKET_GRAPH_DIR, 'audit');
const AUDIT_VERSION = 'dev-0.1.9.x+1-market-graph-coverage-audit';
const OUTPUT_FILES = {
  report: 'market-graph-coverage-report.json',
  missing: 'market-graph-coverage-missing.json',
  details: 'market-graph-coverage-details.jsonl'
};
const LEGACY_OUTPUT_FILES = [
  'market-graph-isolated-stocks.json',
  'relation-isolated-stocks.json',
  'supply-chain-missing-stocks.json',
  'full-missing-stocks.json',
  'hk-missing-stocks.json',
  'a-missing-stocks.json'
];
const STOCK_FOCUS_OPTIONS = {
  viewPreset: 'stockFocus',
  hideNoise: true,
  hideWeak: false,
  showBoards: true,
  showStyleRegion: true,
  labelMode: 'important',
  maxConceptsPerStock: 5,
  maxPlatesPerStock: 3,
  minEdgeWeight: 0,
  maxThemeOverviewNodes: 80,
  maxThemeOverviewEdges: 120,
  minSharedStockCount: 2,
  maxThemeFocusStocks: 80,
  maxThemeFocusRelatedThemes: 20,
  maxThemeFocusEdges: 120
};
const LAYER_LABELS = {
  upstream: '上游',
  midstream: '中游',
  downstream: '下游',
  service: '配套服务',
  terminal: '终端'
};

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少审计输入文件: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function normalizeMarket(value) {
  return String(value || '').trim().toUpperCase();
}

function isHongKongMarket(value) {
  return ['HK', 'HKEX', 'HKG'].includes(normalizeMarket(value));
}

function normalizeStockCode(value, market = '') {
  const raw = String(value || '').trim().toUpperCase().replace(/^STOCK:/, '');

  if (!raw) {
    return '';
  }

  if (raw.startsWith('HK:')) {
    const digits = raw.slice(3).replace(/\D/g, '');
    return digits ? `HK:${digits.padStart(5, '0').slice(-5)}` : '';
  }

  if (/^HK\d{1,5}$/.test(raw)) {
    return `HK:${raw.slice(2).padStart(5, '0')}`;
  }

  if (/^\d{1,5}\.HK$/.test(raw)) {
    return `HK:${raw.replace(/\.HK$/, '').padStart(5, '0')}`;
  }

  const digits = raw.replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  if (isHongKongMarket(market) || digits.length === 5) {
    return `HK:${digits.padStart(5, '0').slice(-5)}`;
  }

  return digits.padStart(6, '0').slice(-6);
}

function marketGroupForCode(code) {
  return String(code || '').startsWith('HK:') ? 'HK' : 'CN_A';
}

function mergeStockPool(aUniverse, hkUniverse, cacheIndex, relationSeed, supplyChainSeed) {
  const pool = new Map();
  const relationItems = relationSeed.items || {};
  const supplyIndex = supplyChainSeed.stockIndex || {};

  function upsert(input, source) {
    const code = normalizeStockCode(input && (input.symbol || input.code), input && input.market);

    if (!code) {
      return;
    }

    const existing = pool.get(code) || {
      symbol: code,
      name: '',
      market: marketGroupForCode(code),
      exchange: '',
      sources: new Set(),
      cacheBarCount: 0
    };
    const name = String(input && input.name || '').trim();

    if (name && (!existing.name || source !== 'daily_bars')) {
      existing.name = name;
    }

    if (input && input.exchange && !existing.exchange) {
      existing.exchange = String(input.exchange);
    }

    existing.sources.add(source);
    existing.cacheBarCount = Math.max(
      existing.cacheBarCount,
      Number(input && input.barCount) || 0
    );
    pool.set(code, existing);
  }

  (aUniverse.stocks || []).forEach((stock) => upsert(stock, 'a_stock_universe'));
  (hkUniverse.stocks || []).forEach((stock) => upsert(stock, 'hk_stock_universe'));

  Object.values(cacheIndex.items || {})
    .filter((item) => String(item && item.symbol || '').startsWith('HK:'))
    .forEach((item) => upsert(item, 'daily_bars'));

  for (const stock of pool.values()) {
    const relationItem = relationItems[stock.symbol] || {};
    const supplyItem = supplyIndex[stock.symbol] || {};

    if (!stock.name) {
      stock.name = String(
        relationItem.displayName
        || relationItem.name
        || supplyItem.name
        || stock.symbol
      ).replace(/（HK）$/, '');
    }
  }

  return Array.from(pool.values())
    .map((stock) => ({
      ...stock,
      hasCachedBars: stock.cacheBarCount > 0,
      sources: Array.from(stock.sources).sort()
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function buildStockFocusRelationCoverage(relationSeed, code) {
  const item = relationSeed.items && relationSeed.items[code];
  const singleStockSeed = {
    ...relationSeed,
    items: item ? { [code]: item } : {},
    total: item ? 1 : 0,
    done: item && item.status === 'DONE' ? 1 : 0,
    failed: item && item.status === 'FAILED' ? 1 : 0
  };
  const graph = buildMarketGraph(singleStockSeed, {
    ...STOCK_FOCUS_OPTIONS,
    focusCode: code
  });
  const stockNodeId = `stock:${code}`;
  const hasRelationNode = (graph.nodes || []).some((node) => node && node.id === stockNodeId);
  const directEdges = (graph.edges || []).filter((edge) => (
    edge && (edge.source === stockNodeId || edge.target === stockNodeId)
  ));
  const neighborIds = new Set(directEdges.map((edge) => (
    edge.source === stockNodeId ? edge.target : edge.source
  )).filter(Boolean));
  const relationNodeIds = new Set((graph.nodes || [])
    .filter((node) => neighborIds.has(node.id) && node.type !== 'stock')
    .map((node) => node.id));
  const relationEdgeCount = directEdges.length;
  const relationNeighborCount = neighborIds.size;

  return {
    hasRelationNode,
    relationNodeCount: relationNodeIds.size,
    relationEdgeCount,
    relationNeighborCount,
    isRelationIsolated: hasRelationNode && (relationEdgeCount === 0 || relationNeighborCount === 0)
  };
}

function buildSupplyChainIndex(seed) {
  const index = new Map();

  Object.entries(seed.stockIndex || {}).forEach(([key, stock]) => {
    const code = normalizeStockCode(stock && (stock.code || stock.symbol) || key, stock && stock.market);

    if (code) {
      index.set(code, stock || {});
    }
  });

  return index;
}

function getPrimaryAssignment(stock) {
  const assignments = stock && Array.isArray(stock.assignments) ? stock.assignments : [];

  return assignments.find((assignment) => (
    assignment
    && typeof assignment === 'object'
    && (assignment.chainId || assignment.chainName)
    && (assignment.layer || assignment.layerKey)
  )) || null;
}

function classifyMissingType(relationCoverage, hasSupplyChain) {
  const relationCovered = relationCoverage.hasRelationNode
    && relationCoverage.relationEdgeCount > 0
    && relationCoverage.relationNeighborCount > 0;

  if (!relationCovered && !hasSupplyChain) {
    return 'full_missing';
  }

  if (!relationCoverage.hasRelationNode) {
    return 'relation_missing';
  }

  if (relationCoverage.isRelationIsolated) {
    return 'relation_isolated';
  }

  if (!hasSupplyChain) {
    return 'supply_chain_missing';
  }

  return 'none';
}

function isRelationCovered(row) {
  return row.hasRelationNode
    && row.relationEdgeCount > 0
    && row.relationNeighborCount > 0;
}

function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

function summarizeMarket(rows) {
  const relationCovered = rows.filter(isRelationCovered).length;
  const relationIsolated = rows.filter((row) => row.isRelationIsolated).length;
  const supplyChainCovered = rows.filter((row) => row.hasSupplyChain).length;
  const fullMissing = rows.filter((row) => row.missingType === 'full_missing').length;

  return {
    total: rows.length,
    relationCovered,
    relationIsolated,
    relationCoverageRate: percentage(relationCovered, rows.length),
    supplyChainCovered,
    supplyChainCoverageRate: percentage(supplyChainCovered, rows.length),
    fullMissing
  };
}

function countRows(rows) {
  const byMarket = {
    CN_A: summarizeMarket(rows.filter((row) => row.market === 'CN_A')),
    HK: summarizeMarket(rows.filter((row) => row.market === 'HK'))
  };
  const relationCovered = rows.filter(isRelationCovered).length;
  const relationIsolated = rows.filter((row) => row.isRelationIsolated).length;
  const supplyChainCovered = rows.filter((row) => row.hasSupplyChain).length;
  const supplyChainMissing = rows.filter((row) => !row.hasSupplyChain).length;
  const fullMissing = rows.filter((row) => row.missingType === 'full_missing').length;

  return {
    total: rows.length,
    byMarket,
    relationCovered,
    relationIsolated,
    relationCoverageRate: percentage(relationCovered, rows.length),
    supplyChainCovered,
    allMarketSupplyChainCovered: supplyChainCovered,
    supplyChainMissing,
    supplyChainCoverageRate: percentage(supplyChainCovered, rows.length),
    fullMissing
  };
}

function makeSummary(rows) {
  const counts = countRows(rows);

  return {
    total: counts.total,
    relationCovered: counts.relationCovered,
    relationIsolated: counts.relationIsolated,
    relationCoverageRate: counts.relationCoverageRate,
    supplyChainCovered: counts.supplyChainCovered,
    allMarketSupplyChainCovered: counts.allMarketSupplyChainCovered,
    supplyChainMissing: counts.supplyChainMissing,
    supplyChainCoverageRate: counts.supplyChainCoverageRate,
    fullMissing: counts.fullMissing,
    markets: counts.byMarket,
    byMarket: counts.byMarket
  };
}

function compactStockRow(row) {
  return {
    market: row.market,
    symbol: row.symbol,
    code: row.code || row.symbol,
    name: row.name,
    hasRelationNode: row.hasRelationNode,
    relationEdgeCount: row.relationEdgeCount,
    relationNeighborCount: row.relationNeighborCount,
    isRelationIsolated: row.isRelationIsolated,
    hasSupplyChain: row.hasSupplyChain,
    primaryChain: row.primaryChain,
    secondaryChain: row.secondaryChain,
    layerKey: row.layerKey,
    layerLabel: row.layerLabel,
    missingType: row.missingType
  };
}

function makeMissingReport(generatedAt, sources, definitions, summary, rows) {
  const fullMissingRows = rows.filter((row) => row.missingType === 'full_missing').map(compactStockRow);
  const relationMissingRows = rows.filter((row) => !isRelationCovered(row)).map(compactStockRow);
  const supplyChainMissingRows = rows.filter((row) => !row.hasSupplyChain).map(compactStockRow);
  const anyMissingRows = rows.filter((row) => row.missingType !== 'none').map(compactStockRow);

  function group(list, market) {
    return list.filter((row) => row.market === market);
  }

  return {
    version: AUDIT_VERSION,
    generatedAt,
    mode: 'read-only',
    sources,
    definitions: {
      relationMissing: '未达到 relationCovered：不存在当前股票节点，或直接边/一跳邻居为 0。',
      supplyChainMissing: '没有有效产业链 assignment。',
      fullMissing: definitions.fullMissing
    },
    summary: {
      total: summary.total,
      byMarket: summary.byMarket,
      relationMissing: relationMissingRows.length,
      supplyChainMissing: supplyChainMissingRows.length,
      fullMissing: fullMissingRows.length,
      anyMissing: anyMissingRows.length
    },
    fullMissing: fullMissingRows,
    relationMissing: relationMissingRows,
    supplyChainMissing: supplyChainMissingRows,
    missingByMarket: {
      CN_A: {
        fullMissing: group(fullMissingRows, 'CN_A'),
        relationMissing: group(relationMissingRows, 'CN_A'),
        supplyChainMissing: group(supplyChainMissingRows, 'CN_A'),
        anyMissing: group(anyMissingRows, 'CN_A')
      },
      HK: {
        fullMissing: group(fullMissingRows, 'HK'),
        relationMissing: group(relationMissingRows, 'HK'),
        supplyChainMissing: group(supplyChainMissingRows, 'HK'),
        anyMissing: group(anyMissingRows, 'HK')
      }
    }
  };
}

function makeCheck(name, pass, expected, actual, details = '') {
  return {
    name,
    pass: Boolean(pass),
    expected,
    actual,
    details
  };
}

function sameCountSubset(left, right, keys) {
  return keys.every((key) => left[key] === right[key]);
}

function makeInMemoryChecks(rows, summary, missingReport) {
  const counts = countRows(rows);
  const keys = ['total', 'relationCovered', 'relationIsolated', 'supplyChainCovered', 'supplyChainMissing', 'fullMissing'];
  const checks = [
    makeCheck(
      'summary_matches_rows',
      sameCountSubset(summary, counts, keys)
        && summary.byMarket.CN_A.total === counts.byMarket.CN_A.total
        && summary.byMarket.HK.total === counts.byMarket.HK.total,
      {
        total: counts.total,
        CN_A: counts.byMarket.CN_A.total,
        HK: counts.byMarket.HK.total,
        relationCovered: counts.relationCovered,
        supplyChainCovered: counts.supplyChainCovered,
        fullMissing: counts.fullMissing
      },
      {
        total: summary.total,
        CN_A: summary.byMarket.CN_A.total,
        HK: summary.byMarket.HK.total,
        relationCovered: summary.relationCovered,
        supplyChainCovered: summary.supplyChainCovered,
        fullMissing: summary.fullMissing
      }
    ),
    makeCheck(
      'missing_report_filters_match_rows',
      missingReport.fullMissing.length === rows.filter((row) => row.missingType === 'full_missing').length
        && missingReport.relationMissing.length === rows.filter((row) => !isRelationCovered(row)).length
        && missingReport.supplyChainMissing.length === rows.filter((row) => !row.hasSupplyChain).length,
      {
        fullMissing: rows.filter((row) => row.missingType === 'full_missing').length,
        relationMissing: rows.filter((row) => !isRelationCovered(row)).length,
        supplyChainMissing: rows.filter((row) => !row.hasSupplyChain).length
      },
      {
        fullMissing: missingReport.fullMissing.length,
        relationMissing: missingReport.relationMissing.length,
        supplyChainMissing: missingReport.supplyChainMissing.length
      }
    ),
    makeCheck(
      'market_split_matches_total',
      summary.byMarket.CN_A.total + summary.byMarket.HK.total === summary.total,
      summary.total,
      summary.byMarket.CN_A.total + summary.byMarket.HK.total
    )
  ];

  return checks;
}

function recountDetailsJsonl(filePath) {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const rows = content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));

  return countRows(rows);
}

function makeDetailsRecountCheck(summary, detailCounts) {
  return makeCheck(
    'details_jsonl_recount_matches_report',
    summary.total === detailCounts.total
      && summary.byMarket.CN_A.total === detailCounts.byMarket.CN_A.total
      && summary.byMarket.HK.total === detailCounts.byMarket.HK.total
      && summary.relationCovered === detailCounts.relationCovered
      && summary.supplyChainCovered === detailCounts.supplyChainCovered
      && summary.fullMissing === detailCounts.fullMissing,
    {
      total: summary.total,
      CN_A: summary.byMarket.CN_A.total,
      HK: summary.byMarket.HK.total,
      relationCovered: summary.relationCovered,
      supplyChainCovered: summary.supplyChainCovered,
      fullMissing: summary.fullMissing
    },
    {
      total: detailCounts.total,
      CN_A: detailCounts.byMarket.CN_A.total,
      HK: detailCounts.byMarket.HK.total,
      relationCovered: detailCounts.relationCovered,
      supplyChainCovered: detailCounts.supplyChainCovered,
      fullMissing: detailCounts.fullMissing
    }
  );
}

function makeSampleValidation(rows, sampleSymbols = ['600519', 'HK:02498']) {
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));

  return sampleSymbols
    .filter((symbol) => bySymbol.has(symbol))
    .map((symbol) => {
      const row = bySymbol.get(symbol);
      const relationCoverage = buildStockFocusRelationCoverage(loadRelationSeed(RELATION_RAW_PATH), symbol);
      const pass = row.hasRelationNode === relationCoverage.hasRelationNode
        && row.relationEdgeCount === relationCoverage.relationEdgeCount
        && row.relationNeighborCount === relationCoverage.relationNeighborCount;

      return makeCheck(
        `stock_focus_sample_${symbol}`,
        pass,
        {
          hasRelationNode: row.hasRelationNode,
          relationEdgeCount: row.relationEdgeCount,
          relationNeighborCount: row.relationNeighborCount
        },
        {
          hasRelationNode: relationCoverage.hasRelationNode,
          relationEdgeCount: relationCoverage.relationEdgeCount,
          relationNeighborCount: relationCoverage.relationNeighborCount
        },
        `${row.name || symbol} 逐股复用 UI stockFocus 构图口径抽样验证。`
      );
    });
}

function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, lines ? `${lines}\n` : '', 'utf8');
}

function removeLegacyReports(outputDir) {
  LEGACY_OUTPUT_FILES.forEach((fileName) => {
    const filePath = path.join(outputDir, fileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
}

function makeReport(generatedAt, sources, definitions, summary, outputPaths, checks, sampleValidation, inputStats) {
  const outputFiles = Object.fromEntries(Object.entries(outputPaths).map(([key, filePath]) => [
    key,
    relativePath(filePath)
  ]));

  return {
    version: AUDIT_VERSION,
    generatedAt,
    mode: 'read-only',
    sources,
    definitions,
    outputFiles,
    total: summary.total,
    sqliteTotal: inputStats.sqliteTotal,
    universeTotal: inputStats.universeTotal,
    aUniverseTotal: inputStats.aUniverseTotal,
    hkUniverseTotal: inputStats.hkUniverseTotal,
    byMarket: summary.byMarket,
    relationCovered: summary.relationCovered,
    relationIsolated: summary.relationIsolated,
    relationCoverageRate: summary.relationCoverageRate,
    supplyChainCovered: summary.supplyChainCovered,
    allMarketSupplyChainCovered: summary.allMarketSupplyChainCovered,
    supplyChainMissing: summary.supplyChainMissing,
    supplyChainCoverageRate: summary.supplyChainCoverageRate,
    fullMissing: summary.fullMissing,
    summary,
    checks: {
      pass: checks.every((check) => check.pass),
      items: checks
    },
    sampleValidation: {
      pass: sampleValidation.every((check) => check.pass),
      items: sampleValidation
    }
  };
}

function formatRate(value) {
  return value === null ? 'N/A' : `${value.toFixed(2)}%`;
}

function printSummary(summary) {
  console.log(`total: ${summary.total}`);
  console.log(`relationCovered: ${summary.relationCovered}`);
  console.log(`relationIsolated: ${summary.relationIsolated}`);
  console.log(`supplyChainCovered: ${summary.supplyChainCovered}`);
  console.log(`supplyChainMissing: ${summary.supplyChainMissing}`);
  console.log(`fullMissing: ${summary.fullMissing}`);

  for (const market of ['CN_A', 'HK']) {
    const group = summary.markets[market];
    console.log(
      `${market}: total=${group.total}, relationCovered=${group.relationCovered}, `
      + `relationIsolated=${group.relationIsolated}, supplyChainCovered=${group.supplyChainCovered}, `
      + `fullMissing=${group.fullMissing}, relationCoverageRate=${formatRate(group.relationCoverageRate)}, `
      + `supplyChainCoverageRate=${formatRate(group.supplyChainCoverageRate)}`
    );
  }
}

async function runAudit(options = {}) {
  const outputDir = path.resolve(options.outputDir || AUDIT_DIR);
  const outputPaths = Object.fromEntries(Object.entries(OUTPUT_FILES).map(([key, file]) => [
    key,
    path.join(outputDir, file)
  ]));
  const aUniverse = readJson(A_UNIVERSE_PATH);
  const hkUniverse = loadHongKongStockUniverse();
  const rawRelationSeed = readJson(RELATION_RAW_PATH);
  const crossRelationSeed = readJson(CROSS_RELATION_PATH);
  const baseSupplyChainSeed = readJson(SUPPLY_CHAIN_BASE_PATH);
  const crossSupplyChainSeed = readJson(CROSS_SUPPLY_CHAIN_PATH);
  const supplyChainSeed = loadSupplyChainSeed({ forceReload: true });
  const cacheIndex = await runSqliteDiskCacheBridge('build-index-summary', {
    dbPath: CACHE_DB_PATH
  });
  const relationSeed = loadRelationSeed(RELATION_RAW_PATH);
  const stockPool = mergeStockPool(
    aUniverse,
    hkUniverse,
    cacheIndex,
    relationSeed,
    supplyChainSeed
  );
  const supplyChainIndex = buildSupplyChainIndex(supplyChainSeed);

  const rows = stockPool.map((stock) => {
    const relationCoverage = buildStockFocusRelationCoverage(relationSeed, stock.symbol);
    const supplyChainStock = supplyChainIndex.get(stock.symbol);
    const assignment = getPrimaryAssignment(supplyChainStock);
    const hasSupplyChain = Boolean(assignment);
    const layerKey = assignment ? String(assignment.layer || assignment.layerKey || '') : '';

    return {
      symbol: stock.symbol,
      code: stock.symbol,
      name: stock.name,
      market: stock.market,
      hasCachedBars: stock.hasCachedBars,
      universeSources: stock.sources,
      hasRelationNode: relationCoverage.hasRelationNode,
      relationNodeCount: relationCoverage.relationNodeCount,
      relationEdgeCount: relationCoverage.relationEdgeCount,
      relationNeighborCount: relationCoverage.relationNeighborCount,
      isRelationIsolated: relationCoverage.isRelationIsolated,
      hasSupplyChain,
      primaryChain: assignment
        ? String(assignment.parentName || assignment.parentId || '')
        : '',
      secondaryChain: assignment
        ? String(assignment.chainName || assignment.chainId || '')
        : '',
      layerKey,
      layerLabel: assignment
        ? String(assignment.layerName || assignment.layerLabel || LAYER_LABELS[layerKey] || layerKey)
        : '',
      missingType: classifyMissingType(relationCoverage, hasSupplyChain)
    };
  });
  const summary = makeSummary(rows);
  const generatedAt = new Date().toISOString();
  const hkCacheSymbols = Object.keys(cacheIndex.items || {}).filter((symbol) => symbol.startsWith('HK:'));
  const sources = {
    aStockUniverse: {
      path: relativePath(A_UNIVERSE_PATH),
      version: String(aUniverse.version || ''),
      stockCount: Array.isArray(aUniverse.stocks) ? aUniverse.stocks.length : 0,
      updatedAt: String(aUniverse.updatedAt || '')
    },
    hkStockUniverse: {
      path: relativePath(HK_UNIVERSE_PATH),
      version: String(hkUniverse.version || ''),
      stockCount: Array.isArray(hkUniverse.stocks) ? hkUniverse.stocks.length : 0,
      updatedAt: String(hkUniverse.updatedAt || '')
    },
    dailyBars: {
      path: relativePath(CACHE_DB_PATH),
      query: "SELECT symbol FROM daily_bars WHERE symbol LIKE 'HK:%' GROUP BY symbol",
      indexedSymbolCount: Number(cacheIndex.indexedSymbols) || Object.keys(cacheIndex.items || {}).length,
      hkSymbolCount: hkCacheSymbols.length
    },
    relationRaw: {
      path: relativePath(RELATION_RAW_PATH),
      version: String(rawRelationSeed.version || ''),
      generatedAt: String(rawRelationSeed.generatedAt || '')
    },
    crossMarketRelation: {
      path: relativePath(CROSS_RELATION_PATH),
      version: String(crossRelationSeed.version || ''),
      generatedAt: String(crossRelationSeed.generatedAt || '')
    },
    supplyChainBase: {
      path: relativePath(SUPPLY_CHAIN_BASE_PATH),
      version: String(baseSupplyChainSeed.version || ''),
      generatedAt: String(baseSupplyChainSeed.generatedAt || ''),
      stockCount: Object.keys(baseSupplyChainSeed.stockIndex || {}).length
    },
    crossMarketSupplyChain: {
      path: relativePath(CROSS_SUPPLY_CHAIN_PATH),
      version: String(crossSupplyChainSeed.version || ''),
      generatedAt: String(crossSupplyChainSeed.generatedAt || ''),
      stockCount: Object.keys(crossSupplyChainSeed.stockIndex || {}).length
    },
    supplyChainMerged: {
      path: 'src/services/marketSupplyChainSeedService.loadSupplyChainSeed()',
      version: String(supplyChainSeed.version || ''),
      generatedAt: String(supplyChainSeed.generatedAt || ''),
      stockCount: Object.keys(supplyChainSeed.stockIndex || {}).length
    }
  };
  const definitions = {
    auditPool: 'A股 stock-universe、港股 hk-stock-universe、daily_bars 中 HK:% symbol 的并集。',
    relationGraph: '逐股使用 marketGraphBuilder 的 stockFocus 构图参数，统计当前股票节点的直接边与一跳邻居。',
    relationCovered: '存在当前股票节点，且直接边数量和一跳邻居数量均大于 0。',
    relationIsolated: '当前股票节点存在，但直接边或一跳邻居数量为 0。',
    supplyChainCovered: '产业链使用前端同口径 loadSupplyChainSeed()，即 stock-supply-chain.v2.seed.json 与 cross-market-supply-chain.seed.json 合并后，stockIndex 中至少存在一条包含 chain 与 layer 的有效 assignment。',
    fullMissing: '既没有 UI stockFocus 关系覆盖，也没有产业链归属。'
  };
  const inputStats = {
    sqliteTotal: Number(cacheIndex.indexedSymbols) || Object.keys(cacheIndex.items || {}).length,
    universeTotal: (Array.isArray(aUniverse.stocks) ? aUniverse.stocks.length : 0)
      + (Array.isArray(hkUniverse.stocks) ? hkUniverse.stocks.length : 0),
    aUniverseTotal: Array.isArray(aUniverse.stocks) ? aUniverse.stocks.length : 0,
    hkUniverseTotal: Array.isArray(hkUniverse.stocks) ? hkUniverse.stocks.length : 0,
    hkCacheSymbolCount: hkCacheSymbols.length
  };
  const missingReport = makeMissingReport(generatedAt, sources, definitions, summary, rows);
  const inMemoryChecks = makeInMemoryChecks(rows, summary, missingReport);
  const sampleValidation = makeSampleValidation(rows);

  fs.mkdirSync(outputDir, { recursive: true });
  removeLegacyReports(outputDir);
  writeJsonl(outputPaths.details, rows);

  const detailCounts = recountDetailsJsonl(outputPaths.details);
  const checks = [
    ...inMemoryChecks,
    makeDetailsRecountCheck(summary, detailCounts)
  ];
  const report = makeReport(
    generatedAt,
    sources,
    definitions,
    summary,
    outputPaths,
    checks,
    sampleValidation,
    inputStats
  );

  writeJson(outputPaths.report, report);
  writeJson(outputPaths.missing, missingReport);

  printSummary(summary);
  console.log(`outputs: ${Object.values(outputPaths).map(relativePath).join(', ')}`);
  console.log(`checks: ${report.checks.pass ? 'PASS' : 'FAIL'}`);
  console.log(`sampleValidation: ${report.sampleValidation.pass ? 'PASS' : 'FAIL'}`);

  return {
    summary,
    paths: outputPaths,
    stockPoolCount: stockPool.length,
    checks: report.checks,
    sampleValidation: report.sampleValidation
  };
}

if (require.main === module) {
  runAudit().catch((error) => {
    console.error(`全市场关系图/产业链覆盖审计失败: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runAudit,
  normalizeStockCode,
  mergeStockPool,
  buildStockFocusRelationCoverage,
  classifyMissingType,
  summarizeMarket
};
