const fs = require('fs');
const path = require('path');

const dir = path.join(process.cwd(), 'data', 'market-graph');
fs.mkdirSync(dir, { recursive: true });

const generatedAt = new Date().toISOString();

function relationItem(code, name, market, industry, concepts) {
  return {
    code,
    symbol: code,
    name,
    displayName: market === 'HK' ? `${name}（HK）` : name,
    market,
    exchange: market === 'HK' ? 'HKEX' : '',
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

const relationItems = [
  relationItem('HK:00700', '腾讯控股', 'HK', '互联网平台', ['人工智能', '数字经济', '游戏', '云计算']),
  relationItem('HK:09988', '阿里巴巴-W', 'HK', '互联网平台', ['电商', '云计算', '人工智能', '数字经济']),
  relationItem('HK:03690', '美团-W', 'HK', '本地生活平台', ['互联网平台', '即时零售', '数字经济']),
  relationItem('HK:01810', '小米集团-W', 'HK', '消费电子', ['智能终端', '新能源汽车', '物联网']),
  relationItem('HK:09618', '京东集团-SW', 'HK', '电商物流', ['电商', '物流', '数字经济']),
  relationItem('HK:01024', '快手-W', 'HK', '内容平台', ['人工智能', '数字经济', '直播电商']),
  relationItem('HK:01211', '比亚迪股份', 'HK', '新能源汽车', ['锂电池', '动力电池', '汽车整车']),
  relationItem('002594', '比亚迪', 'SZ', '新能源汽车', ['锂电池', '动力电池', '汽车整车']),
  relationItem('HK:09866', '蔚来-SW', 'HK', '新能源汽车', ['汽车整车', '智能驾驶']),
  relationItem('HK:02015', '理想汽车-W', 'HK', '新能源汽车', ['汽车整车', '智能驾驶']),
  relationItem('HK:09868', '小鹏汽车-W', 'HK', '新能源汽车', ['汽车整车', '智能驾驶']),
  relationItem('HK:00981', '中芯国际', 'HK', '半导体', ['芯片', '晶圆代工', '集成电路']),
  relationItem('688981', '中芯国际', 'SH', '半导体', ['芯片', '晶圆代工', '集成电路']),
  relationItem('HK:01347', '华虹半导体', 'HK', '半导体', ['芯片', '晶圆代工', '集成电路'])
];

const relationSeed = {
  version: 'dev-0.1.9.2-cross-market-relation-core',
  generatedAt,
  source: 'manual:cross_market_seed',
  description: '跨市场关系 seed：第一阶段只用于关系图展示，不进入预测层。',
  total: relationItems.length,
  done: relationItems.length,
  failed: 0,
  items: Object.fromEntries(relationItems.map((item) => [item.code, item]))
};

function stock(code, name, market, chainId, chainName, parentId, parentName, layer, industries, concepts) {
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

const stockIndex = {
  'HK:00700': stock('HK:00700', '腾讯控股', 'HK', 'c_cross_platform_ecosystem', '跨市场平台经济', 'p_cross_platform_ai', '跨市场平台经济与AI', 'midstream', ['互联网平台'], ['人工智能', '数字经济', '游戏', '云计算']),
  'HK:09988': stock('HK:09988', '阿里巴巴-W', 'HK', 'c_cross_platform_ecosystem', '跨市场平台经济', 'p_cross_platform_ai', '跨市场平台经济与AI', 'midstream', ['互联网平台'], ['电商', '云计算', '人工智能']),
  'HK:03690': stock('HK:03690', '美团-W', 'HK', 'c_cross_platform_ecosystem', '跨市场平台经济', 'p_cross_platform_ai', '跨市场平台经济与AI', 'downstream', ['本地生活平台'], ['即时零售', '数字经济']),
  'HK:01810': stock('HK:01810', '小米集团-W', 'HK', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['消费电子', '新能源汽车'], ['智能终端', '物联网']),
  'HK:01211': stock('HK:01211', '比亚迪股份', 'HK', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'midstream', ['新能源汽车'], ['锂电池', '动力电池', '汽车整车']),
  '002594': stock('002594', '比亚迪', 'SZ', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'midstream', ['新能源汽车'], ['锂电池', '动力电池', '汽车整车']),
  'HK:09866': stock('HK:09866', '蔚来-SW', 'HK', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['新能源汽车'], ['汽车整车', '智能驾驶']),
  'HK:02015': stock('HK:02015', '理想汽车-W', 'HK', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['新能源汽车'], ['汽车整车', '智能驾驶']),
  'HK:09868': stock('HK:09868', '小鹏汽车-W', 'HK', 'c_cross_ev', '跨市场新能源汽车', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['新能源汽车'], ['汽车整车', '智能驾驶']),
  'HK:00981': stock('HK:00981', '中芯国际', 'HK', 'c_cross_semiconductor_foundry', '跨市场晶圆代工', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['半导体'], ['芯片', '晶圆代工', '集成电路']),
  '688981': stock('688981', '中芯国际', 'SH', 'c_cross_semiconductor_foundry', '跨市场晶圆代工', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['半导体'], ['芯片', '晶圆代工', '集成电路']),
  'HK:01347': stock('HK:01347', '华虹半导体', 'HK', 'c_cross_semiconductor_foundry', '跨市场晶圆代工', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['半导体'], ['芯片', '晶圆代工', '集成电路'])
};

function layerStocks(codes, layer) {
  return codes.map((code) => ({
    stockId: `stock:${code}`,
    code,
    name: stockIndex[code].name,
    market: stockIndex[code].market,
    layer,
    confidence: 0.86,
    source: 'manual_cross_market_seed',
    editable: true,
    matchedTerms: stockIndex[code].concepts,
    layerTerms: stockIndex[code].industries,
    evidence: { manual: 1 }
  }));
}

const chains = [
  {
    id: 'c_cross_platform_ecosystem',
    name: '跨市场平台经济',
    parentId: 'p_cross_platform_ai',
    parentName: '跨市场平台经济与AI',
    description: '港股互联网平台、AI、云计算、电商、本地生活的跨市场观察链。',
    source: 'manual_cross_market_seed',
    editable: true,
    keywords: ['互联网平台', '人工智能', '数字经济', '云计算', '电商'],
    summary: { stockCount: 3, assignmentCount: 3, layerCounts: { upstream: 0, midstream: 2, downstream: 1, service: 0, terminal: 0 } },
    layers: {
      upstream: { name: '上游', stockCount: 0, stocks: [] },
      midstream: { name: '中游', stockCount: 2, stocks: layerStocks(['HK:00700', 'HK:09988'], 'midstream') },
      downstream: { name: '下游', stockCount: 1, stocks: layerStocks(['HK:03690'], 'downstream') },
      service: { name: '配套服务', stockCount: 0, stocks: [] },
      terminal: { name: '终端应用', stockCount: 0, stocks: [] }
    }
  },
  {
    id: 'c_cross_ev',
    name: '跨市场新能源汽车',
    parentId: 'p_cross_ev',
    parentName: '跨市场新能源汽车',
    description: 'A+H 新能源汽车与港股新势力观察链。',
    source: 'manual_cross_market_seed',
    editable: true,
    keywords: ['新能源汽车', '动力电池', '汽车整车', '智能驾驶'],
    summary: { stockCount: 5, assignmentCount: 5, layerCounts: { upstream: 0, midstream: 2, downstream: 3, service: 0, terminal: 0 } },
    layers: {
      upstream: { name: '上游', stockCount: 0, stocks: [] },
      midstream: { name: '中游', stockCount: 2, stocks: layerStocks(['HK:01211', '002594'], 'midstream') },
      downstream: { name: '下游', stockCount: 3, stocks: layerStocks(['HK:09866', 'HK:02015', 'HK:09868'], 'downstream') },
      service: { name: '配套服务', stockCount: 0, stocks: [] },
      terminal: { name: '终端应用', stockCount: 0, stocks: [] }
    }
  },
  {
    id: 'c_cross_semiconductor_foundry',
    name: '跨市场晶圆代工',
    parentId: 'p_cross_semiconductor',
    parentName: '跨市场半导体',
    description: 'A+H 半导体晶圆代工观察链。',
    source: 'manual_cross_market_seed',
    editable: true,
    keywords: ['半导体', '芯片', '晶圆代工', '集成电路'],
    summary: { stockCount: 3, assignmentCount: 3, layerCounts: { upstream: 0, midstream: 3, downstream: 0, service: 0, terminal: 0 } },
    layers: {
      upstream: { name: '上游', stockCount: 0, stocks: [] },
      midstream: { name: '中游', stockCount: 3, stocks: layerStocks(['HK:00981', '688981', 'HK:01347'], 'midstream') },
      downstream: { name: '下游', stockCount: 0, stocks: [] },
      service: { name: '配套服务', stockCount: 0, stocks: [] },
      terminal: { name: '终端应用', stockCount: 0, stocks: [] }
    }
  }
];

const primaryChains = [
  { id: 'p_cross_platform_ai', name: '跨市场平台经济与AI', stockCount: 3, assignmentCount: 3 },
  { id: 'p_cross_ev', name: '跨市场新能源汽车', stockCount: 5, assignmentCount: 5 },
  { id: 'p_cross_semiconductor', name: '跨市场半导体', stockCount: 3, assignmentCount: 3 }
];

const supplySeed = {
  version: 'dev-0.1.9.2-cross-market-supply-chain-core',
  generatedAt,
  source: 'manual:cross_market_seed',
  description: '跨市场产业链 seed：第一阶段只用于产业链图展示，不进入预测层。',
  summary: {
    stockCount: Object.keys(stockIndex).length,
    assignedStockCount: Object.keys(stockIndex).length,
    assignmentTotal: Object.keys(stockIndex).length,
    primaryChainCount: primaryChains.length,
    secondaryChainCount: chains.length
  },
  primaryChains,
  chains,
  stockIndex,
  defaultGraph: {
    primaryChains,
    secondaryChainsTop: chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      parentId: chain.parentId,
      parentName: chain.parentName,
      stockCount: chain.summary.stockCount,
      assignmentCount: chain.summary.assignmentCount,
      source: chain.source,
      editable: true,
      layerCounts: chain.summary.layerCounts
    }))
  },
  chainIndex: Object.fromEntries(chains.map((chain) => [chain.id, chain]))
};

fs.writeFileSync(path.join(dir, 'cross-market-relation.seed.json'), `${JSON.stringify(relationSeed, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(dir, 'cross-market-supply-chain.seed.json'), `${JSON.stringify(supplySeed, null, 2)}\n`, 'utf8');

console.log('已生成跨市场关系 seed:', relationItems.length);
console.log('已生成跨市场产业链 seed:', Object.keys(stockIndex).length);
