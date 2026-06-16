'use strict';

const DEFAULT_LOOKBACK_DAYS = 20;
const DEFAULT_FORWARD_DAYS = 20;
const DEFAULT_MAX_RELATION_STOCKS = 120;
const DEFAULT_MAX_SUPPLY_CHAIN_STOCKS = 220;
const DEFAULT_STATE_BATCH_LIMIT = 20;

const SUPPLY_CHAIN_LAYER_DEFS = [
  { key: 'upstream', label: '上游' },
  { key: 'midstream', label: '中游' },
  { key: 'downstream', label: '下游' },
  { key: 'service', label: '配套服务' },
  { key: 'channel', label: '渠道' },
  { key: 'unknown', label: '未知层级' }
];

const MARKET_GRAPH_STOCK_RELATION_TYPE_WEIGHTS = {
  industry: 6,
  theme: 5,
  concept: 4,
  other_board: 1.5,
  style_board: 1,
  region_board: 0.8,
  board: 1,
  stock: 0.6
};

function normalizeObservationStockCode(value) {
  const text = String(value || '').replace(/\D/g, '');
  return text.length >= 6 ? text.slice(-6) : '';
}

function normalizeTimelineDate(value) {
  const text = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }

  return '';
}

function getTimelineSeries(result) {
  if (Array.isArray(result && result.priceSeries)) {
    return result.priceSeries;
  }

  if (Array.isArray(result && result.bars)) {
    return result.bars;
  }

  if (Array.isArray(result && result.series)) {
    return result.series;
  }

  return [];
}

function getXwbDailyStates(result) {
  if (Array.isArray(result && result.xwbStateAnalysis && result.xwbStateAnalysis.dailyStates)) {
    return result.xwbStateAnalysis.dailyStates;
  }

  if (Array.isArray(result && result.dailyStates)) {
    return result.dailyStates;
  }

  return [];
}

function getDailyOpportunities(result) {
  if (Array.isArray(result && result.xwbStateAnalysis && result.xwbStateAnalysis.dailyOpportunities)) {
    return result.xwbStateAnalysis.dailyOpportunities;
  }

  if (Array.isArray(result && result.predictionAnalysis && result.predictionAnalysis.dailyOpportunities)) {
    return result.predictionAnalysis.dailyOpportunities;
  }

  if (Array.isArray(result && result.dailyOpportunities)) {
    return result.dailyOpportunities;
  }

  return [];
}

function normalizeLayer(layer) {
  const key = String(layer || '').trim();

  if (!key) {
    return 'unknown';
  }

  return key;
}

function getSupplyChainLayer(chain, layerKey) {
  const layers = chain && chain.layers ? chain.layers : {};
  const key = normalizeLayer(layerKey);

  return layers[key] || {
    key,
    name: key,
    stocks: []
  };
}

function addObservationStock(stockMap, stock, source, extra = {}) {
  const code = normalizeObservationStockCode(stock && (stock.code || stock.stockCode || stock.symbol || stock.id));

  if (!code) {
    return;
  }

  const existed = stockMap.get(code) || {
    code,
    name: stock.name || stock.label || stock.stockName || stock.shortName || code,
    market: stock.market || '',
    sources: [],
    relationTypes: [],
    relationLabels: [],
    relationScore: 0,
    relationStrength: '',
    layers: [],
    raw: []
  };

  if (!existed.name && stock.name) {
    existed.name = stock.name;
  }

  if (source && !existed.sources.includes(source)) {
    existed.sources.push(source);
  }

  if (Array.isArray(extra.relationTypes)) {
    extra.relationTypes.forEach((item) => {
      if (item && !existed.relationTypes.includes(item)) {
        existed.relationTypes.push(item);
      }
    });
  }

  if (Array.isArray(extra.relationLabels)) {
    extra.relationLabels.forEach((item) => {
      if (item && !existed.relationLabels.includes(item)) {
        existed.relationLabels.push(item);
      }
    });
  }

  if (Number.isFinite(Number(extra.relationScore))) {
    existed.relationScore = Math.max(Number(existed.relationScore || 0), Number(extra.relationScore));
  }

  if (extra.relationStrength) {
    existed.relationStrength = extra.relationStrength;
  }

  if (extra.layerKey) {
    const layerItem = {
      layerKey: extra.layerKey,
      layerLabel: extra.layerLabel || extra.layerKey,
      chainId: extra.chainId || '',
      chainName: extra.chainName || ''
    };

    const existsLayer = existed.layers.some((item) => {
      return item.layerKey === layerItem.layerKey && item.chainId === layerItem.chainId;
    });

    if (!existsLayer) {
      existed.layers.push(layerItem);
    }
  }

  existed.raw.push({
    source,
    extra,
    stock
  });

  stockMap.set(code, existed);
}

function buildObservationDateWindowFromBars(bars, clickedDate, options = {}) {
  const series = Array.isArray(bars) ? bars : [];
  const cleanDate = normalizeTimelineDate(clickedDate);
  const lookbackDays = Number(options.lookbackDays) >= 0
    ? Number(options.lookbackDays)
    : DEFAULT_LOOKBACK_DAYS;
  const forwardDays = Number(options.forwardDays) >= 0
    ? Number(options.forwardDays)
    : DEFAULT_FORWARD_DAYS;

  const dateIndex = new Map(series.map((item, index) => [
    normalizeTimelineDate(item && item.date),
    index
  ]));

  if (!cleanDate || !dateIndex.has(cleanDate)) {
    return [];
  }

  const centerIndex = dateIndex.get(cleanDate);
  const startIndex = Math.max(0, centerIndex - lookbackDays);
  const endIndex = Math.min(series.length - 1, centerIndex + forwardDays);

  return series.slice(startIndex, endIndex + 1).map((item, index) => {
    const absoluteIndex = startIndex + index;

    return {
      date: normalizeTimelineDate(item.date),
      offset: absoluteIndex - centerIndex,
      index: absoluteIndex
    };
  });
}

function buildCurrentStockTimelineFromBacktestResult(result, dateWindow) {
  const series = getTimelineSeries(result);
  const dailyStates = getXwbDailyStates(result);
  const dailyOpportunities = getDailyOpportunities(result);

  const closeByDate = new Map(series.map((item) => [
    normalizeTimelineDate(item && item.date),
    Number(item && item.close)
  ]));

  const stateByDate = new Map(dailyStates.map((item) => [
    normalizeTimelineDate(item && item.date),
    item
  ]));

  const opportunityByDate = new Map(dailyOpportunities.map((item) => [
    normalizeTimelineDate(item && item.date),
    item
  ]));

  return (Array.isArray(dateWindow) ? dateWindow : []).map((point) => {
    const date = normalizeTimelineDate(point.date);
    const dailyState = stateByDate.get(date) || null;
    const opportunity = opportunityByDate.get(date) || null;
    const close = closeByDate.has(date) ? closeByDate.get(date) : null;

    return {
      date,
      offset: point.offset,
      close: Number.isFinite(Number(close)) ? Number(close) : null,

      shapeType: dailyState && dailyState.shape ? dailyState.shape.type || '' : '',
      positionType: dailyState && dailyState.position ? dailyState.position.type || '' : '',
      changeType: dailyState && dailyState.change ? dailyState.change.type || '' : '',
      stateCode: dailyState ? dailyState.stateCode || '' : '',
      stateName: dailyState ? dailyState.stateName || '' : '',

      opportunityGrade: opportunity ? opportunity.opportunityGrade || '' : '',
      opportunityScore: opportunity ? opportunity.opportunityScore || null : null,
      riskLevel: opportunity ? opportunity.riskLevel || '' : '',
      actionBias: opportunity ? opportunity.actionBias || '' : '',

      stateStatus: dailyState ? 'loaded' : 'no_state_for_date'
    };
  });
}

function buildPendingRelatedStockTimeline(stock, dateWindow) {
  return (Array.isArray(dateWindow) ? dateWindow : []).map((point) => ({
    code: stock.code,
    date: point.date,
    offset: point.offset,
    stateStatus: 'pending_external_stock_state'
  }));
}

function buildRelatedStockTimelineFromBacktestResult(stock, dateWindow, result) {
  const timeline = buildCurrentStockTimelineFromBacktestResult(result, dateWindow);

  return timeline.map((point) => ({
    code: stock.code,
    name: stock.name || '',
    ...point
  }));
}

function findObservationMarketGraphStockNode(graph, code) {
  const normalizedCode = normalizeObservationStockCode(code);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];

  if (!normalizedCode) {
    return null;
  }

  return nodes.find((node) => {
    if (!node) {
      return false;
    }

    const nodeCode = normalizeObservationStockCode(node.code || node.stockCode || node.symbol || node.id);

    return node.type === 'stock' && nodeCode === normalizedCode;
  }) || null;
}

function getMarketGraphNodeStockCode(node) {
  if (!node) {
    return '';
  }

  return normalizeObservationStockCode(node.code || node.stockCode || node.symbol || node.id);
}

function getMarketGraphNodeStockName(node) {
  if (!node) {
    return '';
  }

  return String(node.label || node.name || node.stockName || node.shortName || node.code || '').trim();
}

function getMarketGraphRelationNodeLabel(node) {
  if (!node) {
    return '';
  }

  return String(node.label || node.name || node.conceptName || node.industryName || node.boardName || node.id || '').trim();
}

function getMarketGraphRelationNodeType(node) {
  if (!node) {
    return 'unknown';
  }

  const type = String(node.type || '').trim();

  if (type) {
    return type;
  }

  if (node.conceptCode) {
    return 'concept';
  }

  if (node.industryCode) {
    return 'industry';
  }

  if (node.plateCode || node.boardCode) {
    return 'board';
  }

  return 'unknown';
}

function getMarketGraphRelationTypeWeight(type) {
  const cleanType = String(type || '').trim();

  return MARKET_GRAPH_STOCK_RELATION_TYPE_WEIGHTS[cleanType] || 1;
}

function getMarketGraphEdgeWeight(edge) {
  const value = Number(edge && (edge.weight || edge.score || edge.strength));

  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return Math.max(0.25, Math.min(value, 3));
}

function getMarketGraphRelationMemberPenalty(memberCount) {
  const count = Math.max(1, Number(memberCount || 1));

  return Math.min(1, 8 / Math.sqrt(count));
}

function getMarketGraphRelationStrength(score) {
  const value = Number(score || 0);

  if (value >= 3.5) {
    return 'strong';
  }

  if (value >= 1.6) {
    return 'middle';
  }

  return 'weak';
}

function getMarketGraphRelationNodeInlineMembers(node) {
  if (!node || typeof node !== 'object') {
    return [];
  }

  return [
    ...(Array.isArray(node.memberStocks) ? node.memberStocks : []),
    ...(Array.isArray(node.memberStocksPreview) ? node.memberStocksPreview : []),
    ...(Array.isArray(node.sharedStocksPreview) ? node.sharedStocksPreview : []),
    ...(Array.isArray(node.stocks) ? node.stocks : []),
    ...(Array.isArray(node.stockMembers) ? node.stockMembers : [])
  ];
}

function getMarketGraphInlineStockCode(stock) {
  if (!stock) {
    return '';
  }

  if (typeof stock === 'string') {
    return normalizeObservationStockCode(stock);
  }

  return normalizeObservationStockCode(stock.code || stock.stockCode || stock.symbol || stock.id);
}

function getMarketGraphInlineStockName(stock) {
  if (!stock || typeof stock === 'string') {
    return '';
  }

  return String(stock.name || stock.label || stock.stockName || stock.shortName || '').trim();
}

function collectMarketGraphRelationMemberStocks(relationNode, nodeById, edges) {
  const relationNodeId = relationNode && relationNode.id;
  const members = new Map();

  if (!relationNodeId) {
    return [];
  }

  edges.forEach((edge) => {
    if (!edge || (edge.source !== relationNodeId && edge.target !== relationNodeId)) {
      return;
    }

    const otherId = edge.source === relationNodeId ? edge.target : edge.source;
    const other = nodeById.get(otherId);

    if (!other || other.type !== 'stock') {
      return;
    }

    const code = getMarketGraphNodeStockCode(other);

    if (!code) {
      return;
    }

    members.set(code, {
      code,
      name: getMarketGraphNodeStockName(other),
      source: 'edge_stock',
      edge
    });
  });

  getMarketGraphRelationNodeInlineMembers(relationNode).forEach((stock) => {
    const code = getMarketGraphInlineStockCode(stock);

    if (!code || members.has(code)) {
      return;
    }

    members.set(code, {
      code,
      name: getMarketGraphInlineStockName(stock),
      source: 'inline_member',
      edge: null
    });
  });

  return Array.from(members.values());
}

function addDerivedStockRelation(relationMap, stock, relationNode, relationScore, edgeToCurrent) {
  const code = normalizeObservationStockCode(stock && stock.code);

  if (!code) {
    return;
  }

  const relationType = getMarketGraphRelationNodeType(relationNode);
  const relationLabel = getMarketGraphRelationNodeLabel(relationNode);
  const existed = relationMap.get(code) || {
    code,
    name: stock.name || code,
    relationScore: 0,
    relationTypes: [],
    relationLabels: [],
    relationNodes: [],
    relationStrength: 'weak',
    sources: ['relation_derived']
  };

  if (!existed.name && stock.name) {
    existed.name = stock.name;
  }

  existed.relationScore += Number(relationScore || 0);

  if (relationType && !existed.relationTypes.includes(relationType)) {
    existed.relationTypes.push(relationType);
  }

  if (relationLabel && !existed.relationLabels.includes(relationLabel)) {
    existed.relationLabels.push(relationLabel);
  }

  existed.relationNodes.push({
    id: relationNode.id || '',
    type: relationType,
    label: relationLabel,
    score: relationScore,
    edgeWeight: getMarketGraphEdgeWeight(edgeToCurrent)
  });

  existed.relationStrength = getMarketGraphRelationStrength(existed.relationScore);

  relationMap.set(code, existed);
}

function buildStockStockRelationsForCode(code, graph) {
  const normalizedCode = normalizeObservationStockCode(code);
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const currentNode = findObservationMarketGraphStockNode(graph, normalizedCode);
  const relationMap = new Map();
  const relationNodeMap = new Map();
  const debug = {
    code: normalizedCode,
    nodes: nodes.length,
    edges: edges.length,
    currentStockNodeFound: Boolean(currentNode),
    currentNodeId: currentNode ? currentNode.id : '',
    connectedRelationNodes: 0,
    scannedRelationNodes: 0,
    derivedStocks: 0,
    relationSamples: []
  };

  if (!normalizedCode || !nodes.length || !edges.length) {
    return {
      stocks: [],
      debug
    };
  }

  if (currentNode) {
    edges.forEach((edge) => {
      if (!edge || (edge.source !== currentNode.id && edge.target !== currentNode.id)) {
        return;
      }

      const otherId = edge.source === currentNode.id ? edge.target : edge.source;
      const other = nodeById.get(otherId);

      if (!other || other.type === 'stock') {
        return;
      }

      relationNodeMap.set(other.id, {
        node: other,
        edgeToCurrent: edge,
        source: 'current_edge'
      });
    });
  }

  if (!relationNodeMap.size) {
    nodes.forEach((node) => {
      if (!node || node.type === 'stock') {
        return;
      }

      const members = collectMarketGraphRelationMemberStocks(node, nodeById, edges);
      const hasCurrent = members.some((stock) => normalizeObservationStockCode(stock.code) === normalizedCode);

      if (hasCurrent) {
        relationNodeMap.set(node.id, {
          node,
          edgeToCurrent: null,
          source: 'member_scan'
        });
      }
    });
  }

  debug.connectedRelationNodes = relationNodeMap.size;

  relationNodeMap.forEach(({ node, edgeToCurrent, source }) => {
    const members = collectMarketGraphRelationMemberStocks(node, nodeById, edges);
    const memberCount = Math.max(
      members.length,
      Number(node.memberStockCount || node.stockCount || node.count || 0),
      1
    );
    const relationType = getMarketGraphRelationNodeType(node);
    const baseWeight = getMarketGraphRelationTypeWeight(relationType);
    const edgeWeight = getMarketGraphEdgeWeight(edgeToCurrent);
    const memberPenalty = getMarketGraphRelationMemberPenalty(memberCount);
    const relationScore = baseWeight * edgeWeight * memberPenalty;

    debug.scannedRelationNodes += 1;

    if (debug.relationSamples.length < 10) {
      debug.relationSamples.push({
        id: node.id,
        type: relationType,
        label: getMarketGraphRelationNodeLabel(node),
        source,
        memberCount,
        baseWeight,
        memberPenalty,
        relationScore: Number(relationScore.toFixed(3))
      });
    }

    members.forEach((stock) => {
      const stockCode = normalizeObservationStockCode(stock.code);

      if (!stockCode || stockCode === normalizedCode) {
        return;
      }

      addDerivedStockRelation(relationMap, stock, node, relationScore, edgeToCurrent);
    });
  });

  const stocks = Array.from(relationMap.values())
    .map((stock) => ({
      ...stock,
      relationScore: Number(stock.relationScore.toFixed(4)),
      relationStrength: getMarketGraphRelationStrength(stock.relationScore)
    }))
    .sort((left, right) => {
      if (right.relationScore !== left.relationScore) {
        return right.relationScore - left.relationScore;
      }

      return String(left.code).localeCompare(String(right.code));
    });

  debug.derivedStocks = stocks.length;

  return {
    stocks,
    debug
  };
}

function getObservationMarketGraphCandidatesFromGraphs(code, graphs, options = {}) {
  const normalizedCode = normalizeObservationStockCode(code);
  const result = new Map();
  const graphList = (Array.isArray(graphs) ? graphs : [graphs]).filter(Boolean);
  const maxRelationStocks = Number(options.maxRelationStocks) > 0
    ? Number(options.maxRelationStocks)
    : DEFAULT_MAX_RELATION_STOCKS;

  if (!normalizedCode) {
    return [];
  }

  graphList.forEach((graph) => {
    const derived = buildStockStockRelationsForCode(normalizedCode, graph);

    derived.stocks.forEach((stock) => {
      addObservationStock(result, {
        code: stock.code,
        name: stock.name
      }, 'relation_derived', {
        relationTypes: stock.relationTypes,
        relationLabels: stock.relationLabels,
        relationScore: stock.relationScore,
        relationStrength: stock.relationStrength
      });
    });
  });

  result.delete(normalizedCode);

  return Array.from(result.values())
    .map((stock) => ({
      ...stock,
      relationScore: Number(stock.relationScore || 0),
      relationStrength: stock.relationStrength || getMarketGraphRelationStrength(stock.relationScore || 0)
    }))
    .sort((left, right) => {
      if (right.relationScore !== left.relationScore) {
        return right.relationScore - left.relationScore;
      }

      return String(left.code).localeCompare(String(right.code));
    })
    .slice(0, maxRelationStocks);
}

function getObservationSupplyChainCandidatesFromChain(code, chain, options = {}) {
  const normalizedCode = normalizeObservationStockCode(code);
  const result = new Map();
  const maxSupplyChainStocks = Number(options.maxSupplyChainStocks) > 0
    ? Number(options.maxSupplyChainStocks)
    : DEFAULT_MAX_SUPPLY_CHAIN_STOCKS;

  if (!normalizedCode || !chain || !chain.layers) {
    return {
      stocks: [],
      self: null
    };
  }

  let self = null;

  SUPPLY_CHAIN_LAYER_DEFS.forEach((def) => {
    const layer = getSupplyChainLayer(chain, def.key);
    const stocks = Array.isArray(layer.stocks) ? layer.stocks : [];

    stocks.forEach((stock) => {
      const stockCode = normalizeObservationStockCode(stock && stock.code);

      if (!stockCode) {
        return;
      }

      const layerExtra = {
        layerKey: def.key,
        layerLabel: def.label,
        chainId: chain.id || '',
        chainName: chain.name || ''
      };

      if (stockCode === normalizedCode) {
        self = {
          code: stockCode,
          name: stock.name || stock.label || stock.code || '',
          market: stock.market || '',
          confidence: stock.confidence,
          source: stock.source || '',
          matchedTerms: Array.isArray(stock.matchedTerms) ? stock.matchedTerms : [],
          ...layerExtra
        };
        return;
      }

      addObservationStock(result, stock, 'supply_chain', layerExtra);
    });
  });

  if (!self) {
    return {
      stocks: [],
      self: null
    };
  }

  return {
    stocks: Array.from(result.values()).slice(0, maxSupplyChainStocks),
    self
  };
}

function mergeObservationRelatedStocks(relationStocks, supplyChainStocks) {
  const merged = new Map();

  (Array.isArray(relationStocks) ? relationStocks : []).forEach((stock) => {
    addObservationStock(merged, stock, 'relation_context', {
      relationTypes: stock.relationTypes || [],
      relationLabels: stock.relationLabels || [],
      relationScore: stock.relationScore || 0,
      relationStrength: stock.relationStrength || ''
    });
  });

  (Array.isArray(supplyChainStocks) ? supplyChainStocks : []).forEach((stock) => {
    const layer = stock.layers && stock.layers[0] ? stock.layers[0] : {};

    addObservationStock(merged, stock, 'supply_chain_context', {
      layerKey: layer.layerKey || '',
      layerLabel: layer.layerLabel || '',
      chainId: layer.chainId || '',
      chainName: layer.chainName || ''
    });
  });

  return Array.from(merged.values());
}

function buildObservationContextFromInputs(input = {}) {
  const code = normalizeObservationStockCode(input.code || input.symbol);
  const cleanDate = normalizeTimelineDate(input.clickedDate || input.t0);
  const currentResult = input.currentResult || input.backtestResult || {};
  const bars = getTimelineSeries(currentResult);
  const dateWindow = Array.isArray(input.dateWindow) && input.dateWindow.length
    ? input.dateWindow
    : buildObservationDateWindowFromBars(bars, cleanDate, input);

  if (!code || !cleanDate || !dateWindow.length) {
    return {
      ok: false,
      error: '无法生成观察上下文：缺少股票代码、观察日期或观察图时间序列。'
    };
  }

  const relationStocks = Array.isArray(input.relationStocks)
    ? input.relationStocks
    : getObservationMarketGraphCandidatesFromGraphs(code, input.relationGraphs || input.relationGraph || [], input);

  const supplyContext = input.supplyContext || (
    input.supplyChain
      ? getObservationSupplyChainCandidatesFromChain(code, input.supplyChain, input)
      : { stocks: [], self: null }
  );

  const relatedStocks = mergeObservationRelatedStocks(relationStocks, supplyContext.stocks || []);

  return {
    ok: true,
    code,
    t0: cleanDate,
    window: {
      before: Number(input.lookbackDays) >= 0 ? Number(input.lookbackDays) : DEFAULT_LOOKBACK_DAYS,
      after: Number(input.forwardDays) >= 0 ? Number(input.forwardDays) : DEFAULT_FORWARD_DAYS,
      dates: dateWindow
    },
    currentStock: {
      code,
      timeline: buildCurrentStockTimelineFromBacktestResult(currentResult, dateWindow)
    },
    relation: {
      count: relationStocks.length,
      stocks: relationStocks,
      debug: input.relationDebug || null
    },
    supplyChain: {
      self: supplyContext.self || null,
      count: Array.isArray(supplyContext.stocks) ? supplyContext.stocks.length : 0,
      stocks: Array.isArray(supplyContext.stocks) ? supplyContext.stocks : []
    },
    related: {
      count: relatedStocks.length,
      stocks: relatedStocks,
      matrix: relatedStocks.map((stock) => ({
        code: stock.code,
        name: stock.name,
        sources: stock.sources,
        relationTypes: stock.relationTypes,
        relationLabels: stock.relationLabels || [],
        relationScore: stock.relationScore || 0,
        relationStrength: stock.relationStrength || '',
        layers: stock.layers,
        timeline: buildPendingRelatedStockTimeline(stock, dateWindow)
      }))
    },
    createdAt: new Date().toISOString()
  };
}

async function hydrateObservationRelatedStockMatrix(context, options = {}) {
  if (!context || !context.ok || !context.related || !Array.isArray(context.related.matrix)) {
    return context;
  }

  const runBacktestForSymbol = options.runBacktestForSymbol;

  if (typeof runBacktestForSymbol !== 'function') {
    context.related.matrixStatus = {
      ok: false,
      loading: false,
      loaded: 0,
      failed: 0,
      total: 0,
      totalRelated: context.related.matrix.length,
      failures: [],
      message: 'runBacktestForSymbol 不可用，无法批量加载相关股票状态。'
    };
    return context;
  }

  const dateWindow = context.window && Array.isArray(context.window.dates)
    ? context.window.dates
    : [];

  if (!dateWindow.length) {
    context.related.matrixStatus = {
      ok: false,
      loading: false,
      loaded: 0,
      failed: 0,
      total: 0,
      totalRelated: context.related.matrix.length,
      failures: [],
      message: '观察窗口为空，无法加载相关股票状态。'
    };
    return context;
  }

  const requestStartDate = options.startDate || dateWindow[0].date;
  const requestEndDate = options.endDate || dateWindow[dateWindow.length - 1].date;
  const batchLimit = Number(options.batchLimit) > 0
    ? Number(options.batchLimit)
    : DEFAULT_STATE_BATCH_LIMIT;
  const rows = context.related.matrix.slice(0, batchLimit);

  let loaded = 0;
  let failed = 0;
  const failureSamples = [];

  for (const row of rows) {
    const code = normalizeObservationStockCode(row.code);

    if (!code) {
      failed += 1;
      row.timeline = buildPendingRelatedStockTimeline(row, dateWindow);
      row.loadError = '股票代码无效。';
      continue;
    }

    try {
      const result = await runBacktestForSymbol({
        symbol: code,
        startDate: requestStartDate,
        endDate: requestEndDate,
        refresh: false,
        cacheOnly: true,
        sourceMode: 'sqlite_cache_only',
        params: options.params || undefined
      });

      if (!result || !Array.isArray(result.priceSeries)) {
        failed += 1;
        row.timeline = buildPendingRelatedStockTimeline(row, dateWindow);
        row.loadError = '相关股票状态读取失败。';

        if (failureSamples.length < 5) {
          failureSamples.push(`${code} ${row.name || ''}：${row.loadError}`);
        }
      } else {
        loaded += 1;
        row.timeline = buildRelatedStockTimelineFromBacktestResult(row, dateWindow, result);
        row.loadError = '';
      }
    } catch (error) {
      failed += 1;
      row.timeline = buildPendingRelatedStockTimeline(row, dateWindow);
      row.loadError = error && error.message ? error.message : String(error);

      if (failureSamples.length < 5) {
        failureSamples.push(`${code} ${row.name || ''}：${row.loadError}`);
      }
    }
  }

  context.related.matrixStatus = {
    ok: true,
    loading: false,
    loaded,
    failed,
    total: rows.length,
    totalRelated: context.related.matrix.length,
    failures: failureSamples,
    message: failureSamples.length
      ? `相关股票状态加载完成：成功 ${loaded}，失败 ${failed}，本轮样本 ${rows.length} / 总样本 ${context.related.matrix.length}｜失败示例：${failureSamples.join('；')}`
      : `相关股票状态加载完成：成功 ${loaded}，失败 ${failed}，本轮样本 ${rows.length} / 总样本 ${context.related.matrix.length}`
  };

  return context;
}

module.exports = {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_FORWARD_DAYS,
  DEFAULT_MAX_RELATION_STOCKS,
  DEFAULT_MAX_SUPPLY_CHAIN_STOCKS,
  DEFAULT_STATE_BATCH_LIMIT,
  SUPPLY_CHAIN_LAYER_DEFS,

  normalizeObservationStockCode,
  normalizeTimelineDate,
  buildObservationDateWindowFromBars,
  buildCurrentStockTimelineFromBacktestResult,
  buildPendingRelatedStockTimeline,
  buildRelatedStockTimelineFromBacktestResult,
  getObservationMarketGraphCandidatesFromGraphs,
  getObservationSupplyChainCandidatesFromChain,
  mergeObservationRelatedStocks,
  buildObservationContextFromInputs,
  hydrateObservationRelatedStockMatrix
};