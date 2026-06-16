'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const UNIVERSE_PATH = path.join(PROJECT_ROOT, 'data', 'universe', 'hk-stock-universe.json');
const MARKET_GRAPH_DIR = path.join(PROJECT_ROOT, 'data', 'market-graph');
const CROSS_RELATION_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-relation.seed.json');
const CROSS_SUPPLY_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-supply-chain.seed.json');
const AUDIT_DETAILS_PATH = path.join(MARKET_GRAPH_DIR, 'audit', 'market-graph-coverage-details.jsonl');
const SOURCE = 'hk_universe_industry_seed';
const VERSION = 'dev-0.1.9.6-hk-market-graph-quality-v2';
const LAYER_LABELS = Object.freeze({
  upstream: '上游',
  midstream: '中游',
  downstream: '下游',
  service: '配套服务',
  terminal: '终端应用'
});
const LAYERS = Object.keys(LAYER_LABELS);

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== null) {
      return fallback;
    }
    throw new Error(`缺少文件：${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function normalizeCode(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^STOCK:/, '');
  if (!raw) return '';
  if (raw.startsWith('HK:')) {
    const digits = raw.slice(3).replace(/\D/g, '');
    return digits ? `HK:${digits.padStart(5, '0').slice(-5)}` : '';
  }
  if (/^HK\d{1,5}$/.test(raw)) return `HK:${raw.slice(2).padStart(5, '0')}`;
  if (/^\d{1,5}\.HK$/.test(raw)) return `HK:${raw.replace(/\.HK$/, '').padStart(5, '0')}`;
  const digits = raw.replace(/\D/g, '');
  if (!digits || digits.length > 5) return '';
  return `HK:${digits.padStart(5, '0')}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function compactUnique(list) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function makeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

const BROAD_LOW_CONFIDENCE_TERMS = Object.freeze([
  '控股', '集团', '国际', '发展', '投资', '资本', '实业', '企业', '综合'
]);

const CHAIN_RULES = [
  {
    parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_banking_insurance_brokerage', chainName: '港股银行保险券商', layer: 'service',
    keywords: ['银行', '保险', '证券', '券商', '信托', '期货', '交易所', '资产管理', '财富管理', '金融科技'],
    concepts: ['金融', '银行保险券商']
  },
  {
    parentId: 'p_hk_real_estate', parentName: '港股地产物业', chainId: 'c_hk_real_estate_property', chainName: '港股地产开发与物业', layer: 'downstream',
    keywords: ['地产', '置地', '置业', '物业', '房产', '房地产', 'REIT', '基建地产', '商业地产', '写字楼'],
    concepts: ['地产物业', '商业地产']
  },
  {
    parentId: 'p_hk_utility_energy', parentName: '港股公用事业与能源', chainId: 'c_hk_power_gas_water', chainName: '港股电力燃气水务', layer: 'midstream',
    keywords: ['电力', '电能', '发电', '燃气', '煤气', '水务', '环保', '公用事业', '新能源发电', '绿电', '光伏', '风电', '核能', '核电'],
    concepts: ['公用事业', '电力燃气水务']
  },
  {
    parentId: 'p_hk_energy_resources', parentName: '港股能源资源', chainId: 'c_hk_oil_coal_metal_mining', chainName: '港股油气煤炭金属矿业', layer: 'upstream',
    keywords: ['石油', '油气', '天然气', '煤炭', '矿业', '黄金矿业', '有色', '金属', '铜业', '铝业', '锂业', '钢铁'],
    concepts: ['能源资源', '油气煤炭金属矿业']
  },
  {
    parentId: 'p_hk_healthcare', parentName: '港股医药医疗', chainId: 'c_hk_biomedicine_healthcare', chainName: '港股生物医药与医疗服务', layer: 'midstream',
    keywords: ['医药', '医疗', '药业', '制药', '生物', '疫苗', '健康', '医院', '牙科', '基因', 'CXO', 'CRO', '器械'],
    concepts: ['医药医疗', '生物医药']
  },
  {
    parentId: 'p_hk_platform_tech', parentName: '港股平台科技与数字经济', chainId: 'c_hk_internet_ai_cloud', chainName: '港股互联网AI云与软件', layer: 'service',
    keywords: ['互联网', '软件', '云计算', 'AI', '人工智能', '大数据', '数字化', '电讯', '电信', '通信', '在线', '网络', 'SaaS', 'ERP', '平台'],
    concepts: ['数字经济', '互联网AI云']
  },
  {
    parentId: 'p_hk_hardware_auto', parentName: '港股智能硬件与汽车', chainId: 'c_hk_auto_smart_driving', chainName: '港股汽车整车零部件与智能驾驶', layer: 'midstream',
    keywords: ['汽车', '整车', '汽配', '零部件', '电动车', '新能源车', '智能驾驶', '自动驾驶', '激光雷达', '雷达', '电池', '锂电'],
    concepts: ['新能源汽车', '智能驾驶', '汽车零部件']
  },
  {
    parentId: 'p_hk_hardware_auto', parentName: '港股智能硬件与汽车', chainId: 'c_hk_semiconductor_electronics', chainName: '港股半导体电子与消费电子', layer: 'midstream',
    keywords: ['半导体', '芯片', '电子', '光电', '光学', '晶圆', '集成电路', '元件', 'PCB', '显示', '面板', '手机', '消费电子', '硬件'],
    concepts: ['半导体电子', '消费电子']
  },
  {
    parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_food_beverage_retail', chainName: '港股食品饮料零售餐饮', layer: 'downstream',
    keywords: ['食品', '饮料', '啤酒', '乳业', '餐饮', '火锅', '零售', '百货', '超市', '免税', '服饰', '家电'],
    concepts: ['消费品牌', '食品饮料零售']
  },
  {
    parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_tourism_hotel_entertainment', chainName: '港股旅游酒店与休闲娱乐', layer: 'terminal',
    keywords: ['酒店', '旅游', '博彩', '娱乐', '影视', '电影', '影院', '文旅', '传媒'],
    concepts: ['旅游酒店', '休闲娱乐', '影视传媒']
  },
  {
    parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_education_vocational_service', chainName: '港股教育与职业服务', layer: 'service',
    keywords: ['教育', '学校', '培训', '职业教育', '在线教育', '民办教育', '高等教育'],
    concepts: ['教育服务', '职业教育']
  },
  {
    parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_jewelry_luxury_retail', chainName: '港股珠宝黄金与高端零售', layer: 'downstream',
    keywords: ['珠宝', '钟表', '黄金珠宝', '黄金饰品', '首饰', '奢侈', '高端零售', '潮玩'],
    concepts: ['珠宝黄金', '高端零售']
  },
  {
    parentId: 'p_hk_transport_logistics', parentName: '港股交通运输物流', chainId: 'c_hk_shipping_port_air_logistics', chainName: '港股航运港口航空物流', layer: 'service',
    keywords: ['航运', '港口', '航空', '机场', '物流', '快递', '运输', '公路', '铁路', '海运', '码头'],
    concepts: ['交通运输物流', '航运港口航空']
  },
  {
    parentId: 'p_hk_industrial_infra', parentName: '港股工业制造与基建', chainId: 'c_hk_industrial_equipment_construction', chainName: '港股工业装备建筑基建', layer: 'midstream',
    keywords: ['机械', '设备', '工程机械', '建筑', '建材', '基建', '装备', '电气', '机器人', '自动化', '仪器', '电梯', '重工'],
    concepts: ['工业制造', '建筑基建']
  },
  {
    parentId: 'p_hk_agri_light', parentName: '港股农业轻工纺服', chainId: 'c_hk_agri_paper_textile', chainName: '港股农业纸业纺织轻工', layer: 'midstream',
    keywords: ['农业', '农牧', '养殖', '渔业', '纸业', '包装', '纺织', '服装', '鞋业', '轻工', '木业'],
    concepts: ['农业轻工', '纺织包装']
  }
]
const SPECIAL_CASES = Object.freeze({
  // 第一批港股重点股票白名单：只按明确代码生效，不恢复“控股/集团/国际”等泛词规则。
  'HK:00001': { parentId: 'p_hk_conglomerate_infra', parentName: '港股综合企业与基础设施', chainId: 'c_hk_conglomerate_infra_retail', chainName: '港股综合企业基础设施与零售', layer: 'service', industry: '综合企业', concepts: ['基础设施', '港口物流', '零售', '综合企业'] },
  'HK:00002': { parentId: 'p_hk_utility_energy', parentName: '港股公用事业与能源', chainId: 'c_hk_power_gas_water', chainName: '港股电力燃气水务', layer: 'midstream', industry: '电力公用事业', concepts: ['电力', '公用事业', '发电', '电网'] },
  'HK:00005': { parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_banking_insurance_brokerage', chainName: '港股银行保险券商', layer: 'service', industry: '银行', concepts: ['国际银行', '金融服务', '财富管理', '跨境金融'] },
  'HK:00017': { parentId: 'p_hk_real_estate', parentName: '港股地产物业', chainId: 'c_hk_real_estate_property', chainName: '港股地产开发与物业', layer: 'downstream', industry: '地产开发', concepts: ['商业地产', '物业', '城市更新', '地产开发'] },
  'HK:00019': { parentId: 'p_hk_conglomerate_infra', parentName: '港股综合企业与基础设施', chainId: 'c_hk_conglomerate_infra_retail', chainName: '港股综合企业基础设施与零售', layer: 'service', industry: '综合企业', concepts: ['地产', '航空服务', '贸易零售', '综合企业'] },
  'HK:00027': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_tourism_hotel_entertainment', chainName: '港股旅游酒店与休闲娱乐', layer: 'terminal', industry: '休闲娱乐', concepts: ['博彩娱乐', '酒店旅游', '休闲消费'] },
  'HK:00066': { parentId: 'p_hk_transport_logistics', parentName: '港股交通运输物流', chainId: 'c_hk_shipping_port_air_logistics', chainName: '港股航运港口航空物流', layer: 'service', industry: '轨道交通', concepts: ['铁路', '公共交通', '城市轨道', '交通运输'] },
  'HK:00267': { parentId: 'p_hk_conglomerate_infra', parentName: '港股综合企业与基础设施', chainId: 'c_hk_conglomerate_finance_resources', chainName: '港股综合企业金融资源与制造', layer: 'service', industry: '综合企业', concepts: ['综合金融', '资源制造', '基础设施', '综合企业'] },
  'HK:00268': { parentId: 'p_hk_platform_tech', parentName: '港股平台科技与数字经济', chainId: 'c_hk_enterprise_software_saas', chainName: '港股企业软件与SaaS服务', layer: 'service', industry: '企业软件', concepts: ['SaaS', 'ERP', '云服务', '企业数字化'] },
  'HK:00288': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_food_beverage_retail', chainName: '港股食品饮料零售餐饮', layer: 'midstream', industry: '食品加工', concepts: ['肉制品', '食品加工', '消费食品'] },
  'HK:00322': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_food_beverage_retail', chainName: '港股食品饮料零售餐饮', layer: 'downstream', industry: '食品饮料', concepts: ['方便食品', '饮料', '消费食品'] },
  'HK:00388': { parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_exchange_fintech_infra', chainName: '港股交易所金融基础设施', layer: 'service', industry: '交易所', concepts: ['金融基础设施', '证券交易', '资本市场', '金融科技'] },
  'HK:00669': { parentId: 'p_hk_industrial_infra', parentName: '港股工业制造与基建', chainId: 'c_hk_industrial_equipment_construction', chainName: '港股工业装备建筑基建', layer: 'midstream', industry: '工业装备', concepts: ['电动工具', '五金工具', '工业制造', '消费硬件'] },
  'HK:00868': { parentId: 'p_hk_industrial_materials', parentName: '港股工业材料与建材', chainId: 'c_hk_glass_building_materials', chainName: '港股玻璃建材与工业材料', layer: 'midstream', industry: '玻璃建材', concepts: ['浮法玻璃', '建筑玻璃', '工业材料'] },
  'HK:00968': { parentId: 'p_hk_new_energy_materials', parentName: '港股光伏与新能源材料', chainId: 'c_hk_solar_glass_materials', chainName: '港股光伏玻璃与新能源材料', layer: 'midstream', industry: '光伏玻璃', concepts: ['光伏', '新能源材料', '光伏玻璃', '绿色电力'] },
  'HK:01044': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_household_personal_care', chainName: '港股家庭护理与个人消费品', layer: 'downstream', industry: '家庭护理', concepts: ['生活用纸', '个人护理', '消费品'] },
  'HK:01099': { parentId: 'p_hk_healthcare', parentName: '港股医药医疗', chainId: 'c_hk_biomedicine_healthcare', chainName: '港股生物医药与医疗服务', layer: 'service', industry: '医药流通', concepts: ['医药分销', '药品流通', '医疗服务', '医药商业'] },
  'HK:01113': { parentId: 'p_hk_real_estate', parentName: '港股地产物业', chainId: 'c_hk_real_estate_property', chainName: '港股地产开发与物业', layer: 'downstream', industry: '地产开发', concepts: ['住宅开发', '商业地产', '物业管理'] },
  'HK:01378': { parentId: 'p_hk_energy_resources', parentName: '港股能源资源', chainId: 'c_hk_oil_coal_metal_mining', chainName: '港股油气煤炭金属矿业', layer: 'upstream', industry: '有色金属', concepts: ['铝业', '电解铝', '金属材料', '有色金属'] },
  'HK:01610': { parentId: 'p_hk_agri_light', parentName: '港股农业轻工纺服', chainId: 'c_hk_agri_paper_textile', chainName: '港股农业纸业纺织轻工', layer: 'midstream', industry: '农牧食品', concepts: ['生猪养殖', '肉类食品', '农业消费'] },
  'HK:01876': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_food_beverage_retail', chainName: '港股食品饮料零售餐饮', layer: 'downstream', industry: '啤酒饮料', concepts: ['啤酒', '酒类消费', '食品饮料'] },
  'HK:01918': { parentId: 'p_hk_real_estate', parentName: '港股地产物业', chainId: 'c_hk_real_estate_property', chainName: '港股地产开发与物业', layer: 'downstream', industry: '地产开发', concepts: ['住宅开发', '物业', '地产开发'] },
  'HK:01928': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_tourism_hotel_entertainment', chainName: '港股旅游酒店与休闲娱乐', layer: 'terminal', industry: '酒店娱乐', concepts: ['博彩娱乐', '酒店旅游', '休闲消费'] },
  'HK:01929': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_jewelry_luxury_retail', chainName: '港股珠宝黄金与高端零售', layer: 'downstream', industry: '珠宝零售', concepts: ['黄金珠宝', '高端零售', '消费品牌'] },
  'HK:02007': { parentId: 'p_hk_real_estate', parentName: '港股地产物业', chainId: 'c_hk_real_estate_property', chainName: '港股地产开发与物业', layer: 'downstream', industry: '地产开发', concepts: ['住宅开发', '物业服务', '地产开发'] },
  'HK:02328': { parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_banking_insurance_brokerage', chainName: '港股银行保险券商', layer: 'service', industry: '财产保险', concepts: ['保险', '财险', '金融服务'] },
  'HK:02338': { parentId: 'p_hk_hardware_auto', parentName: '港股智能硬件与汽车', chainId: 'c_hk_auto_smart_driving', chainName: '港股汽车整车零部件与智能驾驶', layer: 'midstream', industry: '汽车零部件', concepts: ['发动机', '商用车动力', '重卡产业链', '汽车零部件'] },
  'HK:02388': { parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_banking_insurance_brokerage', chainName: '港股银行保险券商', layer: 'service', industry: '银行', concepts: ['银行', '金融服务', '香港本地金融'] },
  'HK:02601': { parentId: 'p_hk_finance', parentName: '港股金融服务', chainId: 'c_hk_banking_insurance_brokerage', chainName: '港股银行保险券商', layer: 'service', industry: '保险', concepts: ['保险', '寿险', '财险', '金融服务'] },
  'HK:09992': { parentId: 'p_hk_consumer', parentName: '港股消费品牌与服务', chainId: 'c_hk_jewelry_luxury_retail', chainName: '港股珠宝黄金与高端零售', layer: 'downstream', industry: '潮玩零售', concepts: ['潮流玩具', 'IP消费', '高端零售', '消费品牌'] },
  'HK:02498': { parentId: 'p_hk_hardware_auto', parentName: '港股智能硬件与汽车', chainId: 'c_hk_auto_smart_driving', chainName: '港股汽车整车零部件与智能驾驶', layer: 'midstream', industry: '汽车零部件', concepts: ['激光雷达', '智能驾驶', '机器人感知', '新能源汽车'] }
});

function isBroadLowConfidenceTerm(term) {
  const text = normalizeText(term);
  return BROAD_LOW_CONFIDENCE_TERMS.includes(text);
}

function isAsciiTokenKeyword(keyword) {
  return /^[A-Z0-9][A-Z0-9.+#-]*$/i.test(String(keyword || '').trim());
}

function keywordMatches(text, keyword) {
  const rawKeyword = String(keyword || '').trim();
  if (!rawKeyword || isBroadLowConfidenceTerm(rawKeyword)) return false;
  const upperText = String(text || '').toUpperCase();
  const upperKeyword = rawKeyword.toUpperCase();

  // 英文短词必须做边界匹配，避免 CAI/RAI 这种误命中 AI。
  if (isAsciiTokenKeyword(upperKeyword)) {
    const escaped = upperKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i');
    return boundary.test(upperText);
  }

  return upperText.includes(upperKeyword);
}

function getRuleMatches(haystack, keywords) {
  const text = String(haystack || '');
  return compactUnique((keywords || [])
    .filter((keyword) => keywordMatches(text, keyword)));
}

function inferRule(stock) {
  const code = stock.symbol;
  const special = SPECIAL_CASES[code];
  if (special) {
    return {
      ...special,
      confidence: 0.94,
      ruleSource: 'priority_whitelist',
      matchedTerms: compactUnique([special.industry, ...(special.concepts || []), special.chainName])
    };
  }

  const nameHaystack = `${stock.name || ''}`.toUpperCase();
  const industryHaystack = `${stock.industry || ''}`.toUpperCase();

  for (const rule of CHAIN_RULES) {
    const industryMatches = getRuleMatches(industryHaystack, rule.keywords);
    const nameMatches = getRuleMatches(nameHaystack, rule.keywords);
    const matches = compactUnique([...industryMatches, ...nameMatches]);
    if (!matches.length) continue;
    return {
      ...rule,
      confidence: stock.industry && industryMatches.length ? 0.86 : 0.74,
      matchedTerms: compactUnique([stock.industry, ...matches.slice(0, 5)])
    };
  }

  if (stock.industry && !isBroadLowConfidenceTerm(stock.industry)) {
    return {
      parentId: 'p_hk_industry_other',
      parentName: '港股其他行业',
      chainId: `c_hk_industry_${makeSlug(stock.industry) || 'other'}`,
      chainName: `港股${stock.industry}`,
      layer: 'midstream',
      keywords: [stock.industry],
      concepts: [stock.industry],
      confidence: 0.58,
      matchedTerms: [stock.industry]
    };
  }

  return null;
}

function normalizeUniverseStock(item) {
  const symbol = normalizeCode(item && (item.symbol || item.code));
  if (!symbol) return null;
  const name = normalizeText(item && item.name);
  const industry = normalizeText(item && item.industry);
  if (!name || name === symbol) return null;
  return {
    symbol,
    code: symbol,
    name,
    market: 'HK',
    exchange: 'HKEX',
    currency: 'HKD',
    industry,
    source: normalizeText(item && item.source) || 'hk_stock_universe'
  };
}

function loadAuditStockFallback() {
  if (!fs.existsSync(AUDIT_DETAILS_PATH)) return [];
  const rows = [];
  for (const line of fs.readFileSync(AUDIT_DETAILS_PATH, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const row = JSON.parse(text);
      const symbol = normalizeCode(row.symbol || row.code);
      if (symbol && symbol.startsWith('HK:')) {
        rows.push({
          symbol,
          code: symbol,
          name: normalizeText(row.name),
          market: 'HK',
          exchange: 'HKEX',
          currency: 'HKD',
          industry: '',
          source: 'audit_details_fallback'
        });
      }
    } catch (_) {
      // ignore broken line
    }
  }
  return rows;
}

function loadHongKongStocks() {
  const universe = readJson(UNIVERSE_PATH, { stocks: [] });
  const map = new Map();
  for (const item of [...(universe.stocks || []), ...loadAuditStockFallback()]) {
    const stock = normalizeUniverseStock(item);
    if (!stock) continue;
    const existing = map.get(stock.symbol);
    if (!existing || (!existing.industry && stock.industry)) {
      map.set(stock.symbol, { ...existing, ...stock, industry: stock.industry || (existing && existing.industry) || '' });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function makePlate(plateName, plateType) {
  const text = normalizeText(plateName);
  if (!text) return null;
  return {
    plate_code: text,
    plate_name: text,
    plate_type: plateType,
    source: SOURCE
  };
}

function mergePlateList(left, right) {
  const result = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    const name = normalizeText(item && (item.plate_name || item.plate_code));
    const type = normalizeText(item && item.plate_type);
    if (!name) continue;
    const key = `${type}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...item,
      plate_code: item.plate_code || name,
      plate_name: name,
      plate_type: type || '概念'
    });
  }
  return result;
}

function upsertRelationItem(seed, stock, rule) {
  const existing = seed.items[stock.symbol] || {};
  const industry = normalizeText((rule && rule.industry) || stock.industry);
  const concepts = compactUnique([
    ...(rule && rule.concepts || []),
    ...(rule && rule.matchedTerms || []).filter((term) => term !== industry && term !== stock.industry)
  ]);
  const extraPlates = [
    makePlate(industry, '行业'),
    ...(concepts.map((concept) => makePlate(concept, '概念')))
  ].filter(Boolean);

  if (!extraPlates.length) return false;

  seed.items[stock.symbol] = {
    ...existing,
    code: stock.symbol,
    symbol: stock.symbol,
    name: existing.name || stock.name,
    displayName: existing.displayName || stock.name,
    market: 'HK',
    exchange: 'HKEX',
    currency: 'HKD',
    status: existing.status || 'DONE',
    source: appendSourceToken(existing.source, SOURCE),
    updatedAt: new Date().toISOString(),
    conceptThs: Array.isArray(existing.conceptThs) ? existing.conceptThs : [],
    plateEast: mergePlateList(existing.plateEast, extraPlates)
  };
  return true;
}

function makeLayerStock(stock, rule) {
  const industry = normalizeText((rule && rule.industry) || stock.industry);
  return {
    stockId: `stock:${stock.symbol}`,
    code: stock.symbol,
    name: stock.name,
    market: 'HK',
    source: SOURCE,
    editable: true,
    confidence: rule.confidence,
    matchedTerms: compactUnique(rule.matchedTerms || [industry, rule.chainName]),
    layerTerms: compactUnique([industry, rule.chainName]),
    layer: rule.layer,
    layerName: LAYER_LABELS[rule.layer] || rule.layer
  };
}

function ensurePrimary(seed, rule) {
  seed.primaryChains = Array.isArray(seed.primaryChains) ? seed.primaryChains : [];
  seed.defaultGraph = seed.defaultGraph && typeof seed.defaultGraph === 'object' ? seed.defaultGraph : {};
  seed.defaultGraph.primaryChains = Array.isArray(seed.defaultGraph.primaryChains) ? seed.defaultGraph.primaryChains : [];

  const existing = seed.primaryChains.find((item) => item && item.id === rule.parentId);
  if (!existing) {
    seed.primaryChains.push({ id: rule.parentId, name: rule.parentName, stockCount: 0, assignmentCount: 0 });
  } else if (!existing.name) {
    existing.name = rule.parentName;
  }

  const defaultExisting = seed.defaultGraph.primaryChains.find((item) => item && item.id === rule.parentId);
  if (!defaultExisting) {
    seed.defaultGraph.primaryChains.push({ id: rule.parentId, name: rule.parentName, stockCount: 0, assignmentCount: 0 });
  }
}

function ensureChain(seed, rule) {
  seed.chains = Array.isArray(seed.chains) ? seed.chains : [];
  seed.defaultGraph = seed.defaultGraph && typeof seed.defaultGraph === 'object' ? seed.defaultGraph : {};
  seed.defaultGraph.secondaryChainsTop = Array.isArray(seed.defaultGraph.secondaryChainsTop) ? seed.defaultGraph.secondaryChainsTop : [];
  seed.chainIndex = seed.chainIndex && typeof seed.chainIndex === 'object' ? seed.chainIndex : {};

  let chain = seed.chains.find((item) => item && item.id === rule.chainId);
  if (!chain) {
    chain = {
      id: rule.chainId,
      name: rule.chainName,
      parentId: rule.parentId,
      parentName: rule.parentName,
      description: '由港股 universe 行业字段自动补充，用于关系图和产业链展示，不进入预测层。',
      source: SOURCE,
      editable: true,
      keywords: compactUnique([rule.chainName, rule.parentName, ...(rule.keywords || []), ...(rule.concepts || [])]),
      summary: { stockCount: 0, assignmentCount: 0, layerCounts: {} },
      layers: {}
    };
    seed.chains.push(chain);
  }

  chain.parentId = chain.parentId || rule.parentId;
  chain.parentName = chain.parentName || rule.parentName;
  chain.keywords = compactUnique([...(chain.keywords || []), ...(rule.keywords || []), ...(rule.concepts || [])]);
  chain.layers = chain.layers && typeof chain.layers === 'object' ? chain.layers : {};
  for (const layer of LAYERS) {
    chain.layers[layer] = chain.layers[layer] && typeof chain.layers[layer] === 'object'
      ? chain.layers[layer]
      : { name: LAYER_LABELS[layer], stockCount: 0, stocks: [] };
    chain.layers[layer].name = chain.layers[layer].name || LAYER_LABELS[layer];
    chain.layers[layer].stocks = Array.isArray(chain.layers[layer].stocks) ? chain.layers[layer].stocks : [];
  }

  if (!seed.defaultGraph.secondaryChainsTop.some((item) => item && item.id === rule.chainId)) {
    seed.defaultGraph.secondaryChainsTop.push({
      id: rule.chainId,
      name: rule.chainName,
      parentId: rule.parentId,
      parentName: rule.parentName,
      stockCount: 0,
      assignmentCount: 0
    });
  }

  seed.chainIndex[rule.chainId] = {
    ...(seed.chainIndex[rule.chainId] || {}),
    id: rule.chainId,
    name: rule.chainName,
    parentId: rule.parentId,
    parentName: rule.parentName
  };

  return chain;
}

function mergeAssignmentList(left, assignment) {
  const result = Array.isArray(left) ? [...left] : [];
  const key = `${assignment.chainId}:${assignment.layer}`;
  const index = result.findIndex((item) => `${item && item.chainId}:${item && item.layer}` === key);
  if (index >= 0) {
    result[index] = { ...result[index], ...assignment, source: result[index].source || assignment.source };
  } else {
    result.push(assignment);
  }
  return result;
}

function upsertSupplyItem(seed, stock, rule) {
  if (!rule) return false;
  const industry = normalizeText((rule && rule.industry) || stock.industry);
  ensurePrimary(seed, rule);
  const chain = ensureChain(seed, rule);
  const layer = rule.layer;
  const layerStock = makeLayerStock(stock, rule);
  const layerStocks = chain.layers[layer].stocks;
  const existingIndex = layerStocks.findIndex((item) => item && item.code === stock.symbol);
  if (existingIndex >= 0) {
    layerStocks[existingIndex] = { ...layerStocks[existingIndex], ...layerStock };
  } else {
    layerStocks.push(layerStock);
  }

  seed.stockIndex = seed.stockIndex && typeof seed.stockIndex === 'object' ? seed.stockIndex : {};
  const existing = seed.stockIndex[stock.symbol] || {};
  const assignment = {
    chainId: rule.chainId,
    chainName: rule.chainName,
    parentId: rule.parentId,
    parentName: rule.parentName,
    layer,
    layerName: LAYER_LABELS[layer] || layer,
    confidence: rule.confidence,
    source: SOURCE,
    editable: true,
    matchedTerms: compactUnique(rule.matchedTerms || [stock.industry, rule.chainName]),
    layerTerms: compactUnique([industry, rule.chainName])
  };

  seed.stockIndex[stock.symbol] = {
    ...existing,
    id: existing.id || `stock:${stock.symbol}`,
    code: stock.symbol,
    name: existing.name || stock.name,
    market: 'HK',
    industries: compactUnique([...(existing.industries || []), industry]),
    concepts: compactUnique([...(existing.concepts || []), ...(rule.concepts || []), ...(rule.matchedTerms || []).filter((term) => term !== industry && term !== stock.industry)]),
    regions: Array.isArray(existing.regions) ? existing.regions : [],
    assignments: mergeAssignmentList(existing.assignments, assignment)
  };
  return true;
}


function sourceHasGeneratedToken(value) {
  return String(value || '').split('|').map((item) => item.trim()).includes(SOURCE);
}

function appendSourceToken(value, token) {
  return compactUnique([...String(value || '').split('|'), token]).join('|');
}

function removeSourceToken(value, token) {
  return compactUnique(String(value || '').split('|').filter((item) => item && item !== token)).join('|');
}

function cleanupGeneratedRelationSeed(seed) {
  const stats = { removedPlates: 0, removedItems: 0, normalizedSources: 0 };
  const items = seed.items && typeof seed.items === 'object' ? seed.items : {};
  for (const [symbol, item] of Object.entries(items)) {
    if (!item || typeof item !== 'object') continue;
    const sourceHadGenerated = sourceHasGeneratedToken(item.source);
    if (Array.isArray(item.plateEast)) {
      const before = item.plateEast.length;
      item.plateEast = item.plateEast.filter((plate) => !sourceHasGeneratedToken(plate && plate.source));
      stats.removedPlates += before - item.plateEast.length;
    }
    if (sourceHadGenerated) {
      item.source = removeSourceToken(item.source, SOURCE);
      stats.normalizedSources += 1;
    }
    const hasRelationData = (Array.isArray(item.plateEast) && item.plateEast.length > 0)
      || (Array.isArray(item.conceptThs) && item.conceptThs.length > 0)
      || (Array.isArray(item.relationEdges) && item.relationEdges.length > 0);
    if (sourceHadGenerated && !hasRelationData && normalizeCode(symbol).startsWith('HK:')) {
      delete items[symbol];
      stats.removedItems += 1;
    }
  }
  seed.items = items;
  return stats;
}

function cleanupGeneratedSupplySeed(seed) {
  const stats = { removedAssignments: 0, removedLayerStocks: 0, removedStockIndexItems: 0, removedChains: 0 };
  seed.stockIndex = seed.stockIndex && typeof seed.stockIndex === 'object' ? seed.stockIndex : {};
  for (const [symbol, stock] of Object.entries(seed.stockIndex)) {
    if (!stock || typeof stock !== 'object') continue;
    if (Array.isArray(stock.assignments)) {
      const before = stock.assignments.length;
      stock.assignments = stock.assignments.filter((assignment) => !sourceHasGeneratedToken(assignment && assignment.source));
      stats.removedAssignments += before - stock.assignments.length;
    }
    if ((!Array.isArray(stock.assignments) || stock.assignments.length === 0) && normalizeCode(symbol).startsWith('HK:')) {
      delete seed.stockIndex[symbol];
      stats.removedStockIndexItems += 1;
    }
  }

  seed.chains = Array.isArray(seed.chains) ? seed.chains : [];
  const removedChainIds = new Set();
  for (const chain of seed.chains) {
    if (!chain || typeof chain !== 'object' || !chain.layers) continue;
    for (const layer of LAYERS) {
      const layerObj = chain.layers[layer];
      if (!layerObj || !Array.isArray(layerObj.stocks)) continue;
      const before = layerObj.stocks.length;
      layerObj.stocks = layerObj.stocks.filter((stock) => !sourceHasGeneratedToken(stock && stock.source));
      stats.removedLayerStocks += before - layerObj.stocks.length;
    }
  }
  seed.chains = seed.chains.filter((chain) => {
    if (!chain || typeof chain !== 'object') return false;
    const generatedChain = sourceHasGeneratedToken(chain.source);
    const stockCount = LAYERS.reduce((sum, layer) => {
      const stocks = chain.layers && chain.layers[layer] && Array.isArray(chain.layers[layer].stocks) ? chain.layers[layer].stocks : [];
      return sum + stocks.length;
    }, 0);
    if (generatedChain && stockCount === 0) {
      removedChainIds.add(chain.id);
      stats.removedChains += 1;
      return false;
    }
    return true;
  });

  if (seed.chainIndex && typeof seed.chainIndex === 'object') {
    for (const id of removedChainIds) delete seed.chainIndex[id];
  }
  if (seed.defaultGraph && Array.isArray(seed.defaultGraph.secondaryChainsTop)) {
    seed.defaultGraph.secondaryChainsTop = seed.defaultGraph.secondaryChainsTop.filter((item) => !removedChainIds.has(item && item.id));
  }

  const activePrimaryIds = new Set((seed.chains || []).map((chain) => chain && chain.parentId).filter(Boolean));
  const keepPrimary = (item) => item && (!String(item.id || '').startsWith('p_hk_') || activePrimaryIds.has(item.id));
  seed.primaryChains = Array.isArray(seed.primaryChains) ? seed.primaryChains.filter(keepPrimary) : [];
  if (seed.defaultGraph && Array.isArray(seed.defaultGraph.primaryChains)) {
    seed.defaultGraph.primaryChains = seed.defaultGraph.primaryChains.filter(keepPrimary);
  }
  return stats;
}

function cleanupGeneratedSeeds(relationSeed, supplySeed) {
  return {
    relation: cleanupGeneratedRelationSeed(relationSeed),
    supplyChain: cleanupGeneratedSupplySeed(supplySeed)
  };
}


function normalizeAnyStockSymbol(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^STOCK:/, '');
  if (!raw) return '';
  if (raw.startsWith('HK:') || /^HK\d{1,5}$/.test(raw) || /^\d{1,5}\.HK$/.test(raw)) {
    return normalizeCode(raw);
  }
  const aShare = raw.match(/^(?:SH|SZ|BJ|CN_A:)?(\d{6})(?:\.(?:SH|SZ|BJ))?$/);
  if (aShare) return aShare[1];
  if (/^\d{6}$/.test(raw)) return raw;
  return raw;
}

function detectMarketFromSymbol(code, stock) {
  const existing = normalizeText(stock && stock.market);
  if (existing) return existing;
  if (String(code || '').startsWith('HK:')) return 'HK';
  if (/^(60|68|90)/.test(String(code || ''))) return 'SH';
  if (/^(00|30|20)/.test(String(code || ''))) return 'SZ';
  if (/^(43|83|87|88|92)/.test(String(code || ''))) return 'BJ';
  return '';
}

function ensurePrimaryByAssignment(seed, assignment) {
  const parentId = normalizeText(assignment.parentId) || 'p_hk_industry_other';
  const parentName = normalizeText(assignment.parentName) || '港股其他行业';
  seed.primaryChains = Array.isArray(seed.primaryChains) ? seed.primaryChains : [];
  let primary = seed.primaryChains.find((item) => item && item.id === parentId);
  if (!primary) {
    primary = { id: parentId, name: parentName, stockCount: 0, assignmentCount: 0 };
    seed.primaryChains.push(primary);
  } else if (!primary.name) {
    primary.name = parentName;
  }
  return primary;
}

function ensureChainByAssignment(seed, assignment) {
  const chainId = normalizeText(assignment.chainId);
  if (!chainId) return null;
  const chainName = normalizeText(assignment.chainName) || chainId;
  const parentId = normalizeText(assignment.parentId) || 'p_hk_industry_other';
  const parentName = normalizeText(assignment.parentName) || '港股其他行业';
  ensurePrimaryByAssignment(seed, { parentId, parentName });

  seed.chains = Array.isArray(seed.chains) ? seed.chains : [];
  let chain = seed.chains.find((item) => item && item.id === chainId);
  if (!chain) {
    chain = {
      id: chainId,
      name: chainName,
      parentId,
      parentName,
      description: '由 stockIndex.assignments 反向重建，用于修复产业链双向一致性。',
      source: assignment.source || SOURCE,
      editable: assignment.editable !== false,
      keywords: compactUnique([chainName, parentName, ...(assignment.matchedTerms || []), ...(assignment.layerTerms || [])]),
      summary: { stockCount: 0, assignmentCount: 0, layerCounts: {} },
      layers: {}
    };
    seed.chains.push(chain);
  }
  chain.name = chain.name || chainName;
  chain.parentId = chain.parentId || parentId;
  chain.parentName = chain.parentName || parentName;
  chain.keywords = compactUnique([...(chain.keywords || []), chainName, parentName, ...(assignment.matchedTerms || []), ...(assignment.layerTerms || [])]);
  chain.layers = chain.layers && typeof chain.layers === 'object' ? chain.layers : {};
  for (const layer of LAYERS) {
    chain.layers[layer] = chain.layers[layer] && typeof chain.layers[layer] === 'object'
      ? chain.layers[layer]
      : { name: LAYER_LABELS[layer], stockCount: 0, stocks: [] };
    chain.layers[layer].name = chain.layers[layer].name || LAYER_LABELS[layer];
    chain.layers[layer].stocks = Array.isArray(chain.layers[layer].stocks) ? chain.layers[layer].stocks : [];
  }
  return chain;
}

function makeLayerStockFromAssignment(code, stock, assignment) {
  const layer = LAYERS.includes(assignment.layer) ? assignment.layer : 'midstream';
  return {
    stockId: stock.id || `stock:${code}`,
    code,
    name: normalizeText(stock.name),
    market: detectMarketFromSymbol(code, stock),
    source: assignment.source || SOURCE,
    editable: assignment.editable !== false,
    confidence: typeof assignment.confidence === 'number' ? assignment.confidence : undefined,
    matchedTerms: compactUnique(assignment.matchedTerms || assignment.layerTerms || [assignment.chainName]),
    layerTerms: compactUnique(assignment.layerTerms || assignment.matchedTerms || [assignment.chainName]),
    layer,
    layerName: assignment.layerName || LAYER_LABELS[layer] || layer
  };
}

function rebuildSupplyLayersFromStockIndex(seed) {
  const stats = { rebuiltLayerStocks: 0, normalizedAssignments: 0, droppedAssignments: 0, createdChains: 0 };
  seed.stockIndex = seed.stockIndex && typeof seed.stockIndex === 'object' ? seed.stockIndex : {};
  seed.chains = Array.isArray(seed.chains) ? seed.chains : [];
  const beforeChainCount = seed.chains.length;

  for (const chain of seed.chains) {
    if (!chain || typeof chain !== 'object') continue;
    chain.layers = chain.layers && typeof chain.layers === 'object' ? chain.layers : {};
    for (const layer of LAYERS) {
      chain.layers[layer] = { name: LAYER_LABELS[layer], stockCount: 0, stocks: [] };
    }
  }

  for (const [symbol, rawStock] of Object.entries(seed.stockIndex)) {
    if (!rawStock || typeof rawStock !== 'object') continue;
    const code = normalizeAnyStockSymbol(rawStock.code || symbol);
    if (!code) continue;
    const assignments = Array.isArray(rawStock.assignments) ? rawStock.assignments : [];
    const normalizedAssignments = [];
    const assignmentSeen = new Set();

    for (const rawAssignment of assignments) {
      if (!rawAssignment || typeof rawAssignment !== 'object') continue;
      const chainId = normalizeText(rawAssignment.chainId);
      if (!chainId) {
        stats.droppedAssignments += 1;
        continue;
      }
      const layer = LAYERS.includes(rawAssignment.layer) ? rawAssignment.layer : 'midstream';
      const assignment = {
        ...rawAssignment,
        chainId,
        chainName: normalizeText(rawAssignment.chainName) || chainId,
        parentId: normalizeText(rawAssignment.parentId) || 'p_hk_industry_other',
        parentName: normalizeText(rawAssignment.parentName) || '港股其他行业',
        layer,
        layerName: rawAssignment.layerName || LAYER_LABELS[layer] || layer,
        source: rawAssignment.source || SOURCE,
        matchedTerms: compactUnique(rawAssignment.matchedTerms || rawAssignment.layerTerms || [rawAssignment.chainName || chainId]),
        layerTerms: compactUnique(rawAssignment.layerTerms || rawAssignment.matchedTerms || [rawAssignment.chainName || chainId])
      };
      const key = `${assignment.chainId}:${assignment.layer}`;
      if (assignmentSeen.has(key)) continue;
      assignmentSeen.add(key);
      normalizedAssignments.push(assignment);

      const chain = ensureChainByAssignment(seed, assignment);
      if (!chain) continue;
      const layerObj = chain.layers[assignment.layer];
      const layerStock = makeLayerStockFromAssignment(code, rawStock, assignment);
      if (!layerObj.stocks.some((item) => normalizeAnyStockSymbol(item && item.code) === code)) {
        layerObj.stocks.push(layerStock);
        stats.rebuiltLayerStocks += 1;
      }
    }

    rawStock.code = code;
    rawStock.id = rawStock.id || `stock:${code}`;
    rawStock.market = detectMarketFromSymbol(code, rawStock);
    rawStock.assignments = normalizedAssignments;
    stats.normalizedAssignments += normalizedAssignments.length;
  }

  stats.createdChains = seed.chains.length - beforeChainCount;
  return stats;
}

function rebuildDefaultGraphAndChainIndex(seed) {
  seed.defaultGraph = seed.defaultGraph && typeof seed.defaultGraph === 'object' ? seed.defaultGraph : {};
  seed.chainIndex = {};

  const activeChains = [];
  const primaryIds = new Set();
  for (const chain of Array.isArray(seed.chains) ? seed.chains : []) {
    if (!chain || typeof chain !== 'object' || !chain.id) continue;
    const assignmentCount = chain.summary && typeof chain.summary.assignmentCount === 'number'
      ? chain.summary.assignmentCount
      : 0;
    seed.chainIndex[chain.id] = {
      id: chain.id,
      name: chain.name,
      parentId: chain.parentId,
      parentName: chain.parentName
    };
    if (assignmentCount > 0) {
      activeChains.push(chain);
      if (chain.parentId) primaryIds.add(chain.parentId);
    }
  }

  seed.primaryChains = Array.isArray(seed.primaryChains) ? seed.primaryChains : [];
  const primaryMap = new Map(seed.primaryChains
    .filter((item) => item && item.id)
    .map((item) => [item.id, item]));
  for (const chain of activeChains) {
    if (!primaryMap.has(chain.parentId)) {
      primaryMap.set(chain.parentId, {
        id: chain.parentId,
        name: chain.parentName,
        stockCount: 0,
        assignmentCount: 0
      });
    }
  }
  seed.primaryChains = Array.from(primaryMap.values())
    .filter((item) => item && item.id && primaryIds.has(item.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const primaryStats = new Map();
  for (const chain of activeChains) {
    const p = primaryStats.get(chain.parentId) || { stockSet: new Set(), assignmentCount: 0 };
    for (const layer of LAYERS) {
      const stocks = chain.layers && chain.layers[layer] && Array.isArray(chain.layers[layer].stocks) ? chain.layers[layer].stocks : [];
      for (const stock of stocks) {
        const code = normalizeAnyStockSymbol(stock && stock.code);
        if (code) p.stockSet.add(code);
      }
    }
    p.assignmentCount += chain.summary && chain.summary.assignmentCount ? chain.summary.assignmentCount : 0;
    primaryStats.set(chain.parentId, p);
  }

  for (const primary of seed.primaryChains) {
    const stat = primaryStats.get(primary.id) || { stockSet: new Set(), assignmentCount: 0 };
    primary.stockCount = stat.stockSet.size;
    primary.assignmentCount = stat.assignmentCount;
  }

  seed.defaultGraph.primaryChains = seed.primaryChains.map((item) => ({
    id: item.id,
    name: item.name,
    stockCount: item.stockCount || 0,
    assignmentCount: item.assignmentCount || 0
  }));
  seed.defaultGraph.secondaryChainsTop = activeChains
    .map((chain) => ({
      id: chain.id,
      name: chain.name,
      parentId: chain.parentId,
      parentName: chain.parentName,
      stockCount: chain.summary && chain.summary.stockCount ? chain.summary.stockCount : 0,
      assignmentCount: chain.summary && chain.summary.assignmentCount ? chain.summary.assignmentCount : 0
    }))
    .sort((a, b) => String(a.parentId).localeCompare(String(b.parentId)) || String(a.id).localeCompare(String(b.id)));
}

function recomputeSupplySummary(seed) {
  const stockIndex = seed.stockIndex || {};
  const chainStats = new Map();
  const primaryStats = new Map();

  for (const chain of seed.chains || []) {
    const layerCounts = {};
    let stockSet = new Set();
    let assignmentCount = 0;
    for (const layer of LAYERS) {
      const layerObj = chain.layers && chain.layers[layer];
      const stocks = Array.isArray(layerObj && layerObj.stocks) ? layerObj.stocks : [];
      const deduped = [];
      const seen = new Set();
      for (const stock of stocks) {
        const code = normalizeAnyStockSymbol(stock && stock.code);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        stockSet.add(code);
        deduped.push({ ...stock, code, stockId: stock.stockId || `stock:${code}` });
      }
      if (!chain.layers) chain.layers = {};
      chain.layers[layer] = {
        name: LAYER_LABELS[layer],
        stockCount: deduped.length,
        stocks: deduped.sort((a, b) => a.code.localeCompare(b.code))
      };
      layerCounts[layer] = deduped.length;
      assignmentCount += deduped.length;
    }
    chain.summary = {
      ...(chain.summary || {}),
      stockCount: stockSet.size,
      assignmentCount,
      layerCounts
    };
    chainStats.set(chain.id, { stockCount: stockSet.size, assignmentCount });
    const p = primaryStats.get(chain.parentId) || { stockSet: new Set(), assignmentCount: 0 };
    stockSet.forEach((code) => p.stockSet.add(code));
    p.assignmentCount += assignmentCount;
    primaryStats.set(chain.parentId, p);
  }

  function applyPrimaryStats(list) {
    for (const item of Array.isArray(list) ? list : []) {
      const stat = primaryStats.get(item.id);
      if (stat) {
        item.stockCount = stat.stockSet.size;
        item.assignmentCount = stat.assignmentCount;
      }
    }
  }

  function applyChainStats(list) {
    for (const item of Array.isArray(list) ? list : []) {
      const stat = chainStats.get(item.id);
      if (stat) {
        item.stockCount = stat.stockCount;
        item.assignmentCount = stat.assignmentCount;
      }
    }
  }

  applyPrimaryStats(seed.primaryChains);
  if (seed.defaultGraph) {
    applyPrimaryStats(seed.defaultGraph.primaryChains);
    applyChainStats(seed.defaultGraph.secondaryChainsTop);
  }

  const assignedStockCount = Object.values(stockIndex)
    .filter((stock) => Array.isArray(stock && stock.assignments) && stock.assignments.length)
    .length;
  const assignmentTotal = Object.values(stockIndex)
    .reduce((sum, stock) => sum + (Array.isArray(stock && stock.assignments) ? stock.assignments.length : 0), 0);

  seed.summary = {
    ...(seed.summary || {}),
    primaryChainCount: Array.isArray(seed.primaryChains) ? seed.primaryChains.length : 0,
    secondaryChainCount: Array.isArray(seed.chains) ? seed.chains.length : 0,
    stockCount: Object.keys(stockIndex).length,
    assignedStockCount,
    assignmentCount: assignmentTotal,
    assignmentTotal,
    lastSupplementSource: SOURCE
  };
}

function recomputeRelationSummary(seed) {
  seed.total = Object.keys(seed.items || {}).length;
  seed.done = Object.values(seed.items || {}).filter((item) => item && item.status === 'DONE').length;
  seed.failed = Object.values(seed.items || {}).filter((item) => item && item.status === 'FAILED').length;
}

function run(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const stocks = loadHongKongStocks();
  const relationSeed = readJson(CROSS_RELATION_PATH, { items: {} });
  const supplySeed = readJson(CROSS_SUPPLY_PATH, { primaryChains: [], chains: [], stockIndex: {}, defaultGraph: {}, chainIndex: {} });

  relationSeed.items = relationSeed.items && typeof relationSeed.items === 'object' ? relationSeed.items : {};
  supplySeed.stockIndex = supplySeed.stockIndex && typeof supplySeed.stockIndex === 'object' ? supplySeed.stockIndex : {};

  const cleanup = cleanupGeneratedSeeds(relationSeed, supplySeed);

  const stats = {
    scanned: stocks.length,
    inferred: 0,
    relationUpserted: 0,
    supplyUpserted: 0,
    skippedNoRule: 0,
    priorityWhitelist: 0,
    examples: []
  };

  for (const stock of stocks) {
    const rule = inferRule(stock);
    if (!rule) {
      stats.skippedNoRule += 1;
      continue;
    }
    stats.inferred += 1;
    if (rule.ruleSource === 'priority_whitelist') stats.priorityWhitelist += 1;
    if (upsertRelationItem(relationSeed, stock, rule)) stats.relationUpserted += 1;
    if (upsertSupplyItem(supplySeed, stock, rule)) stats.supplyUpserted += 1;
    if (stats.examples.length < 12) {
      stats.examples.push({
        symbol: stock.symbol,
        name: stock.name,
        industry: stock.industry,
        chain: rule.chainName,
        layer: LAYER_LABELS[rule.layer] || rule.layer,
        matchedTerms: rule.matchedTerms,
        ruleSource: rule.ruleSource || 'strict_keyword'
      });
    }
  }

  const generatedAt = new Date().toISOString();
  relationSeed.version = VERSION;
  relationSeed.generatedAt = generatedAt;
  relationSeed.source = appendSourceToken(relationSeed.source, SOURCE);
  relationSeed.description = '跨市场关系 seed：含港股 universe 行业补全项，只用于关系图与产业链展示，不进入预测层。';
  recomputeRelationSummary(relationSeed);

  supplySeed.version = VERSION;
  supplySeed.generatedAt = generatedAt;
  supplySeed.source = appendSourceToken(supplySeed.source, SOURCE);
  supplySeed.description = '跨市场产业链 seed：含港股 universe 行业补全项，只用于产业链展示，不进入预测层。';
  const rebuild = rebuildSupplyLayersFromStockIndex(supplySeed);
  recomputeSupplySummary(supplySeed);
  rebuildDefaultGraphAndChainIndex(supplySeed);

  const backups = {};
  if (!dryRun) {
    backups.relation = backupFile(CROSS_RELATION_PATH);
    backups.supplyChain = backupFile(CROSS_SUPPLY_PATH);
    writeJson(CROSS_RELATION_PATH, relationSeed);
    writeJson(CROSS_SUPPLY_PATH, supplySeed);
  }

  return {
    ok: true,
    dryRun,
    generatedAt,
    source: SOURCE,
    paths: {
      hkUniverse: path.relative(PROJECT_ROOT, UNIVERSE_PATH).replace(/\\/g, '/'),
      relationSeed: path.relative(PROJECT_ROOT, CROSS_RELATION_PATH).replace(/\\/g, '/'),
      supplyChainSeed: path.relative(PROJECT_ROOT, CROSS_SUPPLY_PATH).replace(/\\/g, '/')
    },
    backups,
    qualityProfile: 'strict_plus_hk_priority_whitelist_quality_v2',
    blockedBroadTerms: BROAD_LOW_CONFIDENCE_TERMS,
    cleanup,
    rebuild,
    stats,
    relationTotal: relationSeed.total,
    supplyStockCount: Object.keys(supplySeed.stockIndex || {}).length,
    supplyAssignmentTotal: supplySeed.summary && supplySeed.summary.assignmentTotal
  };
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run')
  };
}

if (require.main === module) {
  try {
    const result = run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`港股关系图/产业链 seed 补全失败：${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  run,
  normalizeCode,
  inferRule,
  keywordMatches,
  rebuildSupplyLayersFromStockIndex,
  rebuildDefaultGraphAndChainIndex,
  cleanupGeneratedSeeds
};
