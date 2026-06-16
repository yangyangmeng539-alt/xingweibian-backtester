const fs = require('fs');
const path = require('path');

const { loadStockUniverse } = require('../data/stockUniverseService');
const { loadHongKongStockUniverse } = require('../data/hkStockUniverseService');

const USER_SUPPLY_CHAIN_EDIT_VERSION = 'xwb-supply-chain-user-edits-v1';

const USER_SUPPLY_CHAIN_EDIT_PATH = path.join(
  process.cwd(),
  'data',
  'market-graph',
  'supply-chain-user-edits.json'
);

const LAYER_DEFS = [
  { key: 'upstream', label: '上游' },
  { key: 'midstream', label: '中游' },
  { key: 'downstream', label: '下游' },
  { key: 'service', label: '配套服务' },
  { key: 'terminal', label: '终端应用' }
];

const LAYER_LABEL_TO_KEY = {
  上游: 'upstream',
  中游: 'midstream',
  下游: 'downstream',
  配套服务: 'service',
  终端应用: 'terminal'
};

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getNowIso() {
  return new Date().toISOString();
}

function getDefaultData() {
  return {
    version: USER_SUPPLY_CHAIN_EDIT_VERSION,
    updatedAt: getNowIso(),
    chains: []
  };
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);

    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(filePath);

  const tempPath = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function simpleHash(value) {
  let hash = 2166136261;
  const text = String(value || '');

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0).toString(36);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMarket(value, symbol = '') {
  const text = String(value || '').trim().toUpperCase();
  const code = String(symbol || '').trim().toUpperCase();

  if (text === 'HK' || code.startsWith('HK:')) {
    return 'HK';
  }

  return 'CN_A';
}

function normalizeStockCode(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return '';

  if (raw.startsWith('HK:')) {
    const digits = raw.slice(3).replace(/\D/g, '');
    return digits ? `HK:${digits.padStart(5, '0')}` : '';
  }

  if (/^\d{1,5}\.HK$/.test(raw)) {
    return `HK:${raw.replace(/\.HK$/, '').padStart(5, '0')}`;
  }

  if (/^HK\d{1,5}$/.test(raw)) {
    return `HK:${raw.slice(2).padStart(5, '0')}`;
  }

  if (/^\d{5}$/.test(raw)) {
    return `HK:${raw}`;
  }

  const digits = raw.replace(/\D/g, '');

  if (/^\d{6}$/.test(digits)) {
    return digits;
  }

  return '';
}

function normalizeLayerKey(value) {
  const text = normalizeText(value);

  if (LAYER_DEFS.some((item) => item.key === text)) {
    return text;
  }

  return LAYER_LABEL_TO_KEY[text] || '';
}

function normalizeStockItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const code = normalizeStockCode(source.code || source.symbol);

  if (!code) {
    return null;
  }

  return {
    code,
    symbol: code,
    name: normalizeText(source.name || source.stockName || source.label || code),
    market: normalizeMarket(source.market, code),
    note: normalizeText(source.note),
    source: 'user',
    sourceLabel: '用户自建',
    confidence: 1,
    matchedTerms: ['用户拖入']
  };
}

function normalizeLayers(inputLayers) {
  const result = {};

  LAYER_DEFS.forEach((def) => {
    result[def.key] = [];
  });

  const source = inputLayers && typeof inputLayers === 'object' ? inputLayers : {};

  Object.entries(source).forEach(([layerKey, items]) => {
    const normalizedLayer = normalizeLayerKey(layerKey);

    if (!normalizedLayer) {
      return;
    }

    const seen = new Set();
    const stocks = Array.isArray(items) ? items : [];

    stocks.forEach((item) => {
      const stock = normalizeStockItem(item);

      if (!stock || seen.has(stock.code)) {
        return;
      }

      seen.add(stock.code);
      result[normalizedLayer].push(stock);
    });
  });

  return result;
}

function countLayerStocks(layers) {
  return LAYER_DEFS.reduce((sum, def) => {
    const list = Array.isArray(layers && layers[def.key]) ? layers[def.key] : [];
    return sum + list.length;
  }, 0);
}

function normalizeChainForSave(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const primaryName = normalizeText(source.primaryName);
  const secondaryName = normalizeText(source.secondaryName);
  const layers = normalizeLayers(source.layers);

  if (!primaryName) {
    throw new Error('一级产业链名称不能为空。');
  }

  if (!secondaryName) {
    throw new Error('二级细分链名称不能为空。');
  }

  if (countLayerStocks(layers) <= 0) {
    throw new Error('请至少拖入一只股票。');
  }

  const existingId = normalizeText(source.id).replace(/^user-chain:/, '');
  const id = existingId || `user_${simpleHash(`${primaryName}|${secondaryName}|${Date.now()}`)}`;

  return {
    id,
    source: 'user',
    primaryName,
    secondaryName,
    note: normalizeText(source.note),
    createdAt: source.createdAt || getNowIso(),
    updatedAt: getNowIso(),
    layers
  };
}

function readUserSupplyChainEdits() {
  const data = safeReadJson(USER_SUPPLY_CHAIN_EDIT_PATH, getDefaultData());

  return {
    ...getDefaultData(),
    ...data,
    chains: Array.isArray(data.chains) ? data.chains : []
  };
}

function writeUserSupplyChainEdits(data) {
  const next = {
    ...getDefaultData(),
    ...(data || {}),
    version: USER_SUPPLY_CHAIN_EDIT_VERSION,
    updatedAt: getNowIso(),
    chains: Array.isArray(data && data.chains) ? data.chains : []
  };

  writeJsonAtomic(USER_SUPPLY_CHAIN_EDIT_PATH, next);
  return next;
}

function getUserPrimaryId(primaryName) {
  return `user-primary:${simpleHash(primaryName)}`;
}

function getUserChainId(chainId) {
  const raw = normalizeText(chainId).replace(/^user-chain:/, '');
  return `user-chain:${raw}`;
}

function stripUserChainId(chainId) {
  return normalizeText(chainId).replace(/^user-chain:/, '');
}

function listUserSupplyChainPrimaryChains() {
  const data = readUserSupplyChainEdits();
  const map = new Map();

  data.chains.forEach((chain) => {
    const primaryName = normalizeText(chain.primaryName);

    if (!primaryName) {
      return;
    }

    const id = getUserPrimaryId(primaryName);
    const existed = map.get(id) || {
      id,
      name: primaryName,
      source: 'user',
      sourceLabel: '用户自建',
      stockCount: 0,
      chainCount: 0
    };

    existed.chainCount += 1;
    existed.stockCount += countLayerStocks(chain.layers);
    map.set(id, existed);
  });

  return {
    ok: true,
    version: USER_SUPPLY_CHAIN_EDIT_VERSION,
    path: USER_SUPPLY_CHAIN_EDIT_PATH,
    chains: Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  };
}

function listUserSupplyChainSecondaryChains(payload = {}) {
  const data = readUserSupplyChainEdits();
  const primaryChainId = normalizeText(payload.primaryChainId);
  const primaryHash = primaryChainId.startsWith('user-primary:')
    ? primaryChainId.slice('user-primary:'.length)
    : '';

  const chains = data.chains
    .filter((chain) => {
      if (!primaryHash) {
        return true;
      }

      return simpleHash(chain.primaryName) === primaryHash;
    })
    .map((chain) => ({
      id: getUserChainId(chain.id),
      name: chain.secondaryName,
      parentName: chain.primaryName,
      parentId: getUserPrimaryId(chain.primaryName),
      source: 'user',
      sourceLabel: '用户自建',
      stockCount: countLayerStocks(chain.layers)
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));

  return {
    ok: true,
    version: USER_SUPPLY_CHAIN_EDIT_VERSION,
    result: {
      chains
    }
  };
}

function queryUserSupplyChain(payload = {}) {
  const data = readUserSupplyChainEdits();
  const chainId = stripUserChainId(payload.chainId || payload.id);
  const chain = data.chains.find((item) => String(item.id) === chainId);

  if (!chain) {
    return {
      ok: true,
      chain: {
        found: false,
        id: getUserChainId(chainId),
        name: '',
        parentName: '',
        layers: {}
      }
    };
  }

  const layers = {};

  LAYER_DEFS.forEach((def) => {
    const stocks = Array.isArray(chain.layers && chain.layers[def.key])
      ? chain.layers[def.key]
      : [];

    layers[def.key] = {
      key: def.key,
      label: def.label,
      stocks,
      stockCount: stocks.length,
      displayCount: stocks.length
    };
  });

  return {
    ok: true,
    chain: {
      found: true,
      id: getUserChainId(chain.id),
      rawId: chain.id,
      name: chain.secondaryName,
      parentName: chain.primaryName,
      source: 'user',
      sourceLabel: '用户自建',
      note: chain.note || '',
      layers,
      stockCount: countLayerStocks(chain.layers)
    }
  };
}

async function loadAllUniverseStocks() {
  const result = [];

  try {
    const universe = await loadStockUniverse();
    const stocks = Array.isArray(universe && universe.stocks) ? universe.stocks : [];

    stocks.forEach((stock) => {
      const code = normalizeStockCode(stock && (stock.symbol || stock.code));

      if (!/^\d{6}$/.test(code)) {
        return;
      }

      result.push({
        code,
        symbol: code,
        name: normalizeText(stock.name || stock.shortName || code),
        market: 'CN_A'
      });
    });
  } catch (_error) {
    // A股 universe 不可用时跳过，不影响港股搜索。
  }

  try {
    const universe = loadHongKongStockUniverse();
    const stocks = Array.isArray(universe && universe.stocks) ? universe.stocks : [];

    stocks.forEach((stock) => {
      const code = normalizeStockCode(stock && (stock.symbol || stock.code));

      if (!/^HK:\d{5}$/.test(code)) {
        return;
      }

      result.push({
        code,
        symbol: code,
        name: normalizeText(stock.name || stock.shortName || stock.companyName || code),
        market: 'HK'
      });
    });
  } catch (_error) {
    // 港股 universe 不可用时跳过。
  }

  const seen = new Set();

  return result.filter((stock) => {
    if (!stock.code || seen.has(stock.code)) {
      return false;
    }

    seen.add(stock.code);
    return true;
  });
}

async function searchSupplyChainEditorStocks(payload = {}) {
  const query = normalizeText(payload.query).toUpperCase();
  const maxResults = Math.max(5, Math.min(50, Number(payload.maxResults) || 20));

  if (!query) {
    return {
      ok: true,
      query,
      items: []
    };
  }

  const normalizedCode = normalizeStockCode(query);
  const stocks = await loadAllUniverseStocks();

  const items = stocks
    .map((stock) => {
      const code = String(stock.code || '').toUpperCase();
      const name = String(stock.name || '').toUpperCase();

      let score = 0;

      if (normalizedCode && code === normalizedCode) score += 1000;
      if (code === query) score += 900;
      if (code.includes(query)) score += 400;
      if (name === query) score += 600;
      if (name.includes(query)) score += 260;

      return {
        ...stock,
        score
      };
    })
    .filter((stock) => stock.score > 0)
    .sort((a, b) => b.score - a.score || String(a.code).localeCompare(String(b.code)))
    .slice(0, maxResults)
    .map(({ score, ...stock }) => stock);

  return {
    ok: true,
    query,
    items
  };
}

function saveUserSupplyChain(payload = {}) {
  const data = readUserSupplyChainEdits();
  const chain = normalizeChainForSave(payload);
  const index = data.chains.findIndex((item) => String(item.id) === String(chain.id));

  if (index >= 0) {
    data.chains[index] = {
      ...data.chains[index],
      ...chain,
      createdAt: data.chains[index].createdAt || chain.createdAt,
      updatedAt: getNowIso()
    };
  } else {
    data.chains.push(chain);
  }

  const saved = writeUserSupplyChainEdits(data);

  return {
    ok: true,
    version: USER_SUPPLY_CHAIN_EDIT_VERSION,
    path: USER_SUPPLY_CHAIN_EDIT_PATH,
    chainId: getUserChainId(chain.id),
    primaryId: getUserPrimaryId(chain.primaryName),
    chain,
    total: saved.chains.length
  };
}

function deleteUserSupplyChain(payload = {}) {
  const chainId = stripUserChainId(payload.chainId || payload.id);

  if (!chainId) {
    throw new Error('缺少要删除的用户自建产业链 ID。');
  }

  const data = readUserSupplyChainEdits();
  const index = data.chains.findIndex((item) => String(item.id) === String(chainId));

  if (index < 0) {
    return {
      ok: false,
      deleted: false,
      chainId: getUserChainId(chainId),
      reason: 'USER_CHAIN_NOT_FOUND'
    };
  }

  const removed = data.chains[index];
  data.chains.splice(index, 1);

  const saved = writeUserSupplyChainEdits(data);

  return {
    ok: true,
    deleted: true,
    chainId: getUserChainId(chainId),
    removed,
    total: saved.chains.length
  };
}

module.exports = {
  USER_SUPPLY_CHAIN_EDIT_VERSION,
  USER_SUPPLY_CHAIN_EDIT_PATH,
  LAYER_DEFS,
  readUserSupplyChainEdits,
  listUserSupplyChainPrimaryChains,
  listUserSupplyChainSecondaryChains,
  queryUserSupplyChain,
  searchSupplyChainEditorStocks,
  deleteUserSupplyChain,
  saveUserSupplyChain
};