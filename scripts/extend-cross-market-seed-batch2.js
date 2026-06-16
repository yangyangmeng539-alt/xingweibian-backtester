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

function normalizeMarket(code, market) {
  if (market) return market;
  if (String(code).startsWith('HK:')) return 'HK';
  if (String(code).startsWith('6')) return 'SH';
  return 'SZ';
}

function relationItem(code, name, market, industry, concepts) {
  const actualMarket = normalizeMarket(code, market);
  const cleanConcepts = Array.from(new Set((concepts || [])
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== industry && item !== 'A+H')));

  return {
    code,
    symbol: code,
    name,
    displayName: actualMarket === 'HK' ? `${name}（HK）` : name,
    market: actualMarket,
    exchange: actualMarket === 'HK' ? 'HKEX' : actualMarket,
    currency: actualMarket === 'HK' ? 'HKD' : 'CNY',
    status: 'DONE',
    updatedAt: new Date().toISOString(),
    source: 'manual_cross_market_seed',
    conceptThs: [],
    plateEast: [
      { plate_code: industry, plate_name: industry, plate_type: '行业', source: '跨市场seed' },
      ...cleanConcepts.map((conceptName) => ({
        plate_code: conceptName,
        plate_name: conceptName,
        plate_type: '概念',
        source: '跨市场seed'
      }))
    ]
  };
}

function makeStock(code, name, market, chainId, chainName, parentId, parentName, layer, industries, concepts) {
  const actualMarket = normalizeMarket(code, market);

  return {
    id: `stock:${code}`,
    code,
    name,
    market: actualMarket,
    industries,
    concepts,
    regions: actualMarket === 'HK' ? ['香港'] : [],
    assignments: [
      {
        chainId,
        chainName,
        parentId,
        parentName,
        layer,
        layerName: layer === 'upstream' ? '上游' : layer === 'downstream' ? '下游' : layer === 'service' ? '配套服务' : layer === 'terminal' ? '终端应用' : '中游',
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
  seed.description = '跨市场关系 seed：核心节点扩容版，只用于关系图与产业链展示，不进入预测层。';

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
      industries: Array.from(new Set([...(existing.industries || []), ...(stock.industries || [])])),
      concepts: Array.from(new Set([...(existing.concepts || []), ...(stock.concepts || [])])),
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
  seed.description = '跨市场产业链 seed：核心节点扩容版，只用于产业链展示，不进入预测层。';

  return seed;
}

function makeChain(id, name, parentId, parentName, description, layerMap, keywords, stockSource) {
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
        const stock = stockSource[code] || {};
        return {
          stockId: `stock:${code}`,
          code,
          name: stock.name || code,
          market: stock.market || normalizeMarket(code),
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

const extraRelations = [
  relationItem('HK:06030', '中信证券', 'HK', '证券', ['券商金融', '资本市场', 'A+H映射：中信证券']),
  relationItem('600030', '中信证券', 'SH', '证券', ['券商金融', '资本市场', 'A+H映射：中信证券']),
  relationItem('HK:03908', '中金公司', 'HK', '证券', ['券商金融', '投行', 'A+H映射：中金公司']),
  relationItem('601995', '中金公司', 'SH', '证券', ['券商金融', '投行', 'A+H映射：中金公司']),
  relationItem('HK:06066', '中信建投证券', 'HK', '证券', ['券商金融', '投行', 'A+H映射：中信建投']),
  relationItem('601066', '中信建投', 'SH', '证券', ['券商金融', '投行', 'A+H映射：中信建投']),
  relationItem('HK:06886', '华泰证券', 'HK', '证券', ['券商金融', '财富管理', 'A+H映射：华泰证券']),
  relationItem('601688', '华泰证券', 'SH', '证券', ['券商金融', '财富管理', 'A+H映射：华泰证券']),
  relationItem('HK:01776', '广发证券', 'HK', '证券', ['券商金融', '财富管理', 'A+H映射：广发证券']),
  relationItem('000776', '广发证券', 'SZ', '证券', ['券商金融', '财富管理', 'A+H映射：广发证券']),
  relationItem('HK:06837', '海通证券', 'HK', '证券', ['券商金融', '资本市场', 'A+H映射：海通证券']),
  relationItem('600837', '海通证券', 'SH', '证券', ['券商金融', '资本市场', 'A+H映射：海通证券']),

  relationItem('HK:00175', '吉利汽车', 'HK', '汽车整车', ['新能源汽车', '智能驾驶']),
  relationItem('HK:02333', '长城汽车', 'HK', '汽车整车', ['新能源汽车', '智能驾驶', 'A+H映射：长城汽车']),
  relationItem('601633', '长城汽车', 'SH', '汽车整车', ['新能源汽车', '智能驾驶', 'A+H映射：长城汽车']),
  relationItem('HK:02238', '广汽集团', 'HK', '汽车整车', ['新能源汽车', 'A+H映射：广汽集团']),
  relationItem('601238', '广汽集团', 'SH', '汽车整车', ['新能源汽车', 'A+H映射：广汽集团']),
  relationItem('300750', '宁德时代', 'SZ', '动力电池', ['锂电池', '储能', '新能源汽车']),
  relationItem('300014', '亿纬锂能', 'SZ', '动力电池', ['锂电池', '储能', '新能源汽车']),
  relationItem('HK:01772', '赣锋锂业', 'HK', '锂资源', ['锂电池', '动力电池', 'A+H映射：赣锋锂业']),
  relationItem('002460', '赣锋锂业', 'SZ', '锂资源', ['锂电池', '动力电池', 'A+H映射：赣锋锂业']),
  relationItem('HK:09696', '天齐锂业', 'HK', '锂资源', ['锂电池', '动力电池', 'A+H映射：天齐锂业']),
  relationItem('002466', '天齐锂业', 'SZ', '锂资源', ['锂电池', '动力电池', 'A+H映射：天齐锂业']),

  relationItem('HK:00390', '中国中铁', 'HK', '基建工程', ['中字头', 'A+H映射：中国中铁']),
  relationItem('601390', '中国中铁', 'SH', '基建工程', ['中字头', 'A+H映射：中国中铁']),
  relationItem('HK:01186', '中国铁建', 'HK', '基建工程', ['中字头', 'A+H映射：中国铁建']),
  relationItem('601186', '中国铁建', 'SH', '基建工程', ['中字头', 'A+H映射：中国铁建']),
  relationItem('HK:01800', '中国交通建设', 'HK', '基建工程', ['中字头', 'A+H映射：中国交建']),
  relationItem('601800', '中国交建', 'SH', '基建工程', ['中字头', 'A+H映射：中国交建']),
  relationItem('HK:01766', '中国中车', 'HK', '轨交装备', ['高端装备', 'A+H映射：中国中车']),
  relationItem('601766', '中国中车', 'SH', '轨交装备', ['高端装备', 'A+H映射：中国中车']),
  relationItem('HK:03311', '中国建筑国际', 'HK', '基建工程', ['央企建筑']),

  relationItem('HK:00836', '华润电力', 'HK', '电力', ['公用事业', '新能源电力']),
  relationItem('HK:00902', '华能国际电力股份', 'HK', '电力', ['火电', '新能源电力', 'A+H映射：华能国际']),
  relationItem('600011', '华能国际', 'SH', '电力', ['火电', '新能源电力', 'A+H映射：华能国际']),
  relationItem('HK:00991', '大唐发电', 'HK', '电力', ['火电', '新能源电力', 'A+H映射：大唐发电']),
  relationItem('601991', '大唐发电', 'SH', '电力', ['火电', '新能源电力', 'A+H映射：大唐发电']),
  relationItem('HK:02380', '中国电力', 'HK', '电力', ['公用事业', '新能源电力']),
  relationItem('HK:00916', '龙源电力', 'HK', '新能源电力', ['风电', 'A+H映射：龙源电力']),
  relationItem('001289', '龙源电力', 'SZ', '新能源电力', ['风电', 'A+H映射：龙源电力']),

  relationItem('HK:01088', '中国神华', 'HK', '煤炭', ['能源', '央企', 'A+H映射：中国神华']),
  relationItem('601088', '中国神华', 'SH', '煤炭', ['能源', '央企', 'A+H映射：中国神华']),
  relationItem('HK:01171', '兖矿能源', 'HK', '煤炭', ['能源', 'A+H映射：兖矿能源']),
  relationItem('600188', '兖矿能源', 'SH', '煤炭', ['能源', 'A+H映射：兖矿能源']),
  relationItem('HK:02899', '紫金矿业', 'HK', '有色金属', ['黄金', '铜', 'A+H映射：紫金矿业']),
  relationItem('601899', '紫金矿业', 'SH', '有色金属', ['黄金', '铜', 'A+H映射：紫金矿业']),
  relationItem('HK:03993', '洛阳钼业', 'HK', '有色金属', ['铜', '钴', 'A+H映射：洛阳钼业']),
  relationItem('603993', '洛阳钼业', 'SH', '有色金属', ['铜', '钴', 'A+H映射：洛阳钼业']),
  relationItem('HK:00358', '江西铜业股份', 'HK', '有色金属', ['铜', 'A+H映射：江西铜业']),
  relationItem('600362', '江西铜业', 'SH', '有色金属', ['铜', 'A+H映射：江西铜业']),
  relationItem('HK:02600', '中国铝业', 'HK', '有色金属', ['铝', 'A+H映射：中国铝业']),
  relationItem('601600', '中国铝业', 'SH', '有色金属', ['铝', 'A+H映射：中国铝业']),
  relationItem('HK:01787', '山东黄金', 'HK', '黄金', ['有色金属', 'A+H映射：山东黄金']),
  relationItem('600547', '山东黄金', 'SH', '黄金', ['有色金属', 'A+H映射：山东黄金']),

  relationItem('HK:02196', '复星医药', 'HK', '医药', ['创新药', '医疗服务', 'A+H映射：复星医药']),
  relationItem('600196', '复星医药', 'SH', '医药', ['创新药', '医疗服务', 'A+H映射：复星医药']),
  relationItem('HK:01093', '石药集团', 'HK', '医药', ['创新药', '仿制药']),
  relationItem('HK:01177', '中国生物制药', 'HK', '医药', ['创新药', '仿制药']),
  relationItem('HK:03692', '翰森制药', 'HK', '医药', ['创新药']),
  relationItem('HK:03759', '康龙化成', 'HK', '医药外包', ['CXO', 'A+H映射：康龙化成']),
  relationItem('300759', '康龙化成', 'SZ', '医药外包', ['CXO', 'A+H映射：康龙化成']),
  relationItem('HK:03347', '泰格医药', 'HK', '医药外包', ['CXO', 'A+H映射：泰格医药']),
  relationItem('300347', '泰格医药', 'SZ', '医药外包', ['CXO', 'A+H映射：泰格医药']),

  relationItem('HK:02020', '安踏体育', 'HK', '消费品牌', ['运动服饰', '大众消费']),
  relationItem('HK:02331', '李宁', 'HK', '消费品牌', ['运动服饰', '大众消费']),
  relationItem('HK:02313', '申洲国际', 'HK', '纺织服装', ['运动服饰', '供应链']),
  relationItem('HK:06690', '海尔智家', 'HK', '家电', ['智能家居', 'A+H映射：海尔智家']),
  relationItem('600690', '海尔智家', 'SH', '家电', ['智能家居', 'A+H映射：海尔智家']),
  relationItem('HK:09633', '农夫山泉', 'HK', '饮料', ['大众消费']),
  relationItem('HK:06862', '海底捞', 'HK', '餐饮', ['大众消费']),
  relationItem('HK:09922', '九毛九', 'HK', '餐饮', ['大众消费']),

  relationItem('HK:00316', '东方海外国际', 'HK', '航运物流', ['集运', '出口链']),
  relationItem('HK:01919', '中远海控', 'HK', '航运物流', ['集运', 'A+H映射：中远海控']),
  relationItem('601919', '中远海控', 'SH', '航运物流', ['集运', 'A+H映射：中远海控']),
  relationItem('HK:01138', '中远海能', 'HK', '航运物流', ['油运', 'A+H映射：中远海能']),
  relationItem('600026', '中远海能', 'SH', '航运物流', ['油运', 'A+H映射：中远海能']),
  relationItem('HK:00144', '招商局港口', 'HK', '港口', ['航运物流', '央企']),

  relationItem('HK:00992', '联想集团', 'HK', '消费电子', ['AI PC', '服务器', '数字经济']),
  relationItem('HK:02382', '舜宇光学科技', 'HK', '消费电子', ['光学', '汽车电子']),
  relationItem('HK:01478', '丘钛科技', 'HK', '消费电子', ['摄像头模组', '智能终端']),
  relationItem('HK:00522', 'ASMPT', 'HK', '半导体设备', ['先进封装', '半导体']),
  relationItem('HK:01385', '上海复旦', 'HK', '芯片设计', ['集成电路', 'A+H映射：上海复旦']),
  relationItem('688385', '复旦微电', 'SH', '芯片设计', ['集成电路', 'A+H映射：上海复旦']),
  relationItem('HK:00763', '中兴通讯', 'HK', '通信设备', ['5G', '算力网络', 'A+H映射：中兴通讯']),
  relationItem('000063', '中兴通讯', 'SZ', '通信设备', ['5G', '算力网络', 'A+H映射：中兴通讯']),

  relationItem('HK:09888', '百度集团-SW', 'HK', '互联网平台', ['人工智能', '自动驾驶', '云计算']),
  relationItem('HK:09999', '网易-S', 'HK', '互联网平台', ['游戏', '数字内容']),
  relationItem('HK:09626', '哔哩哔哩-W', 'HK', '内容平台', ['数字内容', '社区平台']),
  relationItem('HK:00772', '阅文集团', 'HK', '内容平台', ['数字内容', 'IP'])
];

const extraStocks = {
  'HK:06030': makeStock('HK:06030', '中信证券', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '资本市场']),
  '600030': makeStock('600030', '中信证券', 'SH', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '资本市场']),
  'HK:03908': makeStock('HK:03908', '中金公司', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '投行']),
  '601995': makeStock('601995', '中金公司', 'SH', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '投行']),
  'HK:06066': makeStock('HK:06066', '中信建投证券', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '投行']),
  '601066': makeStock('601066', '中信建投', 'SH', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '投行']),
  'HK:06886': makeStock('HK:06886', '华泰证券', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '财富管理']),
  '601688': makeStock('601688', '华泰证券', 'SH', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '财富管理']),
  'HK:01776': makeStock('HK:01776', '广发证券', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '财富管理']),
  '000776': makeStock('000776', '广发证券', 'SZ', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '财富管理']),
  'HK:06837': makeStock('HK:06837', '海通证券', 'HK', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '资本市场']),
  '600837': makeStock('600837', '海通证券', 'SH', 'c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'midstream', ['证券'], ['券商金融', '资本市场']),

  'HK:00175': makeStock('HK:00175', '吉利汽车', 'HK', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['汽车整车'], ['新能源汽车', '智能驾驶']),
  'HK:02333': makeStock('HK:02333', '长城汽车', 'HK', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['汽车整车'], ['新能源汽车', '智能驾驶']),
  '601633': makeStock('601633', '长城汽车', 'SH', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['汽车整车'], ['新能源汽车', '智能驾驶']),
  'HK:02238': makeStock('HK:02238', '广汽集团', 'HK', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['汽车整车'], ['新能源汽车']),
  '601238': makeStock('601238', '广汽集团', 'SH', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'downstream', ['汽车整车'], ['新能源汽车']),
  '300750': makeStock('300750', '宁德时代', 'SZ', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'midstream', ['动力电池'], ['锂电池', '储能']),
  '300014': makeStock('300014', '亿纬锂能', 'SZ', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'midstream', ['动力电池'], ['锂电池', '储能']),
  'HK:01772': makeStock('HK:01772', '赣锋锂业', 'HK', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'upstream', ['锂资源'], ['锂电池']),
  '002460': makeStock('002460', '赣锋锂业', 'SZ', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'upstream', ['锂资源'], ['锂电池']),
  'HK:09696': makeStock('HK:09696', '天齐锂业', 'HK', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'upstream', ['锂资源'], ['锂电池']),
  '002466': makeStock('002466', '天齐锂业', 'SZ', 'c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', 'upstream', ['锂资源'], ['锂电池']),

  'HK:00390': makeStock('HK:00390', '中国中铁', 'HK', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  '601390': makeStock('601390', '中国中铁', 'SH', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  'HK:01186': makeStock('HK:01186', '中国铁建', 'HK', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  '601186': makeStock('601186', '中国铁建', 'SH', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  'HK:01800': makeStock('HK:01800', '中国交通建设', 'HK', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  '601800': makeStock('601800', '中国交建', 'SH', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'midstream', ['基建工程'], ['中字头']),
  'HK:01766': makeStock('HK:01766', '中国中车', 'HK', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'downstream', ['轨交装备'], ['高端装备']),
  '601766': makeStock('601766', '中国中车', 'SH', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'downstream', ['轨交装备'], ['高端装备']),
  'HK:03311': makeStock('HK:03311', '中国建筑国际', 'HK', 'c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'service', ['基建工程'], ['央企建筑']),

  'HK:00836': makeStock('HK:00836', '华润电力', 'HK', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['公用事业', '新能源电力']),
  'HK:00902': makeStock('HK:00902', '华能国际电力股份', 'HK', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['火电', '新能源电力']),
  '600011': makeStock('600011', '华能国际', 'SH', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['火电', '新能源电力']),
  'HK:00991': makeStock('HK:00991', '大唐发电', 'HK', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['火电', '新能源电力']),
  '601991': makeStock('601991', '大唐发电', 'SH', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['火电', '新能源电力']),
  'HK:02380': makeStock('HK:02380', '中国电力', 'HK', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'midstream', ['电力'], ['公用事业', '新能源电力']),
  'HK:00916': makeStock('HK:00916', '龙源电力', 'HK', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'upstream', ['新能源电力'], ['风电']),
  '001289': makeStock('001289', '龙源电力', 'SZ', 'c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', 'upstream', ['新能源电力'], ['风电']),

  'HK:01088': makeStock('HK:01088', '中国神华', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'upstream', ['煤炭'], ['能源']),
  '601088': makeStock('601088', '中国神华', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'upstream', ['煤炭'], ['能源']),
  'HK:01171': makeStock('HK:01171', '兖矿能源', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'upstream', ['煤炭'], ['能源']),
  '600188': makeStock('600188', '兖矿能源', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'upstream', ['煤炭'], ['能源']),
  'HK:02899': makeStock('HK:02899', '紫金矿业', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['黄金', '铜']),
  '601899': makeStock('601899', '紫金矿业', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['黄金', '铜']),
  'HK:03993': makeStock('HK:03993', '洛阳钼业', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['铜', '钴']),
  '603993': makeStock('603993', '洛阳钼业', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['铜', '钴']),
  'HK:00358': makeStock('HK:00358', '江西铜业股份', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['铜']),
  '600362': makeStock('600362', '江西铜业', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['有色金属'], ['铜']),
  'HK:02600': makeStock('HK:02600', '中国铝业', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'downstream', ['有色金属'], ['铝']),
  '601600': makeStock('601600', '中国铝业', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'downstream', ['有色金属'], ['铝']),
  'HK:01787': makeStock('HK:01787', '山东黄金', 'HK', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['黄金'], ['有色金属']),
  '600547': makeStock('600547', '山东黄金', 'SH', 'c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'midstream', ['黄金'], ['有色金属']),

  'HK:02196': makeStock('HK:02196', '复星医药', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'downstream', ['医药'], ['创新药', '医疗服务']),
  '600196': makeStock('600196', '复星医药', 'SH', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'downstream', ['医药'], ['创新药', '医疗服务']),
  'HK:01093': makeStock('HK:01093', '石药集团', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'downstream', ['医药'], ['创新药', '仿制药']),
  'HK:01177': makeStock('HK:01177', '中国生物制药', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'downstream', ['医药'], ['创新药', '仿制药']),
  'HK:03692': makeStock('HK:03692', '翰森制药', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'downstream', ['医药'], ['创新药']),
  'HK:03759': makeStock('HK:03759', '康龙化成', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO']),
  '300759': makeStock('300759', '康龙化成', 'SZ', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO']),
  'HK:03347': makeStock('HK:03347', '泰格医药', 'HK', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO']),
  '300347': makeStock('300347', '泰格医药', 'SZ', 'c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', 'midstream', ['医药外包'], ['CXO']),

  'HK:02020': makeStock('HK:02020', '安踏体育', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'midstream', ['消费品牌'], ['运动服饰']),
  'HK:02331': makeStock('HK:02331', '李宁', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'midstream', ['消费品牌'], ['运动服饰']),
  'HK:02313': makeStock('HK:02313', '申洲国际', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'upstream', ['纺织服装'], ['运动服饰', '供应链']),
  'HK:06690': makeStock('HK:06690', '海尔智家', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'midstream', ['家电'], ['智能家居']),
  '600690': makeStock('600690', '海尔智家', 'SH', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'midstream', ['家电'], ['智能家居']),
  'HK:09633': makeStock('HK:09633', '农夫山泉', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'downstream', ['饮料'], ['大众消费']),
  'HK:06862': makeStock('HK:06862', '海底捞', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'terminal', ['餐饮'], ['大众消费']),
  'HK:09922': makeStock('HK:09922', '九毛九', 'HK', 'c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', 'terminal', ['餐饮'], ['大众消费']),

  'HK:00316': makeStock('HK:00316', '东方海外国际', 'HK', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'midstream', ['航运物流'], ['集运', '出口链']),
  'HK:01919': makeStock('HK:01919', '中远海控', 'HK', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'midstream', ['航运物流'], ['集运']),
  '601919': makeStock('601919', '中远海控', 'SH', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'midstream', ['航运物流'], ['集运']),
  'HK:01138': makeStock('HK:01138', '中远海能', 'HK', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'midstream', ['航运物流'], ['油运']),
  '600026': makeStock('600026', '中远海能', 'SH', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'midstream', ['航运物流'], ['油运']),
  'HK:00144': makeStock('HK:00144', '招商局港口', 'HK', 'c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', 'service', ['港口'], ['航运物流']),

  'HK:00992': makeStock('HK:00992', '联想集团', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'downstream', ['消费电子'], ['AI PC', '服务器']),
  'HK:02382': makeStock('HK:02382', '舜宇光学科技', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['消费电子'], ['光学', '汽车电子']),
  'HK:01478': makeStock('HK:01478', '丘钛科技', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['消费电子'], ['摄像头模组']),
  'HK:00522': makeStock('HK:00522', 'ASMPT', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'upstream', ['半导体设备'], ['先进封装']),
  'HK:01385': makeStock('HK:01385', '上海复旦', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['芯片设计'], ['集成电路']),
  '688385': makeStock('688385', '复旦微电', 'SH', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'midstream', ['芯片设计'], ['集成电路']),
  'HK:00763': makeStock('HK:00763', '中兴通讯', 'HK', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'downstream', ['通信设备'], ['5G', '算力网络']),
  '000063': makeStock('000063', '中兴通讯', 'SZ', 'c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', 'downstream', ['通信设备'], ['5G', '算力网络']),

  'HK:09888': makeStock('HK:09888', '百度集团-SW', 'HK', 'c_cross_internet_content', '跨市场互联网内容', 'p_cross_platform_ai', '跨市场平台经济与AI', 'midstream', ['互联网平台'], ['人工智能', '自动驾驶', '云计算']),
  'HK:09999': makeStock('HK:09999', '网易-S', 'HK', 'c_cross_internet_content', '跨市场互联网内容', 'p_cross_platform_ai', '跨市场平台经济与AI', 'midstream', ['互联网平台'], ['游戏', '数字内容']),
  'HK:09626': makeStock('HK:09626', '哔哩哔哩-W', 'HK', 'c_cross_internet_content', '跨市场互联网内容', 'p_cross_platform_ai', '跨市场平台经济与AI', 'downstream', ['内容平台'], ['数字内容', '社区平台']),
  'HK:00772': makeStock('HK:00772', '阅文集团', 'HK', 'c_cross_internet_content', '跨市场互联网内容', 'p_cross_platform_ai', '跨市场平台经济与AI', 'downstream', ['内容平台'], ['数字内容', 'IP'])
};

const extraChains = [
  makeChain('c_cross_securities', '跨市场证券', 'p_cross_finance', '跨市场金融', 'A+H 券商、投行、财富管理与资本市场观察链。', {
    midstream: ['HK:06030', '600030', 'HK:03908', '601995', 'HK:06066', '601066', 'HK:06886', '601688', 'HK:01776', '000776', 'HK:06837', '600837']
  }, ['证券', '券商金融', '资本市场'], extraStocks),
  makeChain('c_cross_auto_battery', '跨市场汽车与电池', 'p_cross_ev', '跨市场新能源汽车', '港股整车、A 股电池与锂资源跨市场观察链。', {
    upstream: ['HK:01772', '002460', 'HK:09696', '002466'],
    midstream: ['300750', '300014'],
    downstream: ['HK:00175', 'HK:02333', '601633', 'HK:02238', '601238']
  }, ['新能源汽车', '动力电池', '锂资源'], extraStocks),
  makeChain('c_cross_infrastructure', '跨市场基建装备', 'p_cross_infrastructure', '跨市场基建装备', 'A+H 基建工程、轨交装备与央企建筑观察链。', {
    midstream: ['HK:00390', '601390', 'HK:01186', '601186', 'HK:01800', '601800'],
    downstream: ['HK:01766', '601766'],
    service: ['HK:03311']
  }, ['基建工程', '轨交装备', '中字头'], extraStocks),
  makeChain('c_cross_power_utility', '跨市场电力公用事业', 'p_cross_energy', '跨市场能源', '港股电力、公用事业与新能源电力观察链。', {
    upstream: ['HK:00916', '001289'],
    midstream: ['HK:00836', 'HK:00902', '600011', 'HK:00991', '601991', 'HK:02380']
  }, ['电力', '公用事业', '新能源电力'], extraStocks),
  makeChain('c_cross_resources_metals', '跨市场资源金属', 'p_cross_resources', '跨市场资源金属', 'A+H 煤炭、有色、黄金、铜铝资源观察链。', {
    upstream: ['HK:01088', '601088', 'HK:01171', '600188'],
    midstream: ['HK:02899', '601899', 'HK:03993', '603993', 'HK:00358', '600362', 'HK:01787', '600547'],
    downstream: ['HK:02600', '601600']
  }, ['煤炭', '有色金属', '黄金', '铜', '铝'], extraStocks),
  makeChain('c_cross_pharma_health', '跨市场医药健康', 'p_cross_medicine', '跨市场医药', '港股制药、创新药、A+H 医药健康观察链。', {
    midstream: ['HK:03759', '300759', 'HK:03347', '300347'],
    downstream: ['HK:02196', '600196', 'HK:01093', 'HK:01177', 'HK:03692']
  }, ['医药', '创新药', 'CXO'], extraStocks),
  makeChain('c_cross_consumer_brand', '跨市场消费品牌', 'p_cross_consumption', '跨市场消费', '港股运动服饰、餐饮、饮料、家电消费品牌观察链。', {
    upstream: ['HK:02313'],
    midstream: ['HK:02020', 'HK:02331', 'HK:06690', '600690'],
    downstream: ['HK:09633'],
    terminal: ['HK:06862', 'HK:09922']
  }, ['消费品牌', '运动服饰', '餐饮', '家电'], extraStocks),
  makeChain('c_cross_shipping_logistics', '跨市场航运物流', 'p_cross_shipping_logistics', '跨市场航运物流', '港股航运、A+H 集运油运与港口观察链。', {
    midstream: ['HK:00316', 'HK:01919', '601919', 'HK:01138', '600026'],
    service: ['HK:00144']
  }, ['航运物流', '集运', '港口'], extraStocks),
  makeChain('c_cross_hardware_semiconductor', '跨市场硬件半导体', 'p_cross_semiconductor', '跨市场半导体', '港股硬件、光学、半导体设备、芯片设计与 A+H 通信设备观察链。', {
    upstream: ['HK:00522'],
    midstream: ['HK:02382', 'HK:01478', 'HK:01385', '688385'],
    downstream: ['HK:00992', 'HK:00763', '000063']
  }, ['消费电子', '半导体设备', '芯片设计', '通信设备'], extraStocks),
  makeChain('c_cross_internet_content', '跨市场互联网内容', 'p_cross_platform_ai', '跨市场平台经济与AI', '港股 AI、游戏、内容平台、数字内容观察链。', {
    midstream: ['HK:09888', 'HK:09999'],
    downstream: ['HK:09626', 'HK:00772']
  }, ['人工智能', '游戏', '数字内容'], extraStocks)
];

const relationSeed = mergeRelation(readJson(relationPath, {
  version: 'dev-0.1.9.3-cross-market-relation-expanded',
  generatedAt: new Date().toISOString(),
  source: 'manual:cross_market_seed',
  total: 0,
  done: 0,
  failed: 0,
  items: {}
}), extraRelations);

const supplySeed = mergeSupply(readJson(supplyPath, {
  version: 'dev-0.1.9.3-cross-market-supply-chain-expanded',
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
