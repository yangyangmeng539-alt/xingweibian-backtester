const fs = require('fs');
const path = require('path');

const dir = path.join(process.cwd(), 'data', 'market-graph');
const relationPath = path.join(dir, 'cross-market-relation.seed.json');
const supplyPath = path.join(dir, 'cross-market-supply-chain.seed.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function relationItem(code, name, market, industry, concepts) {
  const generatedAt = new Date().toISOString();

  return {
    code,
    symbol: code,
    name,
    displayName: market === 'HK' ? `${name}（HK）` : name,
    market,
    exchange: market === 'HK' ? 'HKEX' : market || '',
    currency: market === 'HK' ? 'HKD' : 'CNY',
    status: 'DONE',
    updatedAt: generatedAt,
    source: 'manual_cross_market_seed',
    conceptThs: [],
    plateEast: [
      { plate_code: industry, plate_name: industry, plate_type: '行业', source: '跨市场seed' },
      ...concepts.map((conceptName) => ({
        plate_code: conceptName,
        plate_name: conceptName,
        plate_type: '概念',
        source: '跨市场seed'
      }))
    ]
  };
}

function makeStock(code, name, market, chainId, chainName, parentId, parentName, layer, industries, concepts) {
  return {
    id: `stock:${code}`,
    code,
    name,
    market,
    industries,
    concepts,
    regions: market === 'HK' ? ['香港'] : [],
    assignments: [
      {
        chainId,
        chainName,
        parentId,
        parentName,
        layer,
        layerName: layer === 'upstream' ? '上游' : layer === 'downstream' ? '下游' : '中游',
        confidence: 0.86,
        source: 'manual_cross_market_seed',
        editable: true,
        matchedTerms: concepts,
        layerTerms: industries
      }
    ]
  };
}

function mergeRelation(seed, items) {
  seed.items = seed.items && typeof seed.items === 'object' ? seed.items : {};

  for (const item of items) {
    seed.items[item.code] = {
      ...(seed.items[item.code] || {}),
      ...item
    };
  }

  seed.total = Object.keys(seed.items).length;
  seed.done = Object.values(seed.items).filter((item) => item.status === 'DONE').length;
  seed.failed = Object.values(seed.items).filter((item) => item.status === 'FAILED').length;
  seed.generatedAt = new Date().toISOString();
  seed.source = 'manual:cross_market_seed';
  return seed;
}

function mergeSupply(seed, stocks, chains) {
  seed.stockIndex = seed.stockIndex && typeof seed.stockIndex === 'object' ? seed.stockIndex : {};
  seed.chains = Array.isArray(seed.chains) ? seed.chains : [];
  seed.primaryChains = Array.isArray(seed.primaryChains) ? seed.primaryChains : [];

  for (const stock of Object.values(stocks)) {
    const existing = seed.stockIndex[stock.code] || {};
    const existingAssignments = Array.isArray(existing.assignments) ? existing.assignments : [];
    const newAssignments = Array.isArray(stock.assignments) ? stock.assignments : [];
    const assignmentMap = new Map();

    for (const item of [...existingAssignments, ...newAssignments]) {
      assignmentMap.set(`${item.chainId}:${item.layer}`, item);
    }

    seed.stockIndex[stock.code] = {
      ...existing,
      ...stock,
      assignments: Array.from(assignmentMap.values())
    };
  }

  const chainMap = new Map(seed.chains.map((chain) => [chain.id, chain]));

  for (const chain of chains) {
    chainMap.set(chain.id, chain);
  }

  seed.chains = Array.from(chainMap.values());

  const primaryMap = new Map(seed.primaryChains.map((chain) => [chain.id, chain]));

  for (const chain of seed.chains) {
    if (!primaryMap.has(chain.parentId)) {
      primaryMap.set(chain.parentId, {
        id: chain.parentId,
        name: chain.parentName,
        stockCount: chain.summary && chain.summary.stockCount || 0,
        assignmentCount: chain.summary && chain.summary.assignmentCount || 0
      });
    }
  }

  seed.primaryChains = Array.from(primaryMap.values());

  seed.defaultGraph = seed.defaultGraph && typeof seed.defaultGraph === 'object' ? seed.defaultGraph : {};
  seed.defaultGraph.primaryChains = seed.primaryChains;
  seed.defaultGraph.secondaryChainsTop = seed.chains.map((chain) => ({
    id: chain.id,
    name: chain.name,
    parentId: chain.parentId,
    parentName: chain.parentName,
    stockCount: chain.summary.stockCount,
    assignmentCount: chain.summary.assignmentCount,
    source: chain.source,
    editable: true,
    layerCounts: chain.summary.layerCounts
  }));

  seed.chainIndex = Object.fromEntries(seed.chains.map((chain) => [chain.id, chain]));
  seed.summary = {
    stockCount: Object.keys(seed.stockIndex).length,
    assignedStockCount: Object.keys(seed.stockIndex).length,
    assignmentTotal: Object.values(seed.stockIndex).reduce((sum, stock) => {
      return sum + (Array.isArray(stock.assignments) ? stock.assignments.length : 0);
    }, 0),
    primaryChainCount: seed.primaryChains.length,
    secondaryChainCount: seed.chains.length,
    crossMarketExpanded: true
  };
  seed.generatedAt = new Date().toISOString();
  seed.source = 'manual:cross_market_seed';

  return seed;
}

const extraRelations = [
  relationItem('HK:00388', '香港交易所', 'HK', '交易所', ['金融基础设施', '券商金融', '资本市场']),
  relationItem('HK:02318', '中国平安', 'HK', '保险', ['金融科技', '保险', 'A+H']),
  relationItem('601318', '中国平安', 'SH', '保险', ['金融科技', '保险', 'A+H']),
  relationItem('HK:03968', '招商银行', 'HK', '银行', ['零售银行', 'A+H']),
  relationItem('600036', '招商银行', 'SH', '银行', ['零售银行', 'A+H']),
  relationItem('HK:01398', '工商银行', 'HK', '银行', ['国有大行', 'A+H']),
  relationItem('601398', '工商银行', 'SH', '银行', ['国有大行', 'A+H']),
  relationItem('HK:00939', '建设银行', 'HK', '银行', ['国有大行', 'A+H']),
  relationItem('601939', '建设银行', 'SH', '银行', ['国有大行', 'A+H']),
  relationItem('HK:02628', '中国人寿', 'HK', '保险', ['保险', 'A+H']),
  relationItem('601628', '中国人寿', 'SH', '保险', ['保险', 'A+H']),

  relationItem('HK:02269', '药明生物', 'HK', '医药外包', ['CXO', '创新药', '生物医药']),
  relationItem('HK:02359', '药明康德', 'HK', '医药外包', ['CXO', '创新药', 'A+H']),
  relationItem('603259', '药明康德', 'SH', '医药外包', ['CXO', '创新药', 'A+H']),
  relationItem('HK:06160', '百济神州', 'HK', '创新药', ['生物医药', 'A+H']),
  relationItem('688235', '百济神州', 'SH', '创新药', ['生物医药', 'A+H']),
  relationItem('HK:01801', '信达生物', 'HK', '创新药', ['生物医药', 'PD-1']),
  relationItem('HK:09926', '康方生物', 'HK', '创新药', ['生物医药', '双抗']),

  relationItem('HK:00728', '中国电信', 'HK', '通信运营商', ['云计算', '数字经济', 'A+H']),
  relationItem('601728', '中国电信', 'SH', '通信运营商', ['云计算', '数字经济', 'A+H']),
  relationItem('HK:00941', '中国移动', 'HK', '通信运营商', ['云计算', '数字经济', 'A+H']),
  relationItem('600941', '中国移动', 'SH', '通信运营商', ['云计算', '数字经济', 'A+H']),
  relationItem('HK:00762', '中国联通', 'HK', '通信运营商', ['云计算', '数字经济', 'A+H']),
  relationItem('600050', '中国联通', 'SH', '通信运营商', ['云计算', '数字经济', 'A+H']),

  relationItem('HK:00883', '中国海洋石油', 'HK', '能源', ['油气开采', '央企', 'A+H']),
  relationItem('600938', '中国海油', 'SH', '能源', ['油气开采', '央企', 'A+H']),
  relationItem('HK:00857', '中国石油股份', 'HK', '能源', ['油气开采', '央企', 'A+H']),
  relationItem('601857', '中国石油', 'SH', '能源', ['油气开采', '央企', 'A+H']),
  relationItem('HK:00386', '中国石油化工股份', 'HK', '能源', ['炼化', '央企', 'A+H']),
  relationItem('600028', '中国石化', 'SH', '能源', ['炼化', '央企', 'A+H']),

  relationItem('HK:01109', '华润置地', 'HK', '地产', ['地产开发', '央企地产']),
  relationItem('HK:00688', '中国海外发展', 'HK', '地产', ['地产开发', '央企地产']),
  relationItem('HK:00960', '龙湖集团', 'HK', '地产', ['地产开发', '物业']),
  relationItem('HK:02202', '万科企业', 'HK', '地产', ['地产开发', 'A+H']),
  relationItem('000002', '万科A', 'SZ', '地产', ['地产开发', 'A+H']),

  relationItem('HK:00291', '华润啤酒', 'HK', '消费', ['啤酒', '大众消费']),
  relationItem('HK:02319', '蒙牛乳业', 'HK', '消费', ['乳制品', '大众消费']),
  relationItem('HK:09987', '百胜中国', 'HK', '消费', ['餐饮', '大众消费']),
  relationItem('HK:06186', '中国飞鹤', 'HK', '消费', ['乳制品', '母婴消费']),
  relationItem('HK:06618', '京东健康', 'HK', '互联网医疗', ['医疗服务', '平台经济']),
  relationItem('HK:09961', '携程集团-S', 'HK', '在线旅游', ['旅游消费', '平台经济'])
];

function chain(id, name, parentId, parentName, description, layerMap, keywords) {
  const layerNames = {
    upstream: '上游',
    midstream: '中游',
    downstream: '下游',
    service: '配套服务',
    terminal: '终端应用'
  };

  const layers = {};
  const layerCounts = {};

  for (const layer of ['upstream', 'midstream', 'downstream', 'service', 'terminal']) {
    const codes = layerMap[layer] || [];
    layers[layer] = {
      name: layerNames[layer],
      stockCount: codes.length,
      stocks: codes.map((code) => {
        const stock = extraStocks[code] || {};
        return {
          stockId: `stock:${code}`,
          code,
          name: stock.name || code,
          market: stock.market || (String(code).startsWith('HK:') ? 'HK' : 'CN_A'),
          layer,
          confidence: 0.86,
          source: 'manual_cross_market_seed',
          editable: true,
          matchedTerms: stock.concepts || [],
          layerTerms: stock.industries || [],
          evidence: { manual: 1 }
        };
      })
    };
    layerCounts[layer] = codes.length;
  }

  const stockCount = Object.values(layerMap).reduce((sum, codes) => sum + codes.length, 0);

  return {
    id,
    name,
    parentId,
    parentName,
    description,
    source: 'manual_cross_market_seed',
    editable: true,
    keywords,
    summary: {
      stockCount,
      assignmentCount: stockCount,
      layerCounts
    },
    layers
  };
}

const extraStocks = {
  'HK:00388': makeStock('HK:00388', '香港交易所', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'service', ['交易所'], ['金融基础设施', '资本市场']),
  'HK:02318': makeStock('HK:02318', '中国平安', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['保险'], ['保险', '金融科技']),
  '601318': makeStock('601318', '中国平安', 'SH', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['保险'], ['保险', '金融科技']),
  'HK:03968': makeStock('HK:03968', '招商银行', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['零售银行']),
  '600036': makeStock('600036', '招商银行', 'SH', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['零售银行']),
  'HK:01398': makeStock('HK:01398', '工商银行', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['国有大行']),
  '601398': makeStock('601398', '工商银行', 'SH', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['国有大行']),
  'HK:00939': makeStock('HK:00939', '建设银行', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['国有大行']),
  '601939': makeStock('601939', '建设银行', 'SH', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['银行'], ['国有大行']),
  'HK:02628': makeStock('HK:02628', '中国人寿', 'HK', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['保险'], ['保险']),
  '601628': makeStock('601628', '中国人寿', 'SH', 'c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'midstream', ['保险'], ['保险']),

  'HK:02269': makeStock('HK:02269', '药明生物', 'HK', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO', '创新药']),
  'HK:02359': makeStock('HK:02359', '药明康德', 'HK', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO', '创新药']),
  '603259': makeStock('603259', '药明康德', 'SH', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO', '创新药']),
  'HK:06160': makeStock('HK:06160', '百济神州', 'HK', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'downstream', ['创新药'], ['生物医药']),
  '688235': makeStock('688235', '百济神州', 'SH', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'downstream', ['创新药'], ['生物医药']),
  'HK:01801': makeStock('HK:01801', '信达生物', 'HK', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'downstream', ['创新药'], ['生物医药']),
  'HK:09926': makeStock('HK:09926', '康方生物', 'HK', 'c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', 'downstream', ['创新药'], ['生物医药']),

  'HK:00728': makeStock('HK:00728', '中国电信', 'HK', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),
  '601728': makeStock('601728', '中国电信', 'SH', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),
  'HK:00941': makeStock('HK:00941', '中国移动', 'HK', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),
  '600941': makeStock('600941', '中国移动', 'SH', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),
  'HK:00762': makeStock('HK:00762', '中国联通', 'HK', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),
  '600050': makeStock('600050', '中国联通', 'SH', 'c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'midstream', ['通信运营商'], ['云计算', '数字经济']),

  'HK:00883': makeStock('HK:00883', '中国海洋石油', 'HK', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'upstream', ['能源'], ['油气开采', '央企']),
  '600938': makeStock('600938', '中国海油', 'SH', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'upstream', ['能源'], ['油气开采', '央企']),
  'HK:00857': makeStock('HK:00857', '中国石油股份', 'HK', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'midstream', ['能源'], ['油气开采', '央企']),
  '601857': makeStock('601857', '中国石油', 'SH', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'midstream', ['能源'], ['油气开采', '央企']),
  'HK:00386': makeStock('HK:00386', '中国石油化工股份', 'HK', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'downstream', ['能源'], ['炼化', '央企']),
  '600028': makeStock('600028', '中国石化', 'SH', 'c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'downstream', ['能源'], ['炼化', '央企']),

  'HK:01109': makeStock('HK:01109', '华润置地', 'HK', 'c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', 'midstream', ['地产'], ['央企地产']),
  'HK:00688': makeStock('HK:00688', '中国海外发展', 'HK', 'c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', 'midstream', ['地产'], ['央企地产']),
  'HK:00960': makeStock('HK:00960', '龙湖集团', 'HK', 'c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', 'midstream', ['地产'], ['物业']),
  'HK:02202': makeStock('HK:02202', '万科企业', 'HK', 'c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', 'midstream', ['地产'], ['A+H']),
  '000002': makeStock('000002', '万科A', 'SZ', 'c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', 'midstream', ['地产'], ['A+H']),

  'HK:00291': makeStock('HK:00291', '华润啤酒', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'midstream', ['消费'], ['啤酒']),
  'HK:02319': makeStock('HK:02319', '蒙牛乳业', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'midstream', ['消费'], ['乳制品']),
  'HK:09987': makeStock('HK:09987', '百胜中国', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'downstream', ['消费'], ['餐饮']),
  'HK:06186': makeStock('HK:06186', '中国飞鹤', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'downstream', ['消费'], ['乳制品']),
  'HK:06618': makeStock('HK:06618', '京东健康', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'service', ['互联网医疗'], ['医疗服务']),
  'HK:09961': makeStock('HK:09961', '携程集团-S', 'HK', 'c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', 'terminal', ['在线旅游'], ['旅游消费'])
};

const extraChains = [
  chain('c_cross_finance', '跨市场金融', 'p_cross_finance', '跨市场金融', 'A+H 银行、保险、交易所与金融基础设施观察链。', {
    midstream: ['HK:02318', '601318', 'HK:03968', '600036', 'HK:01398', '601398', 'HK:00939', '601939', 'HK:02628', '601628'],
    service: ['HK:00388']
  }, ['银行', '保险', '交易所', '金融基础设施']),
  chain('c_cross_biomedicine', '跨市场生物医药', 'p_cross_medicine', '跨市场医药', '港股创新药、CXO 与 A+H 医药观察链。', {
    midstream: ['HK:02269', 'HK:02359', '603259'],
    downstream: ['HK:06160', '688235', 'HK:01801', 'HK:09926']
  }, ['CXO', '创新药', '生物医药']),
  chain('c_cross_telecom', '跨市场通信运营商', 'p_cross_digital_infra', '跨市场数字基础设施', 'A+H 通信运营商、云计算、数字基础设施观察链。', {
    midstream: ['HK:00728', '601728', 'HK:00941', '600941', 'HK:00762', '600050']
  }, ['通信运营商', '云计算', '数字经济']),
  chain('c_cross_energy', '跨市场能源', 'p_cross_energy', '跨市场能源', 'A+H 油气开采、炼化与央企能源观察链。', {
    upstream: ['HK:00883', '600938'],
    midstream: ['HK:00857', '601857'],
    downstream: ['HK:00386', '600028']
  }, ['能源', '油气开采', '炼化']),
  chain('c_cross_real_estate', '跨市场地产', 'p_cross_real_estate', '跨市场地产', '港股地产与 A+H 地产观察链。', {
    midstream: ['HK:01109', 'HK:00688', 'HK:00960', 'HK:02202', '000002']
  }, ['地产', '央企地产', '物业']),
  chain('c_cross_consumption', '跨市场消费', 'p_cross_consumption', '跨市场消费', '港股消费、餐饮、乳制品、旅游与互联网医疗观察链。', {
    midstream: ['HK:00291', 'HK:02319'],
    downstream: ['HK:09987', 'HK:06186'],
    service: ['HK:06618'],
    terminal: ['HK:09961']
  }, ['消费', '餐饮', '乳制品', '旅游消费'])
];

const relationSeed = mergeRelation(readJson(relationPath, {
  version: 'dev-0.1.9.2-cross-market-relation-core',
  generatedAt: new Date().toISOString(),
  source: 'manual:cross_market_seed',
  total: 0,
  done: 0,
  failed: 0,
  items: {}
}), extraRelations);

const supplySeed = mergeSupply(readJson(supplyPath, {
  version: 'dev-0.1.9.2-cross-market-supply-chain-core',
  generatedAt: new Date().toISOString(),
  source: 'manual:cross_market_seed',
  summary: {},
  primaryChains: [],
  chains: [],
  stockIndex: {},
  defaultGraph: {},
  chainIndex: {}
}), extraStocks, extraChains);

writeJson(relationPath, relationSeed);
writeJson(supplyPath, supplySeed);

console.log('跨市场关系 seed 总节点:', relationSeed.total);
console.log('跨市场产业链 seed 总股票:', Object.keys(supplySeed.stockIndex).length);
console.log('跨市场产业链二级链:', supplySeed.chains.length);
