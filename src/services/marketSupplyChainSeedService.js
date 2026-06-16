const fs = require('fs');
const path = require('path');

const MARKET_GRAPH_DIR = path.resolve(__dirname, '..', '..', 'data', 'market-graph');
const SUPPLY_CHAIN_SEED_PATH = path.join(MARKET_GRAPH_DIR, 'stock-supply-chain.v2.seed.json');
const CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-supply-chain.seed.json');
const USER_OVERRIDES_PATH = path.join(MARKET_GRAPH_DIR, 'user-supply-chain-overrides.json');

const LAYER_KEYS = Object.freeze(['upstream', 'midstream', 'downstream', 'service', 'terminal']);
const LAYER_LABELS = Object.freeze({
  upstream: '上游',
  midstream: '中游',
  downstream: '下游',
  service: '配套服务',
  terminal: '终端应用'
});
const DEFAULT_MAX_STOCKS_PER_LAYER = 30;
const DEFAULT_MAX_CHAINS = 100;
const MAX_STOCKS_PER_LAYER_CAP = 20000;
const MAX_CHAINS_CAP = 500;

let seedCache = null;
let seedCacheMtimeMs = 0;
let seedContextCache = null;
let seedContextMtimeMs = 0;

function normalizePositiveInteger(value, fallback, max = Number.POSITIVE_INFINITY) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }

  return Math.min(max, Math.floor(num));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function mergeUniqueById(left, right) {
  const result = [];
  const seen = new Set();

  [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].forEach((item) => {
    const id = item && item.id ? String(item.id) : '';

    if (!id || seen.has(id)) {
      return;
    }

    seen.add(id);
    result.push(item);
  });

  return result;
}

function mergeUniqueAssignments(left, right) {
  const result = [];
  const seen = new Set();

  [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].forEach((item) => {
    const chainId = String(item && item.chainId || '').trim();
    const layer = String(item && item.layer || '').trim();
    const key = `${chainId}:${layer}`;

    if (!chainId || !layer || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(item);
  });

  return result;
}

function mergeStockIndex(baseIndex, extraIndex) {
  const stockIndex = { ...(baseIndex || {}) };

  Object.values(extraIndex || {}).forEach((stock) => {
    const code = normalizeCode(stock && stock.code);

    if (!code) {
      return;
    }

    const existing = stockIndex[code] || {};

    stockIndex[code] = {
      ...existing,
      ...Object.fromEntries(Object.entries(stock || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')),
      id: existing.id || stock.id || `stock:${code}`,
      code,
      name: existing.name || stock.name || code,
      market: existing.market || stock.market || (String(code).startsWith('HK:') ? 'HK' : ''),
      industries: Array.from(new Set([...(existing.industries || []), ...(stock.industries || [])])),
      concepts: Array.from(new Set([...(existing.concepts || []), ...(stock.concepts || [])])),
      regions: Array.from(new Set([...(existing.regions || []), ...(stock.regions || [])])),
      assignments: mergeUniqueAssignments(existing.assignments, stock.assignments)
    };
  });

  return stockIndex;
}

function mergeSupplyChainSeeds(baseSeed, extraSeed) {
  if (!extraSeed || typeof extraSeed !== 'object') {
    return baseSeed;
  }

  const seed = cloneJson(baseSeed);
  const extra = cloneJson(extraSeed);

  seed.primaryChains = mergeUniqueById(seed.primaryChains, extra.primaryChains);
  seed.chains = mergeUniqueById(seed.chains, extra.chains);
  seed.stockIndex = mergeStockIndex(seed.stockIndex, extra.stockIndex);
  seed.defaultGraph = seed.defaultGraph && typeof seed.defaultGraph === 'object' ? seed.defaultGraph : {};
  seed.defaultGraph.primaryChains = mergeUniqueById(seed.defaultGraph.primaryChains, extra.defaultGraph && extra.defaultGraph.primaryChains);
  seed.defaultGraph.secondaryChainsTop = mergeUniqueById(seed.defaultGraph.secondaryChainsTop, extra.defaultGraph && extra.defaultGraph.secondaryChainsTop);
  seed.chainIndex = {
    ...(seed.chainIndex || {}),
    ...(extra.chainIndex || {})
  };
  seed.summary = {
    ...(seed.summary || {}),
    stockCount: Object.keys(seed.stockIndex || {}).length,
    assignedStockCount: Object.keys(seed.stockIndex || {}).length,
    assignmentTotal: Object.values(seed.stockIndex || {}).reduce((sum, stock) => {
      return sum + (Array.isArray(stock && stock.assignments) ? stock.assignments.length : 0);
    }, 0),
    primaryChainCount: Array.isArray(seed.defaultGraph.primaryChains) ? seed.defaultGraph.primaryChains.length : 0,
    secondaryChainCount: Array.isArray(seed.chains) ? seed.chains.length : 0,
    crossMarketEnabled: true,
    crossMarketSeedPath: CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH
  };
  seed.crossMarket = {
    enabled: true,
    seedPath: CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH,
    chainCount: Array.isArray(extra.chains) ? extra.chains.length : 0,
    stockCount: Object.keys(extra.stockIndex || {}).length
  };

  return seed;
}

function loadSupplyChainSeed(options = {}) {
  if (!fs.existsSync(SUPPLY_CHAIN_SEED_PATH)) {
    throw new Error(`缺少产业链 seed 数据文件：${SUPPLY_CHAIN_SEED_PATH}`);
  }

  const stat = fs.statSync(SUPPLY_CHAIN_SEED_PATH);
  const crossStat = fs.existsSync(CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH)
    ? fs.statSync(CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH)
    : null;
  const mergedMtimeMs = stat.mtimeMs + (crossStat ? crossStat.mtimeMs : 0);

  if (!seedCache || options.forceReload || mergedMtimeMs !== seedCacheMtimeMs) {
    const seed = readJsonFile(SUPPLY_CHAIN_SEED_PATH);

    if (!seed || typeof seed !== 'object') {
      throw new Error('产业链 seed 数据格式无效。');
    }

    if (!seed.defaultGraph || !Array.isArray(seed.chains) || !seed.stockIndex) {
      throw new Error('产业链 seed 缺少 defaultGraph、chains 或 stockIndex。');
    }

    const crossSeed = crossStat ? readJsonFile(CROSS_MARKET_SUPPLY_CHAIN_SEED_PATH) : null;

    seedCache = mergeSupplyChainSeeds(seed, crossSeed);
    seedCacheMtimeMs = mergedMtimeMs;
    seedContextCache = null;
    seedContextMtimeMs = 0;
  }

  return seedCache;
}

function getSeedContext() {
  const seed = loadSupplyChainSeed();

  if (seedContextCache && seedContextMtimeMs === seedCacheMtimeMs) {
    return seedContextCache;
  }

  const chainById = new Map();
  const primaryById = new Map();

  (seed.chains || []).forEach((chain) => {
    if (chain && chain.id) {
      chainById.set(String(chain.id), chain);
    }
  });

  (seed.defaultGraph && seed.defaultGraph.primaryChains || []).forEach((chain) => {
    if (chain && chain.id) {
      primaryById.set(String(chain.id), chain);
    }
  });

  seedContextCache = {
    seed,
    chainById,
    primaryById
  };
  seedContextMtimeMs = seedCacheMtimeMs;
  return seedContextCache;
}

function createDefaultOverrides() {
  return {
    version: 'dev-0.2.0',
    description: '用户对系统推断供应链的新增、删除、移动、确认、否定等覆盖记录。合并优先级 user > inferred > raw。',
    overrides: []
  };
}

function normalizeOverridesPayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  return {
    ...createDefaultOverrides(),
    ...base,
    overrides: Array.isArray(base.overrides) ? base.overrides : []
  };
}

function loadUserOverrides() {
  if (!fs.existsSync(USER_OVERRIDES_PATH)) {
    const emptyPayload = createDefaultOverrides();
    writeJsonFile(USER_OVERRIDES_PATH, emptyPayload);
    return emptyPayload;
  }

  return normalizeOverridesPayload(readJsonFile(USER_OVERRIDES_PATH));
}

function normalizeCode(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^STOCK:/, '');

  if (!raw) {
    return '';
  }

  if (raw.startsWith('HK:')) {
    const digits = raw.slice(3).replace(/\D/g, '');
    return /^\d{1,5}$/.test(digits) ? `HK:${digits.padStart(5, '0')}` : '';
  }

  if (/^HK\d{1,5}$/.test(raw)) {
    return `HK:${raw.slice(2).padStart(5, '0')}`;
  }

  if (/^\d{1,5}\.HK$/.test(raw)) {
    return `HK:${raw.replace(/\.HK$/, '').padStart(5, '0')}`;
  }

  if (/^\d{5}$/.test(raw)) {
    return `HK:${raw}`;
  }

  const match = raw.match(/(\d{6})/);
  return match ? match[1] : raw;
}

function isSupportedStockCode(value) {
  const code = normalizeCode(value);
  return /^\d{6}$/.test(code) || /^HK:\d{5}$/.test(code);
}

function normalizeLayer(value) {
  const layer = String(value || '').trim();
  return LAYER_KEYS.includes(layer) ? layer : '';
}

function getActionType(action) {
  const text = String(action && (action.type || action.action || action.actionType) || '').trim().toLowerCase();
  const map = {
    add: 'add',
    create: 'add',
    insert: 'add',
    '新增': 'add',
    remove: 'remove',
    delete: 'remove',
    del: 'remove',
    '删除': 'remove',
    deny: 'deny',
    reject: 'deny',
    negative: 'deny',
    '否定': 'deny',
    move: 'move',
    '移动': 'move',
    confirm: 'confirm',
    approve: 'confirm',
    '确认': 'confirm',
    update: 'update',
    edit: 'update',
    '修改': 'update'
  };

  return map[text] || text || 'update';
}

function getOverrideCode(action) {
  return normalizeCode(
    action && (
      action.code ||
      action.stockCode ||
      action.symbol ||
      action.stockId ||
      action.stock && action.stock.code
    )
  );
}

function getOverrideChainId(action) {
  return String(action && (action.chainId || action.targetChainId || action.chain && action.chain.id) || '').trim();
}

function getOverrideFromLayer(action) {
  return normalizeLayer(action && (action.fromLayer || action.oldLayer || action.layer));
}

function getOverrideToLayer(action) {
  return normalizeLayer(action && (action.toLayer || action.newLayer || action.layer));
}

function makeOverrideId() {
  return `supply-chain-override:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOverrideAction(action) {
  if (!action || typeof action !== 'object') {
    throw new Error('用户覆盖动作不能为空。');
  }

  const type = getActionType(action);
  const code = getOverrideCode(action);
  const chainId = getOverrideChainId(action);

  if (!code && !chainId) {
    throw new Error('用户覆盖动作至少需要股票代码或产业链 id。');
  }

  return {
    ...action,
    id: action.id ? String(action.id) : makeOverrideId(),
    type,
    code,
    chainId,
    fromLayer: getOverrideFromLayer(action),
    toLayer: getOverrideToLayer(action),
    source: 'user',
    appliedAt: action.appliedAt || new Date().toISOString()
  };
}

function applyUserOverride(action) {
  const payload = loadUserOverrides();
  const normalizedAction = normalizeOverrideAction(action);
  const nextPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
    overrides: [
      ...payload.overrides,
      normalizedAction
    ]
  };

  writeJsonFile(USER_OVERRIDES_PATH, nextPayload);

  return {
    override: normalizedAction,
    total: nextPayload.overrides.length,
    overrides: nextPayload
  };
}

function sourceLabelFor(source, editable, overrideStatus) {
  if (source === 'inferred') {
    return '系统推断';
  }

  if (source === 'user') {
    if (overrideStatus === 'confirmed') {
      return '用户确认';
    }

    if (overrideStatus === 'moved') {
      return '用户移动';
    }

    return '用户覆盖';
  }

  if (source === 'raw') {
    return editable === false ? '原始关系' : '原始关系，可编辑';
  }

  return source || '-';
}

function normalizeMatchedTerms(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function normalizeStockItem(stock, layer, chain, overrides = {}) {
  const source = overrides.source || stock.source || chain.source || 'inferred';
  const editable = Object.prototype.hasOwnProperty.call(overrides, 'editable')
    ? Boolean(overrides.editable)
    : stock.editable !== false;

  return {
    stockId: stock.stockId || stock.id || (stock.code ? `stock:${stock.code}` : ''),
    code: normalizeCode(overrides.code || stock.code || stock.stockCode || stock.stockId),
    name: String(overrides.name || stock.name || ''),
    market: String(overrides.market || stock.market || ''),
    chainId: chain.id,
    chainName: chain.name,
    parentId: chain.parentId || '',
    parentName: chain.parentName || '',
    layer,
    layerName: LAYER_LABELS[layer] || stock.layerName || layer,
    confidence: Number.isFinite(Number(overrides.confidence ?? stock.confidence))
      ? Number(overrides.confidence ?? stock.confidence)
      : null,
    source,
    sourceLabel: sourceLabelFor(source, editable, overrides.overrideStatus),
    editable,
    overrideStatus: overrides.overrideStatus || '',
    matchedTerms: normalizeMatchedTerms(overrides.matchedTerms || stock.matchedTerms),
    layerTerms: normalizeMatchedTerms(overrides.layerTerms || stock.layerTerms),
    evidence: stock.evidence && typeof stock.evidence === 'object' ? { ...stock.evidence } : {}
  };
}

function normalizeAssignment(assignment, stock, overrides = {}) {
  const source = overrides.source || assignment.source || 'inferred';
  const editable = Object.prototype.hasOwnProperty.call(overrides, 'editable')
    ? Boolean(overrides.editable)
    : assignment.editable !== false;
  const layer = normalizeLayer(overrides.layer || assignment.layer);

  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    chainId: String(overrides.chainId || assignment.chainId || ''),
    chainName: String(overrides.chainName || assignment.chainName || ''),
    parentId: String(overrides.parentId || assignment.parentId || ''),
    parentName: String(overrides.parentName || assignment.parentName || ''),
    layer,
    layerName: LAYER_LABELS[layer] || assignment.layerName || layer,
    confidence: Number.isFinite(Number(overrides.confidence ?? assignment.confidence))
      ? Number(overrides.confidence ?? assignment.confidence)
      : null,
    source,
    sourceLabel: sourceLabelFor(source, editable, overrides.overrideStatus),
    editable,
    overrideStatus: overrides.overrideStatus || '',
    matchedTerms: normalizeMatchedTerms(overrides.matchedTerms || assignment.matchedTerms),
    layerTerms: normalizeMatchedTerms(overrides.layerTerms || assignment.layerTerms)
  };
}

function normalizePrimaryChain(chain) {
  return {
    id: String(chain && chain.id || ''),
    name: String(chain && chain.name || ''),
    stockCount: Number(chain && chain.stockCount) || 0,
    assignmentCount: Number(chain && chain.assignmentCount) || 0
  };
}

function normalizeSecondaryChain(chain) {
  const layerCounts = chain && chain.layerCounts
    ? chain.layerCounts
    : chain && chain.summary && chain.summary.layerCounts
      ? chain.summary.layerCounts
      : chain && chain.layers
        ? Object.fromEntries(LAYER_KEYS.map((layer) => [
          layer,
          Number(chain.layers[layer] && chain.layers[layer].stockCount) || (chain.layers[layer] && Array.isArray(chain.layers[layer].stocks) ? chain.layers[layer].stocks.length : 0)
        ]))
        : {};

  return {
    id: String(chain && chain.id || ''),
    name: String(chain && chain.name || ''),
    parentId: String(chain && chain.parentId || ''),
    parentName: String(chain && chain.parentName || ''),
    stockCount: Number(chain && chain.stockCount) || Number(chain && chain.summary && chain.summary.stockCount) || 0,
    assignmentCount: Number(chain && chain.assignmentCount) || Number(chain && chain.summary && chain.summary.assignmentCount) || 0,
    source: String(chain && chain.source || ''),
    editable: chain ? chain.editable !== false : true,
    layerCounts
  };
}

function getAllOverrides() {
  try {
    return loadUserOverrides().overrides || [];
  } catch (_error) {
    return [];
  }
}

function matchesOverrideBase(action, code, chainId, layer, useToLayer = false) {
  const actionCode = getOverrideCode(action);
  const actionChainId = getOverrideChainId(action);
  const actionLayer = useToLayer ? getOverrideToLayer(action) : getOverrideFromLayer(action);

  if (code && actionCode && actionCode !== code) {
    return false;
  }

  if (chainId && actionChainId && actionChainId !== chainId) {
    return false;
  }

  if (layer && actionLayer && actionLayer !== layer) {
    return false;
  }

  return Boolean(!code || actionCode) && Boolean(!chainId || actionChainId);
}

function getStockMeta(code, fallback = {}) {
  const stockIndex = getSeedContext().seed.stockIndex || {};
  const stock = stockIndex[code] || {};

  return {
    id: stock.id || fallback.stockId || (code ? `stock:${code}` : ''),
    code,
    name: String(fallback.name || stock.name || ''),
    market: String(fallback.market || stock.market || ''),
    industries: Array.isArray(stock.industries) ? stock.industries.slice() : [],
    concepts: Array.isArray(stock.concepts) ? stock.concepts.slice() : [],
    regions: Array.isArray(stock.regions) ? stock.regions.slice() : []
  };
}

function findStockInChain(chain, code) {
  for (const layer of LAYER_KEYS) {
    const stocks = chain.layers && chain.layers[layer] && Array.isArray(chain.layers[layer].stocks)
      ? chain.layers[layer].stocks
      : [];
    const stock = stocks.find((item) => normalizeCode(item.code || item.stockId) === code);

    if (stock) {
      return { stock, layer };
    }
  }

  return null;
}

function buildUserStockFromOverride(action, chain, layer, seedStock) {
  const code = getOverrideCode(action);
  const stockMeta = getStockMeta(code, action.stock || seedStock || {});

  return normalizeStockItem({
    ...(seedStock || {}),
    stockId: stockMeta.id,
    code,
    name: action.name || action.stockName || stockMeta.name,
    market: action.market || stockMeta.market,
    confidence: action.confidence ?? (seedStock && seedStock.confidence),
    matchedTerms: action.matchedTerms || seedStock && seedStock.matchedTerms,
    layerTerms: action.layerTerms || seedStock && seedStock.layerTerms
  }, layer, chain, {
    source: 'user',
    editable: true,
    overrideStatus: getActionType(action) === 'confirm'
      ? 'confirmed'
      : getActionType(action) === 'move'
        ? 'moved'
        : 'added',
    confidence: action.confidence,
    matchedTerms: action.matchedTerms,
    layerTerms: action.layerTerms
  });
}

function buildUserAssignmentFromOverride(action, stock, chain, layer, seedAssignment) {
  return normalizeAssignment({
    ...(seedAssignment || {}),
    chainId: chain.id,
    chainName: chain.name,
    parentId: chain.parentId || '',
    parentName: chain.parentName || '',
    layer,
    confidence: action.confidence ?? (seedAssignment && seedAssignment.confidence),
    matchedTerms: action.matchedTerms || seedAssignment && seedAssignment.matchedTerms,
    layerTerms: action.layerTerms || seedAssignment && seedAssignment.layerTerms
  }, stock, {
    source: 'user',
    editable: true,
    overrideStatus: getActionType(action) === 'confirm'
      ? 'confirmed'
      : getActionType(action) === 'move'
        ? 'moved'
        : 'added',
    confidence: action.confidence,
    matchedTerms: action.matchedTerms,
    layerTerms: action.layerTerms
  });
}

function upsertByKey(items, item, keyFn) {
  const key = keyFn(item);
  const index = items.findIndex((current) => keyFn(current) === key);

  if (index >= 0) {
    items[index] = item;
  } else {
    items.push(item);
  }
}

function removeMatching(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      items.splice(index, 1);
    }
  }
}

function applyOverridesToChainLayers(chain, options = {}) {
  const layers = Object.fromEntries(LAYER_KEYS.map((layer) => {
    const rawStocks = chain.layers && chain.layers[layer] && Array.isArray(chain.layers[layer].stocks)
      ? chain.layers[layer].stocks
      : [];
    return [
      layer,
      rawStocks.map((stock) => normalizeStockItem(stock, layer, chain))
    ];
  }));
  const overrides = getAllOverrides().filter((action) => getOverrideChainId(action) === chain.id && getOverrideCode(action));

  overrides.forEach((action) => {
    const type = getActionType(action);
    const code = getOverrideCode(action);
    const fromLayer = getOverrideFromLayer(action);
    const toLayer = getOverrideToLayer(action);

    if (type === 'remove' || type === 'deny') {
      LAYER_KEYS.forEach((layer) => {
        if (!fromLayer || fromLayer === layer) {
          removeMatching(layers[layer], (stock) => stock.code === code);
        }
      });
      return;
    }

    if (type === 'move') {
      let seedStock = null;

      LAYER_KEYS.forEach((layer) => {
        const matched = layers[layer].find((stock) => stock.code === code);

        if (matched && (!fromLayer || fromLayer === layer)) {
          seedStock = matched;
          removeMatching(layers[layer], (stock) => stock.code === code);
        }
      });

      if (toLayer) {
        upsertByKey(layers[toLayer], buildUserStockFromOverride(action, chain, toLayer, seedStock), (stock) => stock.code);
      }

      return;
    }

    if (type === 'add' || type === 'confirm' || type === 'update') {
      const targetLayer = toLayer || fromLayer;

      if (!targetLayer) {
        return;
      }

      const found = findStockInChain(chain, code);
      const seedStock = found ? found.stock : null;

      if (type === 'confirm') {
        const existing = layers[targetLayer].find((stock) => stock.code === code);

        if (existing) {
          upsertByKey(layers[targetLayer], {
            ...existing,
            source: 'user',
            sourceLabel: sourceLabelFor('user', true, 'confirmed'),
            editable: true,
            overrideStatus: 'confirmed'
          }, (stock) => stock.code);
          return;
        }
      }

      upsertByKey(layers[targetLayer], buildUserStockFromOverride(action, chain, targetLayer, seedStock), (stock) => stock.code);
    }
  });

  const layerLimits = options.layerLimits && typeof options.layerLimits === 'object' ? options.layerLimits : {};
  const defaultLimit = normalizePositiveInteger(
    options.maxStocksPerLayer,
    DEFAULT_MAX_STOCKS_PER_LAYER,
    MAX_STOCKS_PER_LAYER_CAP
  );

  return Object.fromEntries(LAYER_KEYS.map((layer) => {
    const stocks = layers[layer];
    const limit = normalizePositiveInteger(layerLimits[layer], defaultLimit, MAX_STOCKS_PER_LAYER_CAP);
    const displayStocks = stocks.slice(0, limit);

    return [
      layer,
      {
        key: layer,
        name: LAYER_LABELS[layer],
        stockCount: stocks.length,
        displayCount: displayStocks.length,
        hasMore: stocks.length > displayStocks.length,
        nextLimit: stocks.length > displayStocks.length ? Math.min(stocks.length, limit + DEFAULT_MAX_STOCKS_PER_LAYER) : displayStocks.length,
        stocks: displayStocks
      }
    ];
  }));
}

function applyOverridesToStockAssignments(stockMeta, seedAssignments, options = {}) {
  const { chainById } = getSeedContext();
  const code = stockMeta.code;
  const assignments = seedAssignments.map((assignment) => normalizeAssignment(assignment, stockMeta));
  const overrides = getAllOverrides().filter((action) => getOverrideCode(action) === code && getOverrideChainId(action));

  overrides.forEach((action) => {
    const type = getActionType(action);
    const chainId = getOverrideChainId(action);
    const chain = chainById.get(chainId);

    if (!chain) {
      return;
    }

    const fromLayer = getOverrideFromLayer(action);
    const toLayer = getOverrideToLayer(action);

    if (type === 'remove' || type === 'deny') {
      removeMatching(assignments, (assignment) => (
        assignment.chainId === chainId && (!fromLayer || assignment.layer === fromLayer)
      ));
      return;
    }

    if (type === 'move') {
      let seedAssignment = null;

      removeMatching(assignments, (assignment) => {
        const matched = assignment.chainId === chainId && (!fromLayer || assignment.layer === fromLayer);

        if (matched) {
          seedAssignment = assignment;
        }

        return matched;
      });

      if (toLayer) {
        upsertByKey(
          assignments,
          buildUserAssignmentFromOverride(action, stockMeta, chain, toLayer, seedAssignment),
          (assignment) => `${assignment.chainId}:${assignment.layer}`
        );
      }

      return;
    }

    if (type === 'add' || type === 'confirm' || type === 'update') {
      const targetLayer = toLayer || fromLayer;

      if (!targetLayer) {
        return;
      }

      const existing = assignments.find((assignment) => assignment.chainId === chainId && assignment.layer === targetLayer);

      if (type === 'confirm' && existing) {
        upsertByKey(assignments, {
          ...existing,
          source: 'user',
          sourceLabel: sourceLabelFor('user', true, 'confirmed'),
          editable: true,
          overrideStatus: 'confirmed'
        }, (assignment) => `${assignment.chainId}:${assignment.layer}`);
        return;
      }

      upsertByKey(
        assignments,
        buildUserAssignmentFromOverride(action, stockMeta, chain, targetLayer, existing),
        (assignment) => `${assignment.chainId}:${assignment.layer}`
      );
    }
  });

  const maxChains = normalizePositiveInteger(options.maxChains, DEFAULT_MAX_CHAINS, MAX_CHAINS_CAP);

  return {
    total: assignments.length,
    hasMore: assignments.length > maxChains,
    assignments: assignments.slice(0, maxChains)
  };
}

function getSupplyChainSummary() {
  const seed = loadSupplyChainSeed();
  const summary = seed.summary && typeof seed.summary === 'object' ? seed.summary : {};
  const stockIndex = seed.stockIndex || {};
  const stockCount = Number(summary.stockCount) || Object.keys(stockIndex).length;
  const assignmentTotal = Number(summary.assignmentTotal) || Object.values(stockIndex).reduce((sum, stock) => {
    return sum + (Array.isArray(stock && stock.assignments) ? stock.assignments.length : 0);
  }, 0);

  return {
    seedExists: true,
    seedPath: SUPPLY_CHAIN_SEED_PATH,
    userOverridesPath: USER_OVERRIDES_PATH,
    version: seed.version || '',
    generatedAt: seed.generatedAt || '',
    summary,
    primaryChainCount: Number(summary.primaryChainCount) || (seed.defaultGraph.primaryChains || []).length,
    secondaryChainCount: Number(summary.secondaryChainCount) || (seed.chains || []).length,
    stockCount,
    assignedStockCount: Number(summary.assignedStockCount) || stockCount,
    assignmentTotal
  };
}

function listPrimaryChains() {
  const seed = loadSupplyChainSeed();
  return (seed.defaultGraph.primaryChains || []).map(normalizePrimaryChain);
}

function listSecondaryChains(options = {}) {
  const seed = loadSupplyChainSeed();
  const primaryChainId = String(options.primaryChainId || options.parentId || '').trim();
  const maxChains = normalizePositiveInteger(options.maxChains, DEFAULT_MAX_CHAINS, MAX_CHAINS_CAP);
  const sourceChains = primaryChainId
    ? (seed.chains || []).filter((chain) => chain && chain.parentId === primaryChainId)
    : (seed.defaultGraph.secondaryChainsTop || []);
  const chains = sourceChains.map(normalizeSecondaryChain).slice(0, maxChains);

  return {
    primaryChainId,
    total: sourceChains.length,
    hasMore: sourceChains.length > chains.length,
    chains
  };
}

function queryStockSupplyChain(code, options = {}) {
  const normalizedCode = normalizeCode(code);
  const stock = getSeedContext().seed.stockIndex[normalizedCode];

  if (!stock) {
    return {
      code: normalizedCode,
      found: false,
      total: 0,
      hasMore: false,
      assignments: []
    };
  }

  const stockMeta = getStockMeta(normalizedCode);
  const effective = applyOverridesToStockAssignments(stockMeta, Array.isArray(stock.assignments) ? stock.assignments : [], options);

  return {
    ...stockMeta,
    found: true,
    total: effective.total,
    hasMore: effective.hasMore,
    assignments: effective.assignments
  };
}

function queryChain(chainId, options = {}) {
  const { chainById } = getSeedContext();
  const normalizedChainId = String(chainId || '').trim();
  const chain = chainById.get(normalizedChainId);

  if (!chain) {
    return {
      id: normalizedChainId,
      found: false,
      layers: Object.fromEntries(LAYER_KEYS.map((layer) => [
        layer,
        {
          key: layer,
          name: LAYER_LABELS[layer],
          stockCount: 0,
          displayCount: 0,
          hasMore: false,
          nextLimit: 0,
          stocks: []
        }
      ]))
    };
  }

  return {
    ...normalizeSecondaryChain(chain),
    found: true,
    description: String(chain.description || ''),
    keywords: normalizeMatchedTerms(chain.keywords),
    sourceLabel: sourceLabelFor(chain.source || 'inferred', chain.editable !== false),
    layers: applyOverridesToChainLayers(chain, options)
  };
}

function expandSupplyChainNode(nodeId, options = {}) {
  const id = String(nodeId || '').trim();
  const normalizedId = id.replace(/^chain:/, '').replace(/^primary:/, '').replace(/^stock:/, '');
  const layerMatch = id.match(/^layer:([^:]+):([^:]+)$/);
  const { chainById, primaryById } = getSeedContext();

  if (layerMatch) {
    const chain = queryChain(layerMatch[1], options);
    const layer = normalizeLayer(layerMatch[2]);

    return {
      type: 'layer',
      chainId: layerMatch[1],
      layer,
      layerData: chain.layers[layer] || null
    };
  }

  if (isSupportedStockCode(normalizedId)) {
    return {
      type: 'stock',
      stock: queryStockSupplyChain(normalizedId, options)
    };
  }

  if (primaryById.has(normalizedId)) {
    return {
      type: 'primary',
      primaryChain: normalizePrimaryChain(primaryById.get(normalizedId)),
      secondaryChains: listSecondaryChains({
        ...options,
        primaryChainId: normalizedId
      })
    };
  }

  if (chainById.has(normalizedId)) {
    return {
      type: 'chain',
      chain: queryChain(normalizedId, options)
    };
  }

  return {
    type: 'unknown',
    nodeId: id,
    found: false
  };
}

module.exports = {
  SUPPLY_CHAIN_SEED_PATH,
  USER_OVERRIDES_PATH,
  LAYER_KEYS,
  LAYER_LABELS,
  loadSupplyChainSeed,
  getSupplyChainSummary,
  listPrimaryChains,
  listSecondaryChains,
  queryStockSupplyChain,
  queryChain,
  expandSupplyChainNode,
  loadUserOverrides,
  applyUserOverride
};
