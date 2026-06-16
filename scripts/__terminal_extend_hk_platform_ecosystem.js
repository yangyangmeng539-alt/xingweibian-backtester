const fs = require('fs');
const path = require('path');

const relationPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-relation.seed.json');
const supplyPath = path.join(process.cwd(), 'data', 'market-graph', 'cross-market-supply-chain.seed.json');

const relation = JSON.parse(fs.readFileSync(relationPath, 'utf8'));
const supply = JSON.parse(fs.readFileSync(supplyPath, 'utf8'));

function norm(code) {
  const raw = String(code || '').trim().toUpperCase().replace(/^STOCK:/, '');
  if (raw.startsWith('HK:')) return `HK:${raw.slice(3).replace(/\D/g, '').padStart(5, '0')}`;
  if (/^HK\d{1,5}$/.test(raw)) return `HK:${raw.slice(2).padStart(5, '0')}`;
  if (/^\d{1,5}\.HK$/.test(raw)) return `HK:${raw.replace(/\.HK$/, '').padStart(5, '0')}`;
  if (/^\d{5}$/.test(raw)) return `HK:${raw}`;
  const digits = raw.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

const names = {
  'HK:00700': '腾讯控股',
  'HK:09988': '阿里巴巴-W',
  'HK:09888': '百度集团-SW',
  'HK:09618': '京东集团-SW',
  'HK:03690': '美团-W',
  'HK:01024': '快手-W',
  'HK:09999': '网易-S',
  'HK:09626': '哔哩哔哩-W',
  'HK:03888': '金山软件',
  'HK:03896': '金山云',
  'HK:00020': '商汤-W',
  'HK:02618': '京东物流',
  'HK:01810': '小米集团-W',
  'HK:02015': '理想汽车-W',
  'HK:09868': '小鹏汽车-W',
  'HK:09866': '蔚来-SW',
  'HK:00285': '比亚迪电子',
  'HK:01211': '比亚迪股份',
  'HK:00941': '中国移动',
  'HK:00728': '中国电信',
  'HK:00762': '中国联通',
  'HK:00981': '中芯国际',
  'HK:01347': '华虹半导体',
  'HK:01385': '上海复旦',
  'HK:00763': '中兴通讯',
  '002230': '科大讯飞',
  '300033': '同花顺',
  '300418': '昆仑万维',
  '300459': '汤姆猫',
  '300058': '蓝色光标',
  '688111': '金山办公',
  '688981': '中芯国际',
  '688347': '华虹公司',
  '688385': '复旦微电',
  '600941': '中国移动',
  '601728': '中国电信',
  '600050': '中国联通',
  '000063': '中兴通讯',
  '002594': '比亚迪'
};

function market(code) {
  if (code.startsWith('HK:')) return 'HK';
  if (code.startsWith('6') || code.startsWith('9')) return 'SH';
  return 'SZ';
}

function displayName(code) {
  const name = names[code] || code;
  return code.startsWith('HK:') ? `${name}（HK）` : name;
}

function ensureRelationItem(code) {
  code = norm(code);
  if (!code) return null;

  relation.items = relation.items || {};
  const old = relation.items[code] || {};
  relation.items[code] = {
    ...old,
    code,
    symbol: code,
    name: displayName(code),
    displayName: displayName(code),
    market: market(code),
    exchange: code.startsWith('HK:') ? 'HKEX' : market(code),
    currency: code.startsWith('HK:') ? 'HKD' : 'CNY',
    status: 'DONE',
    source: old.source || 'terminal_platform_ecosystem_seed',
    updatedAt: new Date().toISOString(),
    conceptThs: Array.isArray(old.conceptThs) ? old.conceptThs : [],
    plateEast: Array.isArray(old.plateEast) ? old.plateEast : []
  };

  return relation.items[code];
}

function addPlate(code, type, label) {
  const item = ensureRelationItem(code);
  if (!item) return;

  const exists = item.plateEast.some(p => String(p.plate_type || '') === type && String(p.plate_name || '') === label);
  if (!exists) {
    item.plateEast.push({
      plate_code: label,
      plate_name: label,
      plate_type: type,
      source: 'terminal_platform_ecosystem_seed'
    });
  }
}

function addGroup(type, label, codes) {
  for (const code of codes) addPlate(code, type, label);
}

addGroup('行业', '互联网平台', ['HK:00700','HK:09988','HK:09888','HK:09618','HK:03690','HK:01024','HK:09999','HK:09626']);
addGroup('概念', '人工智能', ['HK:00700','HK:09988','HK:09888','HK:00020','HK:03896','002230','688111','300033','300418']);
addGroup('概念', '云计算', ['HK:00700','HK:09988','HK:09888','HK:03896','HK:03888','HK:00941','HK:00728','HK:00762','688111']);
addGroup('概念', '游戏', ['HK:00700','HK:09999','HK:01024','HK:09626','300418','300459']);
addGroup('概念', '内容平台', ['HK:00700','HK:01024','HK:09626','HK:09999','HK:09888']);
addGroup('概念', '电商平台', ['HK:09988','HK:09618','HK:03690','HK:01024','HK:02618']);
addGroup('概念', '本地生活', ['HK:03690','HK:09988','HK:09618']);
addGroup('概念', '数字广告', ['HK:00700','HK:09888','HK:01024','HK:09626','HK:09988','HK:03690','300058']);
addGroup('概念', '算力网络', ['HK:00941','HK:00728','HK:00762','HK:00763','000063','600941','601728','600050']);
addGroup('行业', '半导体基础设施', ['HK:00981','HK:01347','HK:01385','688981','688347','688385']);
addGroup('概念', '智能终端', ['HK:01810','HK:02015','HK:09868','HK:09866','HK:00285','HK:01211','002594']);
addGroup('概念', '自动驾驶', ['HK:09888','HK:01810','HK:02015','HK:09868','HK:09866','002594']);
addGroup('概念', '供应链物流', ['HK:09618','HK:02618','HK:09988','HK:03690']);

function ensurePrimary(id, name) {
  supply.primaryChains = Array.isArray(supply.primaryChains) ? supply.primaryChains : [];
  let row = supply.primaryChains.find(x => x.id === id);
  if (!row) {
    row = { id, name, stockCount: 0, assignmentCount: 0 };
    supply.primaryChains.push(row);
  }
  row.name = name;
}

function stock(code, layer, chainName) {
  code = norm(code);
  return {
    stockId: `stock:${code}`,
    code,
    name: names[code] || code,
    market: code.startsWith('HK:') ? 'HK' : 'CN_A',
    source: 'terminal_platform_ecosystem_seed',
    editable: true,
    confidence: 0.88,
    matchedTerms: [chainName],
    layerTerms: [chainName],
    layer,
    layerName: { upstream:'上游', midstream:'中游', downstream:'下游', service:'配套服务', terminal:'终端应用' }[layer] || layer
  };
}

function removeOldAssignments(chainId) {
  supply.stockIndex = supply.stockIndex || {};
  for (const item of Object.values(supply.stockIndex)) {
    item.assignments = (Array.isArray(item.assignments) ? item.assignments : []).filter(a => a.chainId !== chainId);
  }
}

function addAssignment(chain, layer, s) {
  supply.stockIndex = supply.stockIndex || {};
  const old = supply.stockIndex[s.code] || {
    id: `stock:${s.code}`,
    code: s.code,
    name: s.name,
    market: s.market,
    industries: [],
    concepts: [],
    regions: [],
    assignments: []
  };

  old.name = old.name || s.name;
  old.market = old.market || s.market;
  old.assignments = (Array.isArray(old.assignments) ? old.assignments : []).filter(a => a.chainId !== chain.id);
  old.assignments.push({
    chainId: chain.id,
    chainName: chain.name,
    parentId: chain.parentId,
    parentName: chain.parentName,
    layer,
    layerName: s.layerName,
    confidence: 0.88,
    source: 'terminal_platform_ecosystem_seed',
    editable: true,
    matchedTerms: [chain.name],
    layerTerms: [s.layerName]
  });

  supply.stockIndex[s.code] = old;
}

function upsertChain(def) {
  supply.chains = Array.isArray(supply.chains) ? supply.chains : [];
  ensurePrimary(def.parentId, def.parentName);
  removeOldAssignments(def.id);

  const chain = {
    id: def.id,
    name: def.name,
    parentId: def.parentId,
    parentName: def.parentName,
    description: def.description || '',
    source: 'terminal_platform_ecosystem_seed',
    editable: true,
    keywords: [def.name, def.parentName],
    summary: { stockCount: 0, assignmentCount: 0, layerCounts: {} },
    layers: {}
  };

  for (const layer of ['upstream','midstream','downstream','service','terminal']) {
    const arr = (def.layers[layer] || []).map(code => stock(code, layer, def.name));
    chain.layers[layer] = {
      name: arr[0] ? arr[0].layerName : layer,
      stockCount: arr.length,
      stocks: arr
    };
    chain.summary.layerCounts[layer] = arr.length;
    for (const s of arr) addAssignment(chain, layer, s);
  }

  const unique = new Set();
  let count = 0;
  for (const layer of Object.values(chain.layers)) {
    for (const s of layer.stocks || []) {
      unique.add(s.code);
      count += 1;
    }
  }
  chain.summary.stockCount = unique.size;
  chain.summary.assignmentCount = count;

  const idx = supply.chains.findIndex(x => x.id === chain.id);
  if (idx >= 0) supply.chains[idx] = chain;
  else supply.chains.push(chain);
}

upsertChain({
  id: 'c_cross_platform_ecosystem',
  name: '平台经济与AI云服务',
  parentId: 'p_cross_platform_ai',
  parentName: '跨市场平台经济与AI',
  layers: {
    upstream: ['HK:00941','HK:00728','HK:00762','HK:00981','HK:01347','HK:01385','688981','688347','000063'],
    midstream: ['HK:00700','HK:09988','HK:09888','HK:09618','HK:03690','HK:01024','HK:09999'],
    downstream: ['HK:09626','HK:02618','HK:01024','HK:03690','HK:09618','300058','300459'],
    service: ['HK:00020','HK:03896','HK:03888','688111','002230','300033','300418'],
    terminal: ['HK:01810','HK:02015','HK:09868','HK:09866','HK:00285','HK:01211','002594']
  }
});

upsertChain({
  id: 'c_hk_ai_cloud_compute',
  name: '港股AI云与算力生态',
  parentId: 'p_hk_platform_ecosystem',
  parentName: '港股平台经济生态链',
  layers: {
    upstream: ['HK:00941','HK:00728','HK:00762','HK:00981','HK:01347','HK:01385'],
    midstream: ['HK:00700','HK:09988','HK:09888','HK:03896','HK:00020'],
    downstream: ['HK:03690','HK:09618','HK:01024','HK:09999'],
    service: ['HK:03888','688111','002230','300033'],
    terminal: ['HK:01810','HK:02015','HK:09868','HK:09866']
  }
});

upsertChain({
  id: 'c_hk_content_game_ecosystem',
  name: '港股内容娱乐与游戏生态',
  parentId: 'p_hk_platform_ecosystem',
  parentName: '港股平台经济生态链',
  layers: {
    upstream: ['HK:00941','HK:00728','HK:00762','HK:09888'],
    midstream: ['HK:00700','HK:09999','HK:01024','HK:09626'],
    downstream: ['HK:09988','HK:09618','HK:03690','300459'],
    service: ['300058','300418','HK:03888'],
    terminal: ['HK:01810','HK:00285']
  }
});

upsertChain({
  id: 'c_hk_ecommerce_local_life',
  name: '港股电商本地生活生态',
  parentId: 'p_hk_platform_ecosystem',
  parentName: '港股平台经济生态链',
  layers: {
    upstream: ['HK:00941','HK:00728','HK:00762','HK:03896'],
    midstream: ['HK:09988','HK:09618','HK:03690','HK:01024'],
    downstream: ['HK:02618','HK:09618','HK:03690','HK:09988'],
    service: ['HK:00700','HK:09888','300058','300033'],
    terminal: ['HK:01810','HK:00285','HK:01211']
  }
});

relation.generatedAt = new Date().toISOString();
relation.total = Object.keys(relation.items || {}).length;
relation.done = Object.values(relation.items || {}).filter(x => x.status === 'DONE').length;
relation.failed = Object.values(relation.items || {}).filter(x => x.status === 'FAILED').length;

const primaryStats = new Map();
for (const p of supply.primaryChains || []) primaryStats.set(p.id, { stocks: new Set(), assignments: 0 });

for (const c of supply.chains || []) {
  const stocks = new Set();
  let assignments = 0;
  for (const layer of Object.values(c.layers || {})) {
    for (const s of layer.stocks || []) {
      stocks.add(s.code);
      assignments += 1;
    }
  }
  c.summary.stockCount = stocks.size;
  c.summary.assignmentCount = assignments;

  if (!primaryStats.has(c.parentId)) primaryStats.set(c.parentId, { stocks: new Set(), assignments: 0 });
  const stat = primaryStats.get(c.parentId);
  for (const code of stocks) stat.stocks.add(code);
  stat.assignments += assignments;
}

for (const p of supply.primaryChains || []) {
  const stat = primaryStats.get(p.id);
  p.stockCount = stat ? stat.stocks.size : 0;
  p.assignmentCount = stat ? stat.assignments : 0;
}

supply.generatedAt = new Date().toISOString();
supply.summary = {
  primaryChainCount: (supply.primaryChains || []).length,
  secondaryChainCount: (supply.chains || []).length,
  stockCount: Object.keys(supply.stockIndex || {}).length,
  assignmentCount: Object.values(supply.stockIndex || {}).reduce((sum, s) => sum + ((s.assignments || []).length), 0)
};
supply.chainIndex = Object.fromEntries((supply.chains || []).map(c => [c.id, { id:c.id, name:c.name, parentId:c.parentId, parentName:c.parentName }]));

fs.writeFileSync(relationPath, JSON.stringify(relation, null, 2) + '\n', 'utf8');
fs.writeFileSync(supplyPath, JSON.stringify(supply, null, 2) + '\n', 'utf8');

console.log('[OK] 港股平台生态链已写入');
console.log({
  relationItems: relation.total,
  primaryChains: supply.summary.primaryChainCount,
  secondaryChains: supply.summary.secondaryChainCount,
  supplyStocks: supply.summary.stockCount,
  assignments: supply.summary.assignmentCount,
  hk00700: (supply.stockIndex['HK:00700'].assignments || []).map(a => `${a.parentName}/${a.chainName}/${a.layerName}`)
});
