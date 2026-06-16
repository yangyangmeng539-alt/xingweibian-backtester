const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MARKET_GRAPH_DIR = path.join(PROJECT_ROOT, 'data', 'market-graph');
const SEED_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-raw.seed.json');
const CROSS_MARKET_RELATION_SEED_PATH = path.join(MARKET_GRAPH_DIR, 'cross-market-relation.seed.json');
const PROGRESS_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-progress.json');
const ERRORS_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-errors.json');
const RELATION_VERSION = 'dev-0.1.0';
const RELATION_SOURCE = 'adata:get_concept_ths|get_plate_east';
const DEFAULT_GRAPH_OPTIONS = {
  hideNoise: true,
  labelMode: 'important',
  hideWeak: true,
  showBoards: false,
  showStyleRegion: false,
  maxConceptsPerStock: 5,
  maxPlatesPerStock: 3,
  minEdgeWeight: 0,
  viewMode: 'mixed',
  viewPreset: 'themeOverview',
  focusCode: '',
  expandStockCode: '',
  focusThemeId: '',
  maxOverviewIndustries: 12,
  maxOverviewConcepts: 25,
  targetNodeCount: 60,
  targetEdgeCount: 80,
  maxThemeOverviewNodes: 80,
  maxThemeOverviewEdges: 120,
  minThemeMemberStockCount: 3,
  minSharedStockCount: 2,
  maxThemeFocusStocks: 80,
  maxThemeFocusRelatedThemes: 20,
  maxThemeFocusEdges: 120
};
const VALID_VIEW_MODES = new Set(['mixed', 'industry', 'concept', 'board', 'stock']);
const VALID_VIEW_PRESETS = new Set(['themeOverview', 'themeFocus', 'stockFocus', 'overview', 'focus', 'resonance', 'raw']);
const VALID_LABEL_MODES = new Set(['none', 'important', 'all']);
const THEME_RELATION_READY_STATUSES = new Set(['DONE', 'DONE_PARTIAL', 'DONE_EMPTY_RELATION']);

const NOISE_LABELS = new Set([
  '大盘股',
  '权重股',
  '行业龙头',
  '融资融券',
  '证金持股',
  '同花顺漂亮100',
  '高股息精选',
  '国企改革',
  'ST板块',
  '新股与次新股',
  '注册制次新股',
  '沪股通',
  '深股通',
  'MSCI概念',
  '富时罗素概念',
  '标普道琼斯A股',
  '转融券标的',
  '预盈预增',
  '年报预增',
  '一季报预增',
  '半年报预增',
  '机构重仓',
  '基金重仓',
  '昨日涨停',
  '昨日连板',
  '昨日触板',
  '破净股',
  '低价股',
  '高价股',
  '大盘价值',
  '价值股',
  '消费风格',
  '金融地产风格',
  '先进制造风格'
]);

const INDUSTRY_THEME_KEYWORDS = [
  '电池',
  '锂电',
  '储能',
  '光伏',
  '风电',
  '新能源',
  '半导体',
  '芯片',
  '集成电路',
  '算力',
  '人工智能',
  '机器人',
  '软件',
  '云计算',
  '数据',
  '通信',
  '军工',
  '航天',
  '航空',
  '低空',
  '医药',
  '生物',
  '医疗',
  '汽车',
  '整车',
  '零部件',
  '消费电子',
  '电子',
  '机械',
  '装备',
  '材料',
  '稀土',
  '有色',
  '化工',
  '煤炭',
  '钢铁',
  '电力',
  '电网',
  '特高压',
  '充电桩',
  '环保',
  '物流',
  '食品',
  '白酒',
  '农业',
  '种业',
  '金融',
  '证券',
  '银行',
  '保险',
  '地产'
];

const EAST_WEIGHT_BY_NODE_TYPE = {
  industry: 1,
  concept: 0.7,
  region_board: 0.2,
  style_board: 0.1,
  other_board: 0.2
};

const CONCEPT_ALIAS_MAP = new Map([
  ['新能源车', '新能源汽车'],
  ['新能源车概念', '新能源汽车'],
  ['新能源汽车概念', '新能源汽车'],
  ['新能源汽车', '新能源汽车'],
  ['锂电池概念', '锂电池'],
  ['锂电池', '锂电池'],
  ['机器人概念', '机器人'],
  ['机器人', '机器人']
]);

const AI_THEME_LABELS = new Set(['AI应用', '人工智能', 'AIGC']);

const NOISE_CATEGORY_KEYWORDS = {
  index_style: [
    'HS300',
    '沪深300',
    'MSCI',
    '中国A50',
    '富时罗素',
    '标普道琼斯',
    '标准普尔',
    '深成',
    '深证',
    '上证',
    '创业板',
    '创业成份',
    '茅指数',
    '宁组合',
    '央视50',
    '周期股',
    'AH股',
    '同花顺漂亮100',
    '深股通',
    '沪股通'
  ],
  capital_style: [
    '融资融券',
    '证金持股',
    '机构重仓',
    '基金重仓',
    '社保重仓'
  ],
  size_style: [
    '大盘股',
    '权重股',
    '大盘价值',
    '价值股',
    '低价股',
    '高价股',
    '百元股'
  ],
  event_style: [
    '新股与次新股',
    '注册制次新股',
    '次新',
    '预增',
    '预盈',
    '年报预增',
    '一季报预增',
    '半年报预增',
    '昨日涨停',
    '昨日连板',
    '昨日触板'
  ]
};

const REGION_BOARD_KEYWORDS = [
  '北京',
  '上海',
  '广东',
  '浙江',
  '江苏',
  '福建',
  '贵州',
  '四川',
  '重庆',
  '山东',
  '河南',
  '河北',
  '辽宁',
  '吉林',
  '黑龙江',
  '安徽',
  '江西',
  '湖北',
  '湖南',
  '广西',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '宁夏',
  '新疆',
  '西藏',
  '海南',
  '内蒙古',
  '天津',
  '山西'
];

const STYLE_BOARD_KEYWORDS = [
  '大盘股',
  '权重股',
  '行业龙头',
  '大盘价值',
  '价值股',
  '先进制造风格',
  '消费风格',
  '金融地产风格'
];

const EAST_NODE_PREFIX_BY_TYPE = {
  industry: 'east_industry',
  concept: 'east_concept',
  region_board: 'east_region_board',
  style_board: 'east_style_board',
  other_board: 'east_other_board'
};

const EAST_EDGE_TYPE_BY_NODE_TYPE = {
  industry: 'stock_to_east_industry',
  concept: 'stock_to_east_concept',
  region_board: 'stock_to_region_board',
  style_board: 'stock_to_style_board',
  other_board: 'stock_to_other_board'
};

function nowIso() {
  return new Date().toISOString();
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createEmptySeed() {
  return {
    version: RELATION_VERSION,
    generatedAt: '',
    source: RELATION_SOURCE,
    total: 0,
    done: 0,
    failed: 0,
    items: {}
  };
}

function normalizeSeed(rawSeed) {
  const seed = {
    ...createEmptySeed(),
    ...(rawSeed && typeof rawSeed === 'object' ? rawSeed : {})
  };

  seed.items = seed.items && typeof seed.items === 'object' ? seed.items : {};
  seed.total = Number(seed.total) || Object.keys(seed.items).length;
  seed.done = Number(seed.done) || Object.values(seed.items).filter((item) => item && item.status === 'DONE').length;
  seed.failed = Number(seed.failed) || Object.values(seed.items).filter((item) => item && item.status === 'FAILED').length;
  return seed;
}

function normalizeRelationList(value) {
  return Array.isArray(value) ? value : [];
}

function mergeRelationLists(left, right, identityFn) {
  const result = [];
  const seen = new Set();

  [...normalizeRelationList(left), ...normalizeRelationList(right)].forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    const key = identityFn(item);

    if (key && seen.has(key)) {
      return;
    }

    if (key) {
      seen.add(key);
    }

    result.push(item);
  });

  return result;
}

function mergeRelationSeedItems(baseItem, extraItem) {
  if (!baseItem) {
    return extraItem;
  }

  if (!extraItem) {
    return baseItem;
  }

  return {
    ...baseItem,
    ...Object.fromEntries(Object.entries(extraItem).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    code: normalizeCode(extraItem.code || baseItem.code),
    name: baseItem.name || extraItem.name || '',
    market: baseItem.market || extraItem.market || '',
    status: baseItem.status || extraItem.status || 'DONE',
    conceptThs: mergeRelationLists(baseItem.conceptThs, extraItem.conceptThs, (item) => String(item.name || item.concept_code || '').trim()),
    plateEast: mergeRelationLists(baseItem.plateEast, extraItem.plateEast, (item) => `${String(item.plate_type || '').trim()}:${String(item.plate_name || item.plate_code || '').trim()}`)
  };
}

function mergeRelationSeeds(baseSeed, extraSeed) {
  const base = normalizeSeed(baseSeed);
  const extra = normalizeSeed(extraSeed);
  const items = { ...(base.items || {}) };

  Object.values(extra.items || {}).forEach((item) => {
    const code = normalizeCode(item && item.code);

    if (!code) {
      return;
    }

    items[code] = mergeRelationSeedItems(items[code], {
      ...item,
      code
    });
  });

  const done = Object.values(items).filter((item) => item && item.status === 'DONE').length;
  const failed = Object.values(items).filter((item) => item && item.status === 'FAILED').length;

  return {
    ...base,
    generatedAt: base.generatedAt || extra.generatedAt || '',
    source: [base.source || RELATION_SOURCE, extra.source || 'cross_market_seed'].filter(Boolean).join('|'),
    items,
    total: Object.keys(items).length,
    done,
    failed,
    crossMarket: {
      enabled: true,
      seedPath: CROSS_MARKET_RELATION_SEED_PATH,
      itemCount: Object.keys(extra.items || {}).length
    }
  };
}

function loadRelationSeed(seedPath = SEED_PATH) {
  return normalizeSeed(readJsonIfExists(seedPath, null));
}

function loadRelationSeed(seedPath = SEED_PATH) {
  const baseSeed = normalizeSeed(readJsonIfExists(seedPath, null));

  if (path.resolve(seedPath) !== path.resolve(SEED_PATH) || !fs.existsSync(CROSS_MARKET_RELATION_SEED_PATH)) {
    return baseSeed;
  }

  return mergeRelationSeeds(baseSeed, readJsonIfExists(CROSS_MARKET_RELATION_SEED_PATH, null));
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

  const digits = raw.replace(/\D/g, '').trim();

  if (!digits) {
    return '';
  }

  return digits.length >= 6 ? digits.slice(-6) : '';
}

function normalizeIdText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_');
}

function normalizeThemeNodeId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_');
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function getLimit(value) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }

  return Math.floor(num);
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Boolean(value);
}

function normalizeGraphOptions(options = {}) {
  const viewMode = VALID_VIEW_MODES.has(String(options.viewMode || '').trim())
    ? String(options.viewMode).trim()
    : DEFAULT_GRAPH_OPTIONS.viewMode;
  const viewPreset = VALID_VIEW_PRESETS.has(String(options.viewPreset || '').trim())
    ? String(options.viewPreset).trim()
    : DEFAULT_GRAPH_OPTIONS.viewPreset;
  const labelMode = VALID_LABEL_MODES.has(String(options.labelMode || '').trim())
    ? String(options.labelMode).trim()
    : DEFAULT_GRAPH_OPTIONS.labelMode;
  const minEdgeWeight = Number(options.minEdgeWeight);

  return {
    hideNoise: normalizeBoolean(options.hideNoise, DEFAULT_GRAPH_OPTIONS.hideNoise),
    hideWeak: normalizeBoolean(options.hideWeak, DEFAULT_GRAPH_OPTIONS.hideWeak),
    showBoards: normalizeBoolean(options.showBoards, DEFAULT_GRAPH_OPTIONS.showBoards),
    showStyleRegion: normalizeBoolean(options.showStyleRegion, DEFAULT_GRAPH_OPTIONS.showStyleRegion),
    labelMode,
    maxConceptsPerStock: options.maxConceptsPerStock === undefined
      ? DEFAULT_GRAPH_OPTIONS.maxConceptsPerStock
      : getLimit(options.maxConceptsPerStock),
    maxPlatesPerStock: options.maxPlatesPerStock === undefined
      ? DEFAULT_GRAPH_OPTIONS.maxPlatesPerStock
      : getLimit(options.maxPlatesPerStock),
    minEdgeWeight: Number.isFinite(minEdgeWeight) && minEdgeWeight > 0
      ? minEdgeWeight
      : DEFAULT_GRAPH_OPTIONS.minEdgeWeight,
    viewMode,
    viewPreset,
    focusCode: normalizeCode(options.focusCode),
    expandStockCode: normalizeCode(options.expandStockCode),
    focusThemeId: normalizeThemeNodeId(options.focusThemeId),
    maxOverviewIndustries: getLimit(options.maxOverviewIndustries) || DEFAULT_GRAPH_OPTIONS.maxOverviewIndustries,
    maxOverviewConcepts: getLimit(options.maxOverviewConcepts) || DEFAULT_GRAPH_OPTIONS.maxOverviewConcepts,
    targetNodeCount: getLimit(options.targetNodeCount) || DEFAULT_GRAPH_OPTIONS.targetNodeCount,
    targetEdgeCount: getLimit(options.targetEdgeCount) || DEFAULT_GRAPH_OPTIONS.targetEdgeCount,
    maxThemeOverviewNodes: getLimit(options.maxThemeOverviewNodes) || DEFAULT_GRAPH_OPTIONS.maxThemeOverviewNodes,
    maxThemeOverviewEdges: getLimit(options.maxThemeOverviewEdges) || DEFAULT_GRAPH_OPTIONS.maxThemeOverviewEdges,
    minThemeMemberStockCount: getLimit(options.minThemeMemberStockCount) || DEFAULT_GRAPH_OPTIONS.minThemeMemberStockCount,
    minSharedStockCount: getLimit(options.minSharedStockCount) || DEFAULT_GRAPH_OPTIONS.minSharedStockCount,
    maxThemeFocusStocks: getLimit(options.maxThemeFocusStocks) || DEFAULT_GRAPH_OPTIONS.maxThemeFocusStocks,
    maxThemeFocusRelatedThemes: getLimit(options.maxThemeFocusRelatedThemes) || DEFAULT_GRAPH_OPTIONS.maxThemeFocusRelatedThemes,
    maxThemeFocusEdges: getLimit(options.maxThemeFocusEdges) || DEFAULT_GRAPH_OPTIONS.maxThemeFocusEdges
  };
}

function keywordIncludes(name, keywords) {
  const text = String(name || '');
  return keywords.some((keyword) => text.includes(keyword));
}

function isNoiseLabel(name) {
  return Boolean(getNoiseCategory(name));
}

function getNoiseCategory(name, nodeType = '') {
  const text = String(name || '').trim();

  if (!text) {
    return '';
  }

  if (keywordIncludes(text, NOISE_CATEGORY_KEYWORDS.index_style)) {
    return 'index_style';
  }

  if (keywordIncludes(text, NOISE_CATEGORY_KEYWORDS.capital_style)) {
    return 'capital_style';
  }

  if (keywordIncludes(text, NOISE_CATEGORY_KEYWORDS.size_style)) {
    return 'size_style';
  }

  if (keywordIncludes(text, NOISE_CATEGORY_KEYWORDS.event_style)) {
    return 'event_style';
  }

  if (nodeType === 'region_board' || isRegionBoard(text) || text.includes('特区') || text.includes('大开发')) {
    return 'region';
  }

  return NOISE_LABELS.has(text) ? 'index_style' : '';
}

function normalizeConceptLabel(name) {
  const text = String(name || '').trim();

  if (!text) {
    return '';
  }

  return CONCEPT_ALIAS_MAP.get(text) || text;
}

function getConceptTheme(name) {
  const text = String(name || '').trim();

  if (AI_THEME_LABELS.has(text)) {
    return 'AI';
  }

  return normalizeConceptLabel(text);
}

function stripIndustryLevelSuffix(name) {
  return String(name || '')
    .trim()
    .replace(/[ⅠⅡⅢⅣⅤ]+$/u, '')
    .replace(/\b(?:I|II|III|IV|V)$/iu, '')
    .trim();
}

function getIndustryLevel(name, orderIndex) {
  const text = String(name || '').trim();

  if (/[Ⅲ]$/u.test(text) || /\bIII$/iu.test(text)) {
    return 3;
  }

  if (/[Ⅱ]$/u.test(text) || /\bII$/iu.test(text)) {
    return 2;
  }

  return Number.isFinite(Number(orderIndex)) ? Number(orderIndex) + 1 : 1;
}

function normalizeIndustryLabel(name) {
  return stripIndustryLevelSuffix(name);
}

function isBoardNodeType(type) {
  return type === 'region_board' || type === 'style_board' || type === 'other_board';
}

function isConceptRelation(candidate) {
  return candidate && candidate.node && candidate.node.type === 'concept';
}

function relationMatchesViewMode(candidate, viewMode) {
  if (!candidate || !candidate.node) {
    return false;
  }

  if (viewMode === 'industry') {
    return candidate.node.type === 'industry';
  }

  if (viewMode === 'concept') {
    return isConceptRelation(candidate);
  }

  if (viewMode === 'board') {
    return isBoardNodeType(candidate.node.type);
  }

  if (viewMode === 'stock') {
    return true;
  }

  return candidate.node.type === 'industry' || isConceptRelation(candidate);
}

function getIndustryThemeScore(name) {
  const text = String(name || '');

  if (!text) {
    return 0;
  }

  return INDUSTRY_THEME_KEYWORDS.reduce((score, keyword) => (
    text.includes(keyword) ? score + 0.035 : score
  ), 0);
}

function getCandidateSortScore(candidate) {
  const weight = Number(candidate && (candidate.rankScore || candidate.finalWeight || candidate.weight)) || 0;
  const themeScore = Number(candidate && candidate.themeScore) || 0;
  const reasonBoost = candidate && candidate.reason ? 0.08 : 0;
  const sharedBoost = candidate && candidate.isShared ? 0.12 : 0;
  const noisePenalty = candidate && candidate.isNoise ? 1.4 : 0;
  return weight + themeScore + reasonBoost + sharedBoost - noisePenalty;
}

function compareRelationCandidates(left, right) {
  const scoreDiff = getCandidateSortScore(right) - getCandidateSortScore(left);

  if (Math.abs(scoreDiff) > 0.0001) {
    return scoreDiff;
  }

  return String(left.label || '').localeCompare(String(right.label || ''), 'zh-Hans-CN');
}

function isRegionBoard(name) {
  return keywordIncludes(name, REGION_BOARD_KEYWORDS);
}

function isStyleBoard(name) {
  return keywordIncludes(name, STYLE_BOARD_KEYWORDS);
}

function classifyEastPlate(plate) {
  const plateType = String(plate && plate.plate_type || '').trim();
  const plateName = String(plate && plate.plate_name || '').trim();

  if (plateType === '行业') {
    return 'industry';
  }

  if (isStyleBoard(plateName)) {
    return 'style_board';
  }

  if (plateType === '概念') {
    return 'concept';
  }

  if (plateType === '板块' && isRegionBoard(plateName)) {
    return 'region_board';
  }

  if (plateType === '板块') {
    return 'other_board';
  }

  if (isRegionBoard(plateName)) {
    return 'region_board';
  }

  return 'other_board';
}

function makeStockNode(item) {
  const code = normalizeCode(item && (item.code || item.symbol || item.stock_code));
  const market = item && item.market ? String(item.market) : (String(code).startsWith('HK:') ? 'HK' : '');
  const name = item && (item.displayName || item.name) ? String(item.displayName || item.name) : code;

  return {
    id: `stock:${code}`,
    type: 'stock',
    label: market === 'HK' && !name.includes('（HK）') ? `${name}（HK）` : name,
    code,
    symbol: code,
    market,
    exchange: item && item.exchange ? String(item.exchange) : (market === 'HK' ? 'HKEX' : ''),
    currency: item && item.currency ? String(item.currency) : (market === 'HK' ? 'HKD' : ''),
    status: item && item.status ? String(item.status) : '',
    updatedAt: item && item.updatedAt ? String(item.updatedAt) : ''
  };
}

function upsertNode(nodeMap, node) {
  if (!node || !node.id) {
    return null;
  }

  const existing = nodeMap.get(node.id);

  if (existing) {
    nodeMap.set(node.id, {
      ...existing,
      ...Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined && value !== null && value !== ''))
    });
    return node.id;
  }

  nodeMap.set(node.id, node);
  return node.id;
}

function addMember(memberMap, nodeId, stockNode) {
  if (!nodeId || !stockNode || !stockNode.code) {
    return;
  }

  if (!memberMap.has(nodeId)) {
    memberMap.set(nodeId, new Map());
  }

  memberMap.get(nodeId).set(stockNode.code, {
    code: stockNode.code,
    name: stockNode.label || stockNode.code,
    market: stockNode.market || ''
  });
}

function addEdge(edgeMap, edge, memberMap, stockNode) {
  if (!edge || !edge.source || !edge.target || !edge.relationType) {
    return null;
  }

  const id = edge.id || `${edge.source}->${edge.target}:${edge.relationType}`;
  const existing = edgeMap.get(id);

  if (existing) {
    const reasons = new Set([existing.reason, edge.reason].filter(Boolean));
    edgeMap.set(id, {
      ...existing,
      weight: (Number(existing.weight) || 1) + (Number(edge.weight) || 1),
      reason: Array.from(reasons).join('；')
    });
  } else {
    edgeMap.set(id, {
      ...edge,
      id,
      weight: Number(edge.weight) || 1
    });
  }

  addMember(memberMap, edge.target, stockNode);
  return id;
}

function buildThsConceptNode(concept) {
  const conceptCode = normalizeIdText(concept && (concept.concept_code || concept.name));
  const label = String(concept && (concept.name || concept.concept_code) || '').trim();

  if (!conceptCode || !label) {
    return null;
  }

  return {
    id: `ths_concept:${conceptCode}`,
    type: 'concept',
    label,
    code: conceptCode,
    conceptCode,
    source: concept && concept.source ? String(concept.source) : '同花顺',
    conceptSource: 'ths'
  };
}

function buildEastNode(plate, nodeType) {
  const plateCode = normalizeIdText(plate && (plate.plate_code || plate.plate_name));
  const label = String(plate && (plate.plate_name || plate.plate_code) || '').trim();
  const prefix = EAST_NODE_PREFIX_BY_TYPE[nodeType] || EAST_NODE_PREFIX_BY_TYPE.other_board;

  if (!plateCode || !label) {
    return null;
  }

  return {
    id: `${prefix}:${plateCode}`,
    type: nodeType,
    label,
    code: plateCode,
    plateCode,
    plateType: plate && plate.plate_type ? String(plate.plate_type) : '',
    source: plate && plate.source ? String(plate.source) : '东方财富'
  };
}

function buildThsConceptCandidate(concept, stockNode) {
  const node = buildThsConceptNode(concept);

  if (!node) {
    return null;
  }

  const originalLabel = String(node.label || '').trim();
  const label = normalizeConceptLabel(originalLabel);
  const reason = String(concept && concept.reason || '').trim();
  const noiseCategory = getNoiseCategory(label, 'concept') || getNoiseCategory(originalLabel, 'concept');
  const isNoise = Boolean(noiseCategory);
  const themeScore = getIndustryThemeScore(label);
  const isThemeConcept = themeScore > 0;
  const weight = isNoise ? 0.05 : (reason && isThemeConcept ? 0.9 : (reason ? 0.78 : 0.62));
  const conceptCode = normalizeIdText(label);
  const conceptNode = {
    ...node,
    id: `concept:${conceptCode}`,
    label,
    code: conceptCode,
    conceptCode,
    originalLabel,
    conceptTheme: getConceptTheme(label)
  };

  return {
    group: 'conceptThs',
    stockCode: stockNode.code,
    label,
    originalLabel,
    node: conceptNode,
    relationClass: 'concept',
    reason,
    noiseCategory,
    isNoise,
    themeScore,
    isThemeConcept,
    weight,
    edge: {
      source: stockNode.id,
      target: conceptNode.id,
      relationType: 'stock_to_ths_concept',
      dataSource: concept && concept.source ? String(concept.source) : '同花顺',
      relationSource: concept && concept.source ? String(concept.source) : '同花顺',
      relationClass: 'concept',
      reason,
      noiseCategory,
      isNoise,
      themeScore,
      rankScore: weight + themeScore + (reason ? 0.08 : 0),
      weight
    }
  };
}

function buildEastPlateCandidate(plate, stockNode) {
  const nodeType = classifyEastPlate(plate);
  const node = buildEastNode(plate, nodeType);

  if (!node) {
    return null;
  }

  const originalLabel = String(node.label || '').trim();
  const normalizedLabel = nodeType === 'concept'
    ? normalizeConceptLabel(originalLabel)
    : (nodeType === 'industry' ? normalizeIndustryLabel(originalLabel) : originalLabel);
  const label = normalizedLabel || originalLabel;
  const noiseCategory = getNoiseCategory(label, nodeType) || getNoiseCategory(originalLabel, nodeType);
  const isNoise = Boolean(noiseCategory);
  const relationClass = nodeType === 'industry'
    ? 'industry'
    : (isBoardNodeType(nodeType) ? 'board' : 'concept');
  const themeScore = relationClass === 'concept' || nodeType === 'industry'
    ? getIndustryThemeScore(label)
    : 0;
  const industryLevel = nodeType === 'industry' ? getIndustryLevel(originalLabel, plate && plate.__marketGraphOrder) : 0;
  const isFineIndustry = nodeType === 'industry' && industryLevel >= 3;
  const baseWeight = nodeType === 'industry' && isFineIndustry
    ? 0.55
    : (EAST_WEIGHT_BY_NODE_TYPE[nodeType] || EAST_WEIGHT_BY_NODE_TYPE.other_board);
  const weight = isNoise ? 0.05 : baseWeight;
  const normalizedCode = normalizeIdText(label);
  const normalizedNode = nodeType === 'concept'
    ? {
      ...node,
      id: `concept:${normalizedCode}`,
      label,
      code: normalizedCode,
      conceptCode: normalizedCode,
      originalLabel,
      conceptTheme: getConceptTheme(label)
    }
    : (nodeType === 'industry'
      ? {
        ...node,
        id: `industry:${normalizedCode}`,
        label,
        code: normalizedCode,
        industryLevel,
        originalLabel
      }
      : node);

  return {
    group: 'plateEast',
    stockCode: stockNode.code,
    label,
    originalLabel,
    node: normalizedNode,
    relationClass,
    reason: '',
    noiseCategory,
    isNoise,
    isFineIndustry,
    industryLevel,
    plateType: plate && plate.plate_type ? String(plate.plate_type) : '',
    themeScore,
    weight,
    edge: {
      source: stockNode.id,
      target: normalizedNode.id,
      relationType: EAST_EDGE_TYPE_BY_NODE_TYPE[nodeType] || EAST_EDGE_TYPE_BY_NODE_TYPE.other_board,
      dataSource: plate && plate.source ? String(plate.source) : '东方财富',
      relationSource: plate && plate.source ? String(plate.source) : '东方财富',
      relationClass,
      reason: '',
      noiseCategory,
      isNoise,
      isFineIndustry,
      themeScore,
      rankScore: weight + themeScore,
      weight
    }
  };
}

function createGraphFilterStats() {
  return {
    rawRelationCount: 0,
    resonanceCandidateCount: 0,
    resonanceKeptRelationCount: 0,
    resonanceKeptStockCount: 0,
    resonanceDroppedIsolatedStockCount: 0,
    resonanceFallback: false,
    hiddenNoiseRelationCount: 0,
    hiddenWeakRelationCount: 0,
    hiddenBoardRelationCount: 0,
    hiddenStyleRegionRelationCount: 0,
    foldedIndustryRelationCount: 0,
    globalTrimmedRelationCount: 0,
    hiddenByLimitRelationCount: 0,
    hiddenByViewModeRelationCount: 0,
    hiddenByWeightRelationCount: 0
  };
}

function filterAndLimitCandidates(candidates, limit, options, filterStats) {
  const eligible = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (options.hideNoise && candidate.isNoise) {
      filterStats.hiddenNoiseRelationCount += 1;
      continue;
    }

    if ((Number(candidate.weight) || 0) < options.minEdgeWeight) {
      filterStats.hiddenByWeightRelationCount += 1;
      continue;
    }

    eligible.push(candidate);
  }

  const sorted = eligible.sort(compareRelationCandidates);

  if (limit > 0 && sorted.length > limit) {
    filterStats.hiddenByLimitRelationCount += sorted.length - limit;
    return sorted.slice(0, limit);
  }

  return sorted;
}

function uniqueRelationLabels(candidates, limit) {
  const seen = new Set();
  const list = [];

  for (const candidate of candidates) {
    const label = String(candidate && candidate.label || '').trim();

    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    list.push(label);

    if (limit > 0 && list.length >= limit) {
      break;
    }
  }

  return list;
}

function summarizeStockRelations(allCandidates, selectedCandidates, displayCandidates, options) {
  const noiseRelationCount = allCandidates.filter((candidate) => candidate && candidate.isNoise).length;
  const cleanCandidates = selectedCandidates.filter((candidate) => !candidate.isNoise || !options.hideNoise);
  const cleanAllCandidates = allCandidates.filter((candidate) => !candidate.isNoise || !options.hideNoise);
  const thsReasonCandidates = allCandidates
    .filter((candidate) => candidate && candidate.group === 'conceptThs' && candidate.reason)
    .filter((candidate) => !options.hideNoise || !candidate.isNoise)
    .sort(compareRelationCandidates);

  return {
    totalRelationCount: allCandidates.length,
    displayedRelationCount: displayCandidates.length,
    selectedRelationCount: selectedCandidates.length,
    noiseRelationCount,
    hiddenNoiseCount: options.hideNoise ? noiseRelationCount : 0,
    industries: uniqueRelationLabels(cleanCandidates.filter((candidate) => candidate.node.type === 'industry'), 12),
    strongConcepts: uniqueRelationLabels(cleanCandidates.filter((candidate) => isConceptRelation(candidate)), 16),
    boards: uniqueRelationLabels(cleanCandidates.filter((candidate) => isBoardNodeType(candidate.node.type)), 16),
    thsReasons: thsReasonCandidates.slice(0, 5).map((candidate) => ({
      label: candidate.label,
      reason: candidate.reason
    }))
  };
}

function getNodeLabelPriority(node, degree) {
  if (!node) {
    return 0;
  }

  if (node.type === 'stock') {
    return 1000 + degree;
  }

  if (node.type === 'industry') {
    return 900 + degree;
  }

  if (node.type === 'concept') {
    return 500 + degree * 10;
  }

  if (isBoardNodeType(node.type)) {
    return 180 + degree * 4;
  }

  return degree;
}

function isImportantNodeLabel(node, degree) {
  if (!node) {
    return false;
  }

  if (node.type === 'stock' || node.type === 'industry') {
    return true;
  }

  if (node.type === 'concept') {
    return degree >= 2;
  }

  return isBoardNodeType(node.type) && degree >= 5;
}

function cloneCandidate(candidate, patch = {}) {
  const next = {
    ...candidate,
    ...patch,
    node: {
      ...(candidate.node || {}),
      ...(patch.node || {})
    },
    edge: {
      ...(candidate.edge || {}),
      ...(patch.edge || {})
    }
  };

  next.edge.target = next.node.id;
  next.edge.weight = Number(next.finalWeight || next.weight || next.edge.weight) || 1;
  next.edge.rankScore = Number(next.rankScore || next.edge.rankScore || next.edge.weight) || next.edge.weight;
  next.edge.sharedStockCount = Number(next.sharedStockCount) || 1;
  next.edge.id = `${next.edge.source}->${next.edge.target}`;
  return next;
}

function foldIndustryCandidates(candidates, filterStats) {
  const industryCandidates = candidates
    .filter((candidate) => candidate && candidate.relationClass === 'industry')
    .sort((left, right) => (Number(left.industryLevel) || 9) - (Number(right.industryLevel) || 9));
  const otherCandidates = candidates.filter((candidate) => candidate && candidate.relationClass !== 'industry');
  const industryPath = industryCandidates
    .map((candidate) => candidate.originalLabel || candidate.label)
    .filter(Boolean);
  const folded = [];
  const seenLabels = new Set();

  for (const candidate of industryCandidates) {
    const label = normalizeIndustryLabel(candidate.originalLabel || candidate.label);

    if (!label || seenLabels.has(label)) {
      filterStats.foldedIndustryRelationCount += 1;
      continue;
    }

    const hasReadableParent = folded.some((item) => (
      label !== item.label && (label.includes(item.label) || item.label.includes(label))
    ));

    if ((Number(candidate.industryLevel) || 1) >= 3 && hasReadableParent) {
      filterStats.foldedIndustryRelationCount += 1;
      continue;
    }

    seenLabels.add(label);
    const nodeId = `industry:${normalizeIdText(label)}`;
    folded.push(cloneCandidate(candidate, {
      label,
      industryPath,
      node: {
        ...candidate.node,
        id: nodeId,
        label,
        code: normalizeIdText(label),
        industryPath
      },
      edge: {
        ...candidate.edge,
        target: nodeId,
        isFineIndustry: Boolean(candidate.isFineIndustry)
      }
    }));
  }

  return [...otherCandidates, ...folded];
}

function getCandidateNodeWeight(candidate) {
  return Number(candidate && (candidate.rankScore || candidate.finalWeight || candidate.weight)) || 0;
}

function applySharedWeights(stockEntries) {
  const nodeStockMap = new Map();

  for (const entry of stockEntries) {
    const seen = new Set();

    for (const candidate of entry.allCandidates) {
      if (!candidate || !candidate.node || seen.has(candidate.node.id)) {
        continue;
      }

      seen.add(candidate.node.id);

      if (!nodeStockMap.has(candidate.node.id)) {
        nodeStockMap.set(candidate.node.id, new Set());
      }

      nodeStockMap.get(candidate.node.id).add(entry.stockNode.code);
    }
  }

  for (const entry of stockEntries) {
    entry.allCandidates = entry.allCandidates.map((candidate) => {
      const sharedStockCount = nodeStockMap.has(candidate.node.id)
        ? nodeStockMap.get(candidate.node.id).size
        : 1;
      const sharedBoost = sharedStockCount >= 2 ? 0.3 : 0;
      const finalWeight = Number(candidate.weight || 0) + sharedBoost;
      const rankScore = finalWeight + (Number(candidate.themeScore) || 0) + (candidate.reason ? 0.08 : 0);

      return cloneCandidate(candidate, {
        sharedStockCount,
        isShared: sharedStockCount >= 2,
        finalWeight,
        rankScore,
        node: {
          ...candidate.node,
          sharedStockCount,
          isShared: sharedStockCount >= 2,
          weight: finalWeight
        },
        edge: {
          ...candidate.edge,
          weight: finalWeight,
          rankScore,
          sharedStockCount,
          isShared: sharedStockCount >= 2
        }
      });
    });
  }
}

function isResonanceRelationCandidate(candidate) {
  return Boolean(
    candidate &&
    candidate.node &&
    (candidate.relationClass === 'industry' || candidate.relationClass === 'concept') &&
    (candidate.node.type === 'industry' || candidate.node.type === 'concept')
  );
}

function isResonanceVisibleRelationCandidate(candidate) {
  return isResonanceRelationCandidate(candidate) && !candidate.isNoise && !candidate.noiseCategory;
}

function getResonanceCandidateWeight(candidate) {
  return Number(candidate && (candidate.finalWeight || candidate.weight || (candidate.edge && candidate.edge.weight))) || 0;
}

function createResonanceState(stockEntries, filterStats) {
  const relationStats = new Map();

  for (const entry of stockEntries) {
    const seenNodeIds = new Set();

    for (const candidate of entry.allCandidates) {
      if (!isResonanceRelationCandidate(candidate)) {
        continue;
      }

      if (candidate.isNoise || candidate.noiseCategory) {
        filterStats.hiddenNoiseRelationCount += 1;
        continue;
      }

      const nodeId = candidate.node.id;
      const current = relationStats.get(nodeId) || {
        node: candidate.node,
        score: 0,
        degree: 0,
        maxWeight: 0,
        stockCodes: new Set()
      };

      current.score += getCandidateNodeWeight(candidate);
      current.maxWeight = Math.max(current.maxWeight, getResonanceCandidateWeight(candidate));

      if (!seenNodeIds.has(nodeId)) {
        current.stockCodes.add(entry.stockNode.code);
        current.degree = current.stockCodes.size;
        seenNodeIds.add(nodeId);
      }

      relationStats.set(nodeId, current);
    }
  }

  const keptRelationIds = new Set();

  relationStats.forEach((item, nodeId) => {
    if (item.degree >= 2 || item.maxWeight >= 0.9) {
      keptRelationIds.add(nodeId);
    }
  });

  filterStats.resonanceCandidateCount = relationStats.size;
  filterStats.resonanceFallback = keptRelationIds.size === 0;

  return {
    relationStats,
    keptRelationIds,
    fallback: keptRelationIds.size === 0
  };
}

function selectResonanceFallbackCandidates(entry, options) {
  const selectedNodeIds = new Set();
  const cleanCandidates = entry.allCandidates
    .filter(isResonanceVisibleRelationCandidate)
    .filter((candidate) => getResonanceCandidateWeight(candidate) >= options.minEdgeWeight)
    .sort(compareRelationCandidates);
  const industries = cleanCandidates
    .filter((candidate) => candidate.relationClass === 'industry')
    .slice(0, 1);
  const strongConcepts = cleanCandidates
    .filter((candidate) => candidate.relationClass === 'concept' && getResonanceCandidateWeight(candidate) >= 0.9)
    .slice(0, 2);
  const concepts = strongConcepts.slice();

  for (const candidate of cleanCandidates) {
    if (concepts.length >= 2) {
      break;
    }

    if (candidate.relationClass !== 'concept') {
      continue;
    }

    if (concepts.some((item) => item.node.id === candidate.node.id)) {
      continue;
    }

    concepts.push(candidate);
  }

  return [...industries, ...concepts]
    .filter((candidate) => {
      if (selectedNodeIds.has(candidate.node.id)) {
        return false;
      }

      selectedNodeIds.add(candidate.node.id);
      return true;
    })
    .sort(compareRelationCandidates);
}

function isWeakCandidate(candidate) {
  if (!candidate || candidate.isShared) {
    return false;
  }

  if (candidate.relationClass === 'industry') {
    return Boolean(candidate.isFineIndustry) || Number(candidate.finalWeight || candidate.weight) < 0.85;
  }

  if (candidate.relationClass === 'concept') {
    return Number(candidate.finalWeight || candidate.weight) < 0.9;
  }

  return true;
}

function isDisplayableCandidate(candidate, options, filterStats) {
  if (!candidate) {
    return false;
  }

  if (options.viewPreset === 'raw') {
    return true;
  }

  if (options.hideNoise && candidate.isNoise) {
    filterStats.hiddenNoiseRelationCount += 1;
    return false;
  }

  if ((Number(candidate.finalWeight || candidate.weight) || 0) < options.minEdgeWeight) {
    filterStats.hiddenByWeightRelationCount += 1;
    return false;
  }

  if (candidate.relationClass === 'board') {
    if (candidate.node.type === 'region_board' || candidate.node.type === 'style_board') {
      if (!options.showStyleRegion) {
        filterStats.hiddenStyleRegionRelationCount += 1;
        return false;
      }
    }

    if (!options.showBoards) {
      filterStats.hiddenBoardRelationCount += 1;
      return false;
    }
  }

  if (options.hideWeak && isWeakCandidate(candidate)) {
    filterStats.hiddenWeakRelationCount += 1;
    return false;
  }

  return true;
}

function getLimitedStockCandidates(candidates, options, bypassLimits = false) {
  const sorted = candidates.slice().sort(compareRelationCandidates);

  if (bypassLimits || options.viewPreset === 'raw') {
    return sorted;
  }

  const industries = sorted
    .filter((candidate) => candidate.relationClass === 'industry')
    .slice(0, options.maxPlatesPerStock);
  const boards = sorted
    .filter((candidate) => candidate.relationClass === 'board')
    .slice(0, options.maxPlatesPerStock);
  const conceptCandidates = sorted.filter((candidate) => candidate.relationClass === 'concept');
  const selectedConceptIds = new Set();
  const concepts = [];
  const pushConcepts = (items, limit) => {
    for (const candidate of items) {
      if (concepts.length >= options.maxConceptsPerStock || concepts.length >= limit) {
        return;
      }

      if (selectedConceptIds.has(candidate.node.id)) {
        continue;
      }

      selectedConceptIds.add(candidate.node.id);
      concepts.push(candidate);
    }
  };
  const sharedConcepts = conceptCandidates.filter((candidate) => candidate.isShared);
  const strongUniqueConcepts = conceptCandidates.filter((candidate) => (
    !candidate.isShared && Number(candidate.finalWeight || candidate.weight) >= 0.9
  ));

  pushConcepts(sharedConcepts, Math.min(3, options.maxConceptsPerStock));
  pushConcepts(strongUniqueConcepts, options.maxConceptsPerStock);
  pushConcepts(conceptCandidates, options.maxConceptsPerStock);

  return [...industries, ...concepts, ...boards].sort(compareRelationCandidates);
}

function selectEntryCandidates(entry, options, filterStats, resonanceState = null) {
  const isExpandedStock = options.expandStockCode && entry.stockNode.code === options.expandStockCode;
  const isFocusPreset = isStockFocusViewPreset(options.viewPreset);

  if (isStockFocusViewPreset(options.viewPreset) && options.focusCode && entry.stockNode.code !== options.focusCode) {
    return [];
  }

  let candidates = entry.allCandidates;

  if (options.viewPreset === 'resonance') {
    if (resonanceState && resonanceState.fallback && !isExpandedStock) {
      return selectResonanceFallbackCandidates(entry, options);
    }

    candidates = candidates.filter((candidate) => (
      isResonanceVisibleRelationCandidate(candidate) &&
      (!resonanceState || resonanceState.keptRelationIds.has(candidate.node.id))
    ));
  }

  const displayable = candidates.filter((candidate) => (
    isExpandedStock
      ? true
      : isDisplayableCandidate(candidate, options, filterStats)
  ));

  return getLimitedStockCandidates(displayable, options, isExpandedStock || (isFocusPreset && !options.hideWeak));
}

function getNodeBudgetForType(type, options) {
  if (type === 'industry') {
    return options.maxOverviewIndustries;
  }

  if (type === 'concept') {
    return options.maxOverviewConcepts;
  }

  if (isBoardNodeType(type)) {
    return options.showBoards ? 10 : 0;
  }

  return Infinity;
}

function getSelectedCandidateCount(selectedByStock) {
  let count = 0;

  selectedByStock.forEach((candidates) => {
    count += candidates.length;
  });

  return count;
}

function getResonanceRelationBudget(relationCount, options) {
  if (relationCount <= 0) {
    return 0;
  }

  const typeBudget = Math.max(1, options.maxOverviewIndustries + options.maxOverviewConcepts);
  const targetBudget = Math.max(1, Math.floor(options.targetNodeCount * 0.4));
  return Math.min(relationCount, typeBudget, targetBudget);
}

function scoreResonanceRelationNode(item) {
  return (Number(item.degree) || 0) * 0.45 + (Number(item.score) || 0);
}

function trimResonanceCandidatesByGraphBudget(stockEntries, selectedByStock, options, filterStats) {
  const selectedCandidateCount = getSelectedCandidateCount(selectedByStock);
  const relationScores = new Map();

  selectedByStock.forEach((candidates, stockCode) => {
    const seenNodeIds = new Set();

    candidates.forEach((candidate) => {
      if (!isResonanceRelationCandidate(candidate)) {
        return;
      }

      const nodeId = candidate.node.id;
      const current = relationScores.get(nodeId) || {
        node: candidate.node,
        score: 0,
        degree: 0,
        stockCodes: new Set()
      };

      current.score += getCandidateNodeWeight(candidate);

      if (!seenNodeIds.has(nodeId)) {
        current.stockCodes.add(stockCode);
        current.degree = current.stockCodes.size;
        seenNodeIds.add(nodeId);
      }

      relationScores.set(nodeId, current);
    });
  });

  if (relationScores.size === 0) {
    filterStats.globalTrimmedRelationCount += selectedCandidateCount;
    return new Map();
  }

  const relationBudget = getResonanceRelationBudget(relationScores.size, options);
  const typeCounts = {
    industry: 0,
    concept: 0
  };
  const allowedRelationIds = new Set();
  const allowedRelationItems = [];
  const relationItems = Array.from(relationScores.values())
    .sort((left, right) => {
      const scoreDiff = scoreResonanceRelationNode(right) - scoreResonanceRelationNode(left);
      return Math.abs(scoreDiff) > 0.0001
        ? scoreDiff
        : String(left.node.label || '').localeCompare(String(right.node.label || ''), 'zh-Hans-CN');
    });

  for (const item of relationItems) {
    if (allowedRelationIds.size >= relationBudget) {
      break;
    }

    const type = item.node.type;
    const typeBudget = getNodeBudgetForType(type, options);

    if (typeCounts[type] >= typeBudget) {
      continue;
    }

    allowedRelationIds.add(item.node.id);
    allowedRelationItems.push(item);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  const edgeItems = [];

  selectedByStock.forEach((candidates, stockCode) => {
    candidates.forEach((candidate) => {
      if (allowedRelationIds.has(candidate.node.id)) {
        edgeItems.push({ stockCode, candidate });
      }
    });
  });

  if (edgeItems.length === 0) {
    filterStats.globalTrimmedRelationCount += selectedCandidateCount;
    return new Map();
  }

  const orderedEdgeItems = edgeItems
    .slice()
    .sort((left, right) => compareRelationCandidates(left.candidate, right.candidate));
  const stockBudget = Math.max(1, options.targetNodeCount - allowedRelationIds.size);
  const stockScores = new Map();

  edgeItems.forEach((edgeItem) => {
    const current = stockScores.get(edgeItem.stockCode) || {
      stockCode: edgeItem.stockCode,
      score: 0,
      edgeCount: 0
    };

    current.score += getCandidateNodeWeight(edgeItem.candidate);
    current.edgeCount += 1;
    stockScores.set(edgeItem.stockCode, current);
  });

  const allowedStockCodes = new Set();
  const coverageEdges = [];
  const seenCoverageEdgeKeys = new Set();
  const getEdgeItemKey = (item) => `${item.stockCode}->${item.candidate.node.id}`;

  for (const relationItem of allowedRelationItems) {
    const edgeItem = orderedEdgeItems.find((item) => item.candidate.node.id === relationItem.node.id);

    if (!edgeItem) {
      continue;
    }

    if (allowedStockCodes.size < stockBudget) {
      allowedStockCodes.add(edgeItem.stockCode);
    }

    if (allowedStockCodes.has(edgeItem.stockCode)) {
      const edgeKey = getEdgeItemKey(edgeItem);

      if (!seenCoverageEdgeKeys.has(edgeKey)) {
        seenCoverageEdgeKeys.add(edgeKey);
        coverageEdges.push(edgeItem);
      }
    }
  }

  Array.from(stockScores.values())
    .sort((left, right) => {
      const scoreDiff = (right.edgeCount * 0.55 + right.score) - (left.edgeCount * 0.55 + left.score);
      return Math.abs(scoreDiff) > 0.0001
        ? scoreDiff
        : String(left.stockCode || '').localeCompare(String(right.stockCode || ''));
    })
    .forEach((item) => {
      if (allowedStockCodes.size < stockBudget) {
        allowedStockCodes.add(item.stockCode);
      }
    });

  const allowedEdges = [];
  const seenEdgeKeys = new Set();
  const pushAllowedEdge = (item) => {
    if (!item || allowedEdges.length >= options.targetEdgeCount || !allowedStockCodes.has(item.stockCode)) {
      return;
    }

    const edgeKey = getEdgeItemKey(item);

    if (seenEdgeKeys.has(edgeKey)) {
      return;
    }

    seenEdgeKeys.add(edgeKey);
    allowedEdges.push(item);
  };

  coverageEdges.forEach(pushAllowedEdge);
  orderedEdgeItems.forEach(pushAllowedEdge);

  const next = new Map();

  allowedEdges.forEach(({ stockCode, candidate }) => {
    if (!next.has(stockCode)) {
      next.set(stockCode, []);
    }

    next.get(stockCode).push(candidate);
  });

  filterStats.globalTrimmedRelationCount += Math.max(0, selectedCandidateCount - allowedEdges.length);
  return next;
}

function trimCandidatesByGraphBudget(stockEntries, selectedByStock, options, filterStats) {
  if (options.viewPreset === 'resonance') {
    return trimResonanceCandidatesByGraphBudget(stockEntries, selectedByStock, options, filterStats);
  }

  if (options.viewPreset === 'raw' || options.expandStockCode) {
    return selectedByStock;
  }

  const stockCount = stockEntries.length;
  const nodeScores = new Map();

  selectedByStock.forEach((candidates) => {
    candidates.forEach((candidate) => {
      const current = nodeScores.get(candidate.node.id) || {
        node: candidate.node,
        score: 0,
        degree: 0
      };

      current.score += getCandidateNodeWeight(candidate);
      current.degree += 1;
      nodeScores.set(candidate.node.id, current);
    });
  });

  const allowedNodeIds = new Set();
  const grouped = {
    industry: [],
    concept: [],
    board: []
  };

  nodeScores.forEach((item) => {
    if (item.node.type === 'industry') {
      grouped.industry.push(item);
    } else if (item.node.type === 'concept') {
      grouped.concept.push(item);
    } else if (isBoardNodeType(item.node.type)) {
      grouped.board.push(item);
    }
  });

  Object.entries(grouped).forEach(([type, items]) => {
    const budget = getNodeBudgetForType(type, options);
    items
      .sort((left, right) => {
        const scoreDiff = (right.degree * 0.35 + right.score) - (left.degree * 0.35 + left.score);
        return Math.abs(scoreDiff) > 0.0001
          ? scoreDiff
          : String(left.node.label || '').localeCompare(String(right.node.label || ''), 'zh-Hans-CN');
      })
      .slice(0, budget)
      .forEach((item) => allowedNodeIds.add(item.node.id));
  });

  const maxExtraNodes = Math.max(0, options.targetNodeCount - stockCount);

  if (allowedNodeIds.size > maxExtraNodes) {
    const allowedItems = Array.from(allowedNodeIds)
      .map((nodeId) => nodeScores.get(nodeId))
      .filter(Boolean)
      .sort((left, right) => (right.degree * 0.35 + right.score) - (left.degree * 0.35 + left.score));

    allowedNodeIds.clear();
    allowedItems.slice(0, maxExtraNodes).forEach((item) => allowedNodeIds.add(item.node.id));
  }

  const edgeItems = [];

  selectedByStock.forEach((candidates, stockCode) => {
    candidates.forEach((candidate) => {
      if (allowedNodeIds.has(candidate.node.id)) {
        edgeItems.push({ stockCode, candidate });
      }
    });
  });

  edgeItems.sort((left, right) => compareRelationCandidates(left.candidate, right.candidate));
  const allowedEdges = edgeItems.slice(0, options.targetEdgeCount);
  const trimmedCount = Math.max(0, edgeItems.length - allowedEdges.length);
  filterStats.globalTrimmedRelationCount += trimmedCount;

  const next = new Map();
  stockEntries.forEach((entry) => next.set(entry.stockNode.code, []));
  allowedEdges.forEach(({ stockCode, candidate }) => {
    next.get(stockCode).push(candidate);
  });

  return next;
}

function countNoiseByCategory(candidates) {
  return candidates.reduce((acc, candidate) => {
    const category = candidate && candidate.noiseCategory ? candidate.noiseCategory : '';

    if (category) {
      acc[category] = (acc[category] || 0) + 1;
    }

    return acc;
  }, {});
}

function updateResonanceStatsFromSelection(stockEntries, selectedByStock, filterStats, resonanceState) {
  const keptStockCodes = new Set();
  const keptRelationIds = new Set();

  selectedByStock.forEach((candidates, stockCode) => {
    if (candidates.length > 0) {
      keptStockCodes.add(stockCode);
    }

    candidates.forEach((candidate) => {
      if (isResonanceRelationCandidate(candidate)) {
        keptRelationIds.add(candidate.node.id);
      }
    });
  });

  filterStats.resonanceKeptRelationCount = keptRelationIds.size;
  filterStats.resonanceKeptStockCount = keptStockCodes.size;
  filterStats.resonanceDroppedIsolatedStockCount = Math.max(0, stockEntries.length - keptStockCodes.size);
  filterStats.resonanceFallback = Boolean(resonanceState && resonanceState.fallback);
}

function summarizeStockRelations(allCandidates, selectedCandidates, displayCandidates, options) {
  const noiseByCategory = countNoiseByCategory(allCandidates);
  const noiseRelationCount = allCandidates.filter((candidate) => candidate && candidate.isNoise).length;
  const styleRegionCount = allCandidates.filter((candidate) => (
    candidate &&
    (
      candidate.noiseCategory === 'region' ||
      candidate.noiseCategory === 'index_style' ||
      candidate.node.type === 'region_board' ||
      candidate.node.type === 'style_board'
    )
  )).length;
  const cleanCandidates = selectedCandidates.filter((candidate) => !candidate.isNoise || !options.hideNoise);
  const cleanAllCandidates = allCandidates.filter((candidate) => !candidate.isNoise || !options.hideNoise);
  const thsReasonCandidates = allCandidates
    .filter((candidate) => candidate && candidate.group === 'conceptThs' && candidate.reason)
    .sort(compareRelationCandidates);
  const industryPaths = [];
  const seenPaths = new Set();

  allCandidates
    .filter((candidate) => candidate && candidate.relationClass === 'industry' && Array.isArray(candidate.industryPath))
    .forEach((candidate) => {
      const pathText = candidate.industryPath.join(' / ');

      if (pathText && !seenPaths.has(pathText)) {
        seenPaths.add(pathText);
        industryPaths.push(pathText);
      }
    });

  return {
    totalRelationCount: allCandidates.length,
    displayedRelationCount: displayCandidates.length,
    selectedRelationCount: selectedCandidates.length,
    noiseRelationCount,
    hiddenNoiseCount: options.hideNoise ? noiseRelationCount : 0,
    hiddenStyleRegionCount: styleRegionCount,
    hiddenWeakCount: allCandidates.filter(isWeakCandidate).length,
    noiseByCategory,
    industryPaths,
    displayedRelations: uniqueRelationLabels(displayCandidates, 24),
    allIndustries: uniqueRelationLabels(cleanAllCandidates.filter((candidate) => candidate.node.type === 'industry'), 24),
    allConcepts: uniqueRelationLabels(cleanAllCandidates.filter((candidate) => isConceptRelation(candidate)), 80),
    industries: uniqueRelationLabels(cleanCandidates.filter((candidate) => candidate.node.type === 'industry'), 12),
    strongConcepts: uniqueRelationLabels(cleanCandidates.filter((candidate) => isConceptRelation(candidate)), 16),
    boards: uniqueRelationLabels(cleanCandidates.filter((candidate) => isBoardNodeType(candidate.node.type)), 16),
    thsReasons: thsReasonCandidates.map((candidate) => ({
      label: candidate.label,
      reason: candidate.reason
    }))
  };
}

function hasRelationData(item) {
  return asList(item && item.conceptThs).length > 0 || asList(item && item.plateEast).length > 0;
}

function isStockFocusViewPreset(viewPreset) {
  return viewPreset === 'focus' || viewPreset === 'stockFocus';
}

function getRelationReadyItems(seed, options = {}) {
  let items = Object.values(seed.items || {})
    .filter((item) => (
      item &&
      THEME_RELATION_READY_STATUSES.has(String(item.status || '')) &&
      normalizeCode(item.code) &&
      hasRelationData(item)
    ));

  const codes = Array.isArray(options.codes)
    ? new Set(options.codes.map(normalizeCode).filter(Boolean))
    : null;

  if (codes && codes.size > 0) {
    items = items.filter((item) => codes.has(normalizeCode(item.code)));
  }

  const searchText = String(options.search || '').trim().toLowerCase();

  if (searchText) {
    items = items.filter((item) => {
      const code = normalizeCode(item.code);
      const name = String(item.name || '').toLowerCase();
      return code.includes(searchText) || name.includes(searchText);
    });
  }

  const limit = getLimit(options.limit);

  if (limit > 0) {
    items = items.slice(0, limit);
  }

  return items;
}

function createStockEntries(items, filterStats) {
  return items.map((item) => {
    const stockNode = makeStockNode(item);
    const thsCandidates = asList(item.conceptThs)
      .map((concept) => buildThsConceptCandidate(concept, stockNode))
      .filter(Boolean);
    const eastCandidates = asList(item.plateEast)
      .map((plate, index) => buildEastPlateCandidate({
        ...plate,
        __marketGraphOrder: index
      }, stockNode))
      .filter(Boolean);
    const allCandidates = foldIndustryCandidates([...thsCandidates, ...eastCandidates], filterStats);

    filterStats.rawRelationCount += allCandidates.length;

    return {
      item,
      stockNode,
      allCandidates
    };
  });
}

function isThemeAggregateRelation(candidate) {
  return Boolean(
    candidate &&
    candidate.node &&
    (candidate.node.type === 'industry' || candidate.node.type === 'concept') &&
    (candidate.relationClass === 'industry' || candidate.relationClass === 'concept')
  );
}

function createThemeAggregate(seedNode, aggregateType, label) {
  const normalizedLabel = aggregateType === 'industry'
    ? normalizeIndustryLabel(label)
    : normalizeConceptLabel(label);
  const code = normalizeIdText(normalizedLabel);
  const id = aggregateType === 'theme'
    ? `theme:${code}`
    : `${aggregateType}:${code}`;

  return {
    id,
    type: aggregateType,
    label: normalizedLabel,
    code,
    source: '',
    relationCount: 0,
    weight: 0,
    themeScore: aggregateType === 'theme' && normalizedLabel === 'AI'
      ? 0.12
      : getIndustryThemeScore(normalizedLabel),
    _sourceSet: new Set(),
    _memberStockMap: new Map(),
    _stockCodes: new Set(),
    _relationNodeIds: new Set(seedNode && seedNode.id ? [seedNode.id] : [])
  };
}

function getThemeAggregateSource(candidate) {
  return String(
    candidate &&
    (
      (candidate.node && candidate.node.source) ||
      (candidate.edge && (candidate.edge.relationSource || candidate.edge.dataSource)) ||
      candidate.source
    ) ||
    ''
  ).trim();
}

function upsertThemeAggregate(aggregateMap, input, stockNode, candidate) {
  const label = String(input && input.label || '').trim();
  const type = input && input.type ? String(input.type) : '';

  if (!label || !type || !stockNode || !stockNode.code) {
    return null;
  }

  const normalizedLabel = type === 'industry'
    ? normalizeIndustryLabel(label)
    : normalizeConceptLabel(label);
  const code = normalizeIdText(normalizedLabel);
  const id = type === 'theme'
    ? `theme:${code}`
    : `${type}:${code}`;
  const aggregate = aggregateMap.get(id) || createThemeAggregate(input.node, type, normalizedLabel);
  const source = getThemeAggregateSource(candidate);

  if (source) {
    aggregate._sourceSet.add(source);
  }

  if (candidate && candidate.node && candidate.node.id) {
    aggregate._relationNodeIds.add(candidate.node.id);
  }

  if (!aggregate._stockCodes.has(stockNode.code)) {
    aggregate._stockCodes.add(stockNode.code);
    aggregate._memberStockMap.set(stockNode.code, {
      code: stockNode.code,
      name: stockNode.label || stockNode.code,
      market: stockNode.market || ''
    });
    aggregate.relationCount += 1;
  }

  aggregate.weight += Number(candidate && (candidate.finalWeight || candidate.rankScore || candidate.weight)) || 1;
  aggregate.themeScore = Math.max(
    Number(aggregate.themeScore) || 0,
    Number(candidate && candidate.themeScore) || 0,
    type === 'theme' && normalizedLabel === 'AI' ? 0.12 : getIndustryThemeScore(normalizedLabel)
  );
  aggregate.source = Array.from(aggregate._sourceSet).join('/');
  aggregateMap.set(id, aggregate);
  return aggregate;
}

function collectThemeAggregates(stockEntries, options, filterStats) {
  const aggregateMap = new Map();

  for (const entry of stockEntries) {
    const seenAggregateIds = new Set();

    for (const candidate of entry.allCandidates) {
      if (!isThemeAggregateRelation(candidate)) {
        continue;
      }

      if (options.hideNoise && (candidate.isNoise || candidate.noiseCategory)) {
        filterStats.hiddenNoiseRelationCount += 1;
        continue;
      }

      const nodeType = candidate.node.type;
      const label = String(candidate.node.label || candidate.label || '').trim();
      const normalizedLabel = nodeType === 'industry'
        ? normalizeIndustryLabel(label)
        : normalizeConceptLabel(label);
      const aggregateId = `${nodeType}:${normalizeIdText(normalizedLabel)}`;

      if (!seenAggregateIds.has(aggregateId)) {
        seenAggregateIds.add(aggregateId);
        upsertThemeAggregate(aggregateMap, {
          type: nodeType,
          label: normalizedLabel,
          node: candidate.node
        }, entry.stockNode, candidate);
      }

      if (nodeType === 'concept') {
        const themeLabel = getConceptTheme(normalizedLabel);
        const themeId = `theme:${normalizeIdText(themeLabel)}`;

        if (themeLabel && themeLabel !== normalizedLabel && !seenAggregateIds.has(themeId)) {
          seenAggregateIds.add(themeId);
          upsertThemeAggregate(aggregateMap, {
            type: 'theme',
            label: themeLabel,
            node: candidate.node
          }, entry.stockNode, candidate);
        }
      }
    }
  }

  return aggregateMap;
}

function getThemeAggregateMembers(aggregate, includeAllMembers = false) {
  const list = Array.from((aggregate && aggregate._memberStockMap) || new Map())
    .map(([, value]) => value)
    .sort((left, right) => String(left.code || '').localeCompare(String(right.code || '')));

  return includeAllMembers ? list : list.slice(0, 50);
}

function getThemeAggregateSortScore(aggregate) {
  const memberStockCount = Number(aggregate && aggregate.memberStockCount) || 0;
  const relationCount = Number(aggregate && aggregate.relationCount) || 0;
  const weight = Number(aggregate && aggregate.weight) || 0;
  const themeScore = Number(aggregate && aggregate.themeScore) || 0;
  const typeBoost = aggregate && aggregate.type === 'industry'
    ? 16
    : (aggregate && aggregate.type === 'theme' ? 10 : 0);

  return memberStockCount + relationCount * 0.12 + weight * 1.8 + themeScore * 120 + typeBoost;
}

function isHighWeightThemeAggregate(aggregate) {
  return Boolean(
    aggregate &&
    Number(aggregate.memberStockCount) >= 2 &&
    (
      Number(aggregate.themeScore) >= 0.035 ||
      (aggregate.type === 'theme' && Number(aggregate.weight) >= 1.4) ||
      Number(aggregate.weight) >= 3
    )
  );
}

function isStrongStandaloneThemeAggregate(aggregate, options) {
  if (!aggregate) {
    return false;
  }

  const memberStockCount = Number(aggregate.memberStockCount) || 0;

  if (aggregate.type === 'industry' && memberStockCount >= options.minThemeMemberStockCount) {
    return true;
  }

  return memberStockCount >= 10 || isHighWeightThemeAggregate(aggregate);
}

function finalizeThemeAggregates(aggregateMap, options, filterStats) {
  const aggregates = Array.from(aggregateMap.values()).map((aggregate) => ({
    ...aggregate,
    memberStockCount: aggregate._stockCodes.size,
    memberStocksPreview: getThemeAggregateMembers(aggregate, false),
    memberStocks: getThemeAggregateMembers(aggregate, false),
    relationNodeCount: aggregate._relationNodeIds.size,
    source: aggregate.source || '本地关系库'
  }));
  const eligible = [];

  for (const aggregate of aggregates) {
    const memberStockCount = Number(aggregate.memberStockCount) || 0;
    const keep = memberStockCount >= options.minThemeMemberStockCount ||
      (aggregate.type === 'industry' && memberStockCount >= 2) ||
      isHighWeightThemeAggregate(aggregate);

    if (!keep) {
      filterStats.hiddenWeakRelationCount += Number(aggregate.relationCount) || 0;
      continue;
    }

    eligible.push(aggregate);
  }

  return {
    allAggregates: aggregates,
    eligibleAggregates: eligible.sort((left, right) => {
      const scoreDiff = getThemeAggregateSortScore(right) - getThemeAggregateSortScore(left);
      return Math.abs(scoreDiff) > 0.0001
        ? scoreDiff
        : String(left.label || '').localeCompare(String(right.label || ''), 'zh-Hans-CN');
    })
  };
}

function getSharedStocks(left, right, limit = 20) {
  const leftSet = left && left._stockCodes ? left._stockCodes : new Set();
  const rightSet = right && right._stockCodes ? right._stockCodes : new Set();
  const smallSet = leftSet.size <= rightSet.size ? leftSet : rightSet;
  const bigSet = leftSet.size <= rightSet.size ? rightSet : leftSet;
  const memberMap = leftSet.size <= rightSet.size ? left._memberStockMap : right._memberStockMap;
  const preview = [];
  let count = 0;

  for (const code of smallSet) {
    if (!bigSet.has(code)) {
      continue;
    }

    count += 1;

    if (preview.length < limit) {
      const member = memberMap.get(code);
      preview.push(member || { code, name: code, market: '' });
    }
  }

  return {
    count,
    preview
  };
}

function createSharedThemeEdge(left, right, shared) {
  const source = String(left.id || '').localeCompare(String(right.id || '')) <= 0 ? left : right;
  const target = source === left ? right : left;

  return {
    id: `${source.id}->${target.id}:shared_stock`,
    source: source.id,
    target: target.id,
    type: 'shared_stock',
    relationType: 'shared_stock',
    relationClass: 'theme',
    sharedStockCount: shared.count,
    sharedStocksPreview: shared.preview,
    weight: Math.max(0.8, Math.min(4.4, Math.log2(shared.count + 1))),
    rankScore: shared.count
  };
}

function buildSharedThemeEdges(aggregates, options, focusThemeId = '') {
  const edges = [];

  for (let i = 0; i < aggregates.length; i += 1) {
    for (let j = i + 1; j < aggregates.length; j += 1) {
      const left = aggregates[i];
      const right = aggregates[j];

      if (focusThemeId && left.id !== focusThemeId && right.id !== focusThemeId) {
        continue;
      }

      const shared = getSharedStocks(left, right);

      if (shared.count < options.minSharedStockCount) {
        continue;
      }

      edges.push(createSharedThemeEdge(left, right, shared));
    }
  }

  return edges.sort((left, right) => {
    const countDiff = (Number(right.sharedStockCount) || 0) - (Number(left.sharedStockCount) || 0);

    if (countDiff !== 0) {
      return countDiff;
    }

    return String(left.id || '').localeCompare(String(right.id || ''));
  });
}

function toThemeGraphNode(aggregate, degree, includeAllMembers = false) {
  const memberStocks = getThemeAggregateMembers(aggregate, includeAllMembers);

  return {
    id: aggregate.id,
    type: aggregate.type,
    label: aggregate.label,
    code: aggregate.code,
    source: aggregate.source || '本地关系库',
    memberStockCount: Number(aggregate.memberStockCount) || 0,
    memberStocksPreview: getThemeAggregateMembers(aggregate, false),
    memberStocks,
    relationCount: Number(aggregate.relationCount) || 0,
    relationNodeCount: Number(aggregate.relationNodeCount) || 0,
    weight: Number(aggregate.weight) || 0,
    themeScore: Number(aggregate.themeScore) || 0,
    degree,
    labelPriority: Math.round(getThemeAggregateSortScore(aggregate)) + degree * 10,
    importantLabel: true
  };
}

function attachRelatedThemePreviews(nodes, edges) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const relatedMap = new Map(nodes.map((node) => [node.id, []]));

  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);

    if (!source || !target || edge.relationType !== 'shared_stock') {
      continue;
    }

    relatedMap.get(source.id).push({
      id: target.id,
      label: target.label,
      type: target.type,
      sharedStockCount: Number(edge.sharedStockCount) || 0,
      sharedStocksPreview: edge.sharedStocksPreview || []
    });
    relatedMap.get(target.id).push({
      id: source.id,
      label: source.label,
      type: source.type,
      sharedStockCount: Number(edge.sharedStockCount) || 0,
      sharedStocksPreview: edge.sharedStocksPreview || []
    });
  }

  return nodes.map((node) => ({
    ...node,
    relatedThemesPreview: (relatedMap.get(node.id) || [])
      .sort((left, right) => (Number(right.sharedStockCount) || 0) - (Number(left.sharedStockCount) || 0))
      .slice(0, 20)
  }));
}

function buildThemeAggregateIndex(seed, graphOptions, inputOptions = {}) {
  const filterStats = createGraphFilterStats();
  const items = getRelationReadyItems(seed, inputOptions);
  const stockEntries = createStockEntries(items, filterStats);

  applySharedWeights(stockEntries);

  const aggregateMap = collectThemeAggregates(stockEntries, graphOptions, filterStats);
  const finalized = finalizeThemeAggregates(aggregateMap, graphOptions, filterStats);

  return {
    filterStats,
    items,
    stockEntries,
    ...finalized
  };
}

function buildThemeGraphStats(seed, nodes, edges, sourceItems, graphOptions, filterStats, overrides = {}) {
  const stats = buildGraphStats(seed, nodes, edges, sourceItems, graphOptions, filterStats);
  const byType = nodes.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});
  const aggregateThemeNodeCount = (byType.theme || 0) + (byType.industry || 0) + (byType.concept || 0);

  return {
    ...stats,
    themeNodeCount: byType.theme || 0,
    industryNodeCount: byType.industry || 0,
    conceptNodeCount: byType.concept || 0,
    currentThemeNodeCount: aggregateThemeNodeCount,
    sharedThemeEdgeCount: edges.filter((edge) => edge.relationType === 'shared_stock').length,
    currentGraphNodeCount: nodes.length,
    currentGraphEdgeCount: edges.length,
    ...overrides
  };
}

function buildThemeOverviewGraph(seed, options = {}) {
  const normalizedSeed = normalizeSeed(seed);
  const graphOptions = normalizeGraphOptions({
    ...options,
    viewPreset: 'themeOverview'
  });
  const index = buildThemeAggregateIndex(normalizedSeed, graphOptions, options);
  const selectedAggregates = index.eligibleAggregates.slice(0, graphOptions.maxThemeOverviewNodes);
  const selectedIds = new Set(selectedAggregates.map((aggregate) => aggregate.id));
  let edges = buildSharedThemeEdges(selectedAggregates, graphOptions);

  if (edges.length > graphOptions.maxThemeOverviewEdges) {
    index.filterStats.globalTrimmedRelationCount += edges.length - graphOptions.maxThemeOverviewEdges;
    edges = edges.slice(0, graphOptions.maxThemeOverviewEdges);
  }

  let degreeMap = new Map();

  for (const edge of edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
  }

  const keptAggregates = selectedAggregates.filter((aggregate) => (
    (degreeMap.get(aggregate.id) || 0) > 0 || isStrongStandaloneThemeAggregate(aggregate, graphOptions)
  ));
  const keptIds = new Set(keptAggregates.map((aggregate) => aggregate.id));

  if (keptAggregates.length !== selectedAggregates.length) {
    selectedIds.forEach((nodeId) => {
      if (!keptIds.has(nodeId)) {
        const aggregate = selectedAggregates.find((item) => item.id === nodeId);
        index.filterStats.hiddenWeakRelationCount += aggregate ? Number(aggregate.relationCount) || 0 : 0;
      }
    });
    edges = edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target));
    degreeMap = new Map();
    for (const edge of edges) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
      degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
    }
  }

  const nodes = attachRelatedThemePreviews(
    keptAggregates.map((aggregate) => toThemeGraphNode(aggregate, degreeMap.get(aggregate.id) || 0, false)),
    edges
  );
  const stats = buildThemeGraphStats(normalizedSeed, nodes, edges, index.items, graphOptions, index.filterStats, {
    hiddenStockCount: Math.max(0, index.items.length - nodes.filter((node) => node.type === 'stock').length)
  });

  return {
    nodes,
    edges,
    stats
  };
}

function buildThemeFocusGraph(seed, options = {}) {
  const normalizedSeed = normalizeSeed(seed);
  const graphOptions = normalizeGraphOptions({
    ...options,
    viewPreset: 'themeFocus'
  });
  const index = buildThemeAggregateIndex(normalizedSeed, graphOptions, options);
  const focusThemeId = graphOptions.focusThemeId;
  const focusAggregate = index.eligibleAggregates.find((aggregate) => aggregate.id === focusThemeId) ||
    index.eligibleAggregates[0] ||
    null;

  if (!focusAggregate) {
    const stats = buildThemeGraphStats(normalizedSeed, [], [], index.items, graphOptions, index.filterStats);
    return { nodes: [], edges: [], stats };
  }

  const relatedEdges = buildSharedThemeEdges(index.eligibleAggregates, graphOptions, focusAggregate.id)
    .slice(0, graphOptions.maxThemeFocusRelatedThemes);
  const relatedIds = new Set();

  relatedEdges.forEach((edge) => {
    relatedIds.add(edge.source === focusAggregate.id ? edge.target : edge.source);
  });

  const relatedAggregates = index.eligibleAggregates.filter((aggregate) => relatedIds.has(aggregate.id));
  const focusMembers = getThemeAggregateMembers(focusAggregate, true);
  const displayedStocks = focusMembers.slice(0, graphOptions.maxThemeFocusStocks);
  const stockNodes = displayedStocks.map((stock) => ({
    id: `stock:${normalizeCode(stock.code)}`,
    type: 'stock',
    label: stock.name || stock.code,
    code: normalizeCode(stock.code),
    market: stock.market || '',
    degree: 1,
    labelPriority: 1000,
    importantLabel: true
  }));
  const stockEdges = stockNodes.map((stockNode) => ({
    id: `${stockNode.id}->${focusAggregate.id}:theme_member`,
    source: stockNode.id,
    target: focusAggregate.id,
    type: 'theme_member',
    relationType: 'theme_member',
    relationClass: 'theme',
    weight: 1,
    rankScore: 1
  }));
  const remainingEdgeBudget = Math.max(0, graphOptions.maxThemeFocusEdges - stockEdges.length);
  const themeEdges = relatedEdges.slice(0, remainingEdgeBudget);
  const degreeMap = new Map();

  [...stockEdges, ...themeEdges].forEach((edge) => {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
  });

  const themeNodes = [focusAggregate, ...relatedAggregates].map((aggregate) => (
    toThemeGraphNode(aggregate, degreeMap.get(aggregate.id) || 0, aggregate.id === focusAggregate.id)
  ));
  const nodes = attachRelatedThemePreviews([...themeNodes, ...stockNodes], themeEdges);
  const edges = [...stockEdges, ...themeEdges];
  const stats = buildThemeGraphStats(normalizedSeed, nodes, edges, index.items, graphOptions, index.filterStats, {
    hiddenStockCount: Math.max(0, focusMembers.length - displayedStocks.length),
    focusedThemeId: focusAggregate.id,
    focusedThemeLabel: focusAggregate.label,
    focusedThemeMemberStockCount: focusMembers.length
  });

  return {
    nodes,
    edges,
    stats
  };
}

function getDoneItems(seed, options = {}) {
  let items = Object.values(seed.items || {})
    .filter((item) => item && item.status === 'DONE' && normalizeCode(item.code));

  const codes = Array.isArray(options.codes)
    ? new Set(options.codes.map(normalizeCode).filter(Boolean))
    : null;

  if (codes && codes.size > 0) {
    items = items.filter((item) => codes.has(normalizeCode(item.code)));
  }

  const searchText = String(options.search || '').trim().toLowerCase();

  if (searchText) {
    items = items.filter((item) => {
      const code = normalizeCode(item.code);
      const name = String(item.name || '').toLowerCase();
      return code.includes(searchText) || name.includes(searchText);
    });
  }

  const limit = getLimit(options.limit);

  if (limit > 0) {
    items = items.slice(0, limit);
  }

  return items;
}

const STOCK_FOCUS_RELATION_MEMBER_LIMIT = 300;
const STOCK_FOCUS_RELATION_MEMBER_PREVIEW_LIMIT = 50;
const STOCK_FOCUS_RELATED_STOCK_TOTAL_LIMIT = 42;
const STOCK_FOCUS_RELATED_STOCKS_PER_RELATION = 8;

function collectStockFocusRelationMembers(seed, focusCode, targetNodeIds) {
  const normalizedFocusCode = normalizeCode(focusCode);
  const membersByNodeId = new Map();

  if (!normalizedFocusCode || !targetNodeIds || !targetNodeIds.size) {
    return membersByNodeId;
  }

  const filterStats = createGraphFilterStats();
  const allItems = getRelationReadyItems(seed, {});
  const allEntries = createStockEntries(allItems, filterStats);

  applySharedWeights(allEntries);

  for (const entry of allEntries) {
    if (!entry || !entry.stockNode || !entry.stockNode.code) {
      continue;
    }

    const seenNodeIds = new Set();

    for (const candidate of entry.allCandidates || []) {
      if (!candidate || !candidate.node || !targetNodeIds.has(candidate.node.id)) {
        continue;
      }

      if (candidate.isNoise || candidate.noiseCategory) {
        continue;
      }

      const nodeId = candidate.node.id;

      if (seenNodeIds.has(nodeId)) {
        continue;
      }

      seenNodeIds.add(nodeId);

      if (!membersByNodeId.has(nodeId)) {
        membersByNodeId.set(nodeId, new Map());
      }

      const memberMap = membersByNodeId.get(nodeId);
      const relationScore = getCandidateNodeWeight(candidate);
      const existing = memberMap.get(entry.stockNode.code);

      if (!existing || relationScore > Number(existing.relationScore || 0)) {
        memberMap.set(entry.stockNode.code, {
          code: entry.stockNode.code,
          name: entry.stockNode.label || entry.stockNode.code,
          market: entry.stockNode.market || '',
          relationScore,
          relationLabel: candidate.label || (candidate.node && candidate.node.label) || '',
          relationType: candidate.relationClass || (candidate.node && candidate.node.type) || ''
        });
      }
    }
  }

  const normalizedMembersByNodeId = new Map();

  membersByNodeId.forEach((memberMap, nodeId) => {
    const members = Array.from(memberMap.values()).sort((left, right) => {
      const focusDiff = (left.code === normalizedFocusCode ? 1 : 0) - (right.code === normalizedFocusCode ? 1 : 0);

      if (focusDiff !== 0) {
        return focusDiff;
      }

      const scoreDiff = Number(right.relationScore || 0) - Number(left.relationScore || 0);

      if (Math.abs(scoreDiff) > 0.0001) {
        return scoreDiff;
      }

      return String(left.code || '').localeCompare(String(right.code || ''));
    });

    normalizedMembersByNodeId.set(nodeId, members);
  });

  return normalizedMembersByNodeId;
}

function makeStockFocusPeerStockNode(member) {
  const code = normalizeCode(member && member.code);
  const market = member && member.market ? String(member.market) : (String(code).startsWith('HK:') ? 'HK' : '');
  const rawName = String(member && member.name || code || '').trim();
  const label = market === 'HK' && rawName && !rawName.includes('（HK）')
    ? `${rawName}（HK）`
    : rawName;

  return {
    id: `stock:${code}`,
    type: 'stock',
    label,
    code,
    symbol: code,
    market,
    exchange: market === 'HK' ? 'HKEX' : '',
    currency: market === 'HK' ? 'HKD' : '',
    relationPeer: true,
    labelPriority: 60
  };
}

function isStOrRiskStockName(name) {
  const text = String(name || '').toUpperCase();

  return text.includes('*ST') || text.includes('ST') || text.includes('退');
}

function getStockFocusPeerScore(member, focusCode) {
  const code = normalizeCode(member && member.code);
  const market = member && member.market ? String(member.market) : (String(code).startsWith('HK:') ? 'HK' : '');
  const source = String(member && member.source || member && member.dataSource || '').toLowerCase();
  const name = String(member && member.name || '');
  let score = Number(member && member.relationScore || 0);

  if (code === focusCode) {
    return -999;
  }

  if (isStOrRiskStockName(name)) {
    score -= 100;
  }

  if (source.includes('manual_cross_market_seed') || source.includes('cross_market')) {
    score += 100;
  }

  if (market === 'HK') {
    score += 50;
  }

  if (/^HK:\d{5}$/.test(code)) {
    score += 40;
  }

  if (/^\d{6}$/.test(code)) {
    score += 5;
  }

  return score;
}

function shouldKeepStockFocusPeer(member, focusCode, focusMarket, relationNode) {
  const code = normalizeCode(member && member.code);
  const market = member && member.market ? String(member.market) : (String(code).startsWith('HK:') ? 'HK' : '');
  const source = String(member && member.source || member && member.dataSource || '').toLowerCase();
  const name = String(member && member.name || '');
  const relationLabel = String(relationNode && relationNode.label || '');

  if (!code || code === focusCode) {
    return false;
  }

  if (isStOrRiskStockName(name)) {
    return false;
  }

  if (focusMarket === 'HK') {
    return market === 'HK'
      || relationLabel.startsWith('A+H映射：')
      || source.includes('manual_cross_market_seed')
      || source.includes('cross_market');
  }

  return true;
}

function addStockFocusRelatedStockNodes(nodeMap, edgeMap, seed, graphOptions) {
  if (!isStockFocusViewPreset(graphOptions && graphOptions.viewPreset) || !graphOptions.focusCode) {
    return;
  }

  const focusCode = normalizeCode(graphOptions.focusCode);
  const focusMarket = String(focusCode).startsWith('HK:') ? 'HK' : 'CN_A';
  const relationNodes = Array.from(nodeMap.values())
    .filter((node) => node && node.id && node.type !== 'stock');

  if (!focusCode || relationNodes.length === 0) {
    return;
  }

  const relationNodeIds = new Set(relationNodes.map((node) => node.id));
  const membersByNodeId = collectStockFocusRelationMembers(seed, focusCode, relationNodeIds);

  if (!membersByNodeId.size) {
    return;
  }

  let addedTotal = 0;
  const addedStockCodes = new Set();

  for (const relationNode of relationNodes) {
    if (addedTotal >= STOCK_FOCUS_RELATED_STOCK_TOTAL_LIMIT) {
      break;
    }

    const members = (membersByNodeId.get(relationNode.id) || [])
      .filter((member) => shouldKeepStockFocusPeer(member, focusCode, focusMarket, relationNode))
      .sort((left, right) => {
        const scoreDiff = getStockFocusPeerScore(right, focusCode) - getStockFocusPeerScore(left, focusCode);

        if (Math.abs(scoreDiff) > 0.0001) {
          return scoreDiff;
        }

        return String(left.code || '').localeCompare(String(right.code || ''));
      })
      .slice(0, STOCK_FOCUS_RELATED_STOCKS_PER_RELATION);

    for (const member of members) {
      if (addedTotal >= STOCK_FOCUS_RELATED_STOCK_TOTAL_LIMIT) {
        break;
      }

      const memberCode = normalizeCode(member && member.code);

      if (!memberCode || memberCode === focusCode) {
        continue;
      }

      const stockNodeId = `stock:${memberCode}`;

      if (!nodeMap.has(stockNodeId)) {
        upsertNode(nodeMap, makeStockFocusPeerStockNode({
          ...member,
          code: memberCode
        }));
      }

      const edgeId = `${relationNode.id}->${stockNodeId}:relation_member_stock`;

      if (!edgeMap.has(edgeId)) {
        edgeMap.set(edgeId, {
          id: edgeId,
          source: relationNode.id,
          target: stockNodeId,
          relationType: 'relation_member_stock',
          relationClass: 'stock_peer',
          dataSource: 'relation_seed_member',
          relationSource: 'relation_seed_member',
          reason: `同属${relationNode.label || '关系节点'}`,
          weight: 0.52,
          rankScore: 0.52,
          focusCode,
          peerCode: memberCode
        });
      }

      if (!addedStockCodes.has(memberCode)) {
        addedStockCodes.add(memberCode);
        addedTotal += 1;
      }
    }
  }
}

function getStockFocusAhMappingNames(item) {
  const plates = Array.isArray(item && item.plateEast) ? item.plateEast : [];

  return Array.from(new Set(
    plates
      .map((plate) => String(plate && plate.plate_name || '').trim())
      .filter((name) => name.startsWith('A+H映射：'))
  ));
}

function itemHasAhMappingName(item, mappingName) {
  const plates = Array.isArray(item && item.plateEast) ? item.plateEast : [];

  return plates.some((plate) => String(plate && plate.plate_name || '').trim() === mappingName);
}

function findNodeIdByLabel(nodeMap, label) {
  for (const node of nodeMap.values()) {
    if (String(node && node.label || '') === label) {
      return node.id;
    }
  }

  return '';
}

function hasEdgeBetween(edgeMap, source, target) {
  for (const edge of edgeMap.values()) {
    if (edge && edge.source === source && edge.target === target) {
      return true;
    }
  }

  return false;
}

function makeForcedAhRelationNode(mappingName) {
  return {
    id: `relation:forced_ah:${encodeURIComponent(mappingName)}`,
    type: 'concept',
    label: mappingName,
    relationCategory: 'ah_mapping',
    relationSource: 'manual_cross_market_seed',
    dataSource: 'manual_cross_market_seed',
    labelPriority: 96,
    importantLabel: true,
    forcedRelation: true
  };
}

function addStockFocusForcedAhMappingNodes(nodeMap, edgeMap, seed, graphOptions) {
  if (!isStockFocusViewPreset(graphOptions && graphOptions.viewPreset) || !graphOptions.focusCode) {
    return;
  }

  const focusCode = normalizeCode(graphOptions.focusCode);
  const focusItem = seed && seed.items ? seed.items[focusCode] : null;
  const focusStockNodeId = `stock:${focusCode}`;
  const mappingNames = getStockFocusAhMappingNames(focusItem);

  if (!focusCode || !focusItem || mappingNames.length === 0 || !nodeMap.has(focusStockNodeId)) {
    return;
  }

  const seedItems = Object.values(seed.items || {});

  for (const mappingName of mappingNames) {
    let relationNodeId = findNodeIdByLabel(nodeMap, mappingName);

    if (!relationNodeId) {
      const relationNode = makeForcedAhRelationNode(mappingName);
      relationNodeId = relationNode.id;
      upsertNode(nodeMap, relationNode);
    }

    if (!hasEdgeBetween(edgeMap, focusStockNodeId, relationNodeId)) {
      const edgeId = `${focusStockNodeId}->${relationNodeId}:forced_ah_mapping`;

      edgeMap.set(edgeId, {
        id: edgeId,
        source: focusStockNodeId,
        target: relationNodeId,
        relationType: 'forced_ah_mapping',
        relationClass: 'company_mapping',
        dataSource: 'manual_cross_market_seed',
        relationSource: 'manual_cross_market_seed',
        reason: mappingName,
        weight: 0.96,
        rankScore: 0.96,
        focusCode
      });
    }

    const peers = seedItems
      .filter((item) => {
        const code = normalizeCode(item && item.code);

        return code && code !== focusCode && itemHasAhMappingName(item, mappingName);
      })
      .sort((left, right) => {
        const leftCode = normalizeCode(left && left.code);
        const rightCode = normalizeCode(right && right.code);
        const leftIsA = /^\d{6}$/.test(leftCode) ? 1 : 0;
        const rightIsA = /^\d{6}$/.test(rightCode) ? 1 : 0;

        if (leftIsA !== rightIsA) {
          return rightIsA - leftIsA;
        }

        return leftCode.localeCompare(rightCode);
      });

    for (const peer of peers) {
      const peerCode = normalizeCode(peer && peer.code);

      if (!peerCode || peerCode === focusCode) {
        continue;
      }

      const peerStockNodeId = `stock:${peerCode}`;

      if (!nodeMap.has(peerStockNodeId)) {
        upsertNode(nodeMap, makeStockFocusPeerStockNode({
          ...peer,
          code: peerCode
        }));
      }

      if (!hasEdgeBetween(edgeMap, relationNodeId, peerStockNodeId)) {
        const peerEdgeId = `${relationNodeId}->${peerStockNodeId}:forced_ah_mapping_peer`;

        edgeMap.set(peerEdgeId, {
          id: peerEdgeId,
          source: relationNodeId,
          target: peerStockNodeId,
          relationType: 'forced_ah_mapping_peer',
          relationClass: 'company_mapping',
          dataSource: 'manual_cross_market_seed',
          relationSource: 'manual_cross_market_seed',
          reason: mappingName,
          weight: 0.96,
          rankScore: 0.96,
          focusCode,
          peerCode
        });
      }
    }
  }
}

function enrichStockFocusRelationMembers(nodes, seed, graphOptions) {
  if (!isStockFocusViewPreset(graphOptions && graphOptions.viewPreset) || !graphOptions.focusCode) {
    return nodes;
  }

  const relationNodeIds = new Set(
    (nodes || [])
      .filter((node) => node && node.id && node.type !== 'stock')
      .map((node) => node.id)
  );

  if (!relationNodeIds.size) {
    return nodes;
  }

  const membersByNodeId = collectStockFocusRelationMembers(seed, graphOptions.focusCode, relationNodeIds);

  if (!membersByNodeId.size) {
    return nodes;
  }

  return nodes.map((node) => {
    if (!node || node.type === 'stock' || !membersByNodeId.has(node.id)) {
      return node;
    }

    const members = membersByNodeId.get(node.id) || [];

    return {
      ...node,
      memberStockCount: Math.max(Number(node.memberStockCount || 0), members.length),
      memberStocksPreview: members.slice(0, STOCK_FOCUS_RELATION_MEMBER_PREVIEW_LIMIT),
      memberStocks: members.slice(0, STOCK_FOCUS_RELATION_MEMBER_LIMIT)
    };
  });
}

function buildMarketGraph(seed, options = {}) {
  const normalizedSeed = normalizeSeed(seed);
  const graphOptions = normalizeGraphOptions(options);

  if (graphOptions.viewPreset === 'themeOverview') {
    return buildThemeOverviewGraph(normalizedSeed, {
      ...options,
      ...graphOptions
    });
  }

  if (graphOptions.viewPreset === 'themeFocus') {
    return buildThemeFocusGraph(normalizedSeed, {
      ...options,
      ...graphOptions
    });
  }

  const items = getDoneItems(normalizedSeed, {
    ...options,
    codes: isStockFocusViewPreset(graphOptions.viewPreset) && graphOptions.focusCode
      ? [graphOptions.focusCode]
      : options.codes
  });
  const nodeMap = new Map();
  const edgeMap = new Map();
  const memberMap = new Map();
  const filterStats = createGraphFilterStats();
  const stockEntries = createStockEntries(items, filterStats);

  if (isStockFocusViewPreset(graphOptions.viewPreset) && !graphOptions.focusCode && stockEntries[0]) {
    graphOptions.focusCode = stockEntries[0].stockNode.code;
  }

  applySharedWeights(stockEntries);

  const resonanceState = graphOptions.viewPreset === 'resonance'
    ? createResonanceState(stockEntries, filterStats)
    : null;

  if (resonanceState) {
    graphOptions.resonanceFallback = resonanceState.fallback;
  }

  let selectedByStock = new Map();
  stockEntries.forEach((entry) => {
    selectedByStock.set(entry.stockNode.code, selectEntryCandidates(entry, graphOptions, filterStats, resonanceState));
  });
  selectedByStock = trimCandidatesByGraphBudget(stockEntries, selectedByStock, graphOptions, filterStats);

  if (
    resonanceState &&
    filterStats.rawRelationCount > 0 &&
    getSelectedCandidateCount(selectedByStock) === 0
  ) {
    resonanceState.fallback = true;
    graphOptions.resonanceFallback = true;
    filterStats.resonanceFallback = true;

    selectedByStock = new Map();
    stockEntries.forEach((entry) => {
      selectedByStock.set(entry.stockNode.code, selectEntryCandidates(entry, graphOptions, filterStats, resonanceState));
    });
    selectedByStock = trimCandidatesByGraphBudget(stockEntries, selectedByStock, graphOptions, filterStats);
  }

  if (resonanceState) {
    updateResonanceStatsFromSelection(stockEntries, selectedByStock, filterStats, resonanceState);
  }

  const renderedStockCodes = new Set();

  if (graphOptions.viewPreset === 'resonance') {
    selectedByStock.forEach((candidates, stockCode) => {
      if (candidates.length > 0) {
        renderedStockCodes.add(stockCode);
      }
    });
  } else {
    stockEntries.forEach((entry) => {
      if (!isStockFocusViewPreset(graphOptions.viewPreset) || entry.stockNode.code === graphOptions.focusCode) {
        renderedStockCodes.add(entry.stockNode.code);
      }
    });
  }

  for (const entry of stockEntries) {
    if (!renderedStockCodes.has(entry.stockNode.code)) {
      continue;
    }

    const displayCandidates = selectedByStock.get(entry.stockNode.code) || [];

    upsertNode(nodeMap, {
      ...entry.stockNode,
      relationSummary: summarizeStockRelations(entry.allCandidates, displayCandidates, displayCandidates, graphOptions)
    });

    for (const candidate of displayCandidates) {
      upsertNode(nodeMap, candidate.node);
      addEdge(edgeMap, candidate.edge, memberMap, entry.stockNode);
    }
  }

  addStockFocusRelatedStockNodes(nodeMap, edgeMap, normalizedSeed, graphOptions);
  addStockFocusForcedAhMappingNodes(nodeMap, edgeMap, normalizedSeed, graphOptions);

  const degreeMap = new Map();

  for (const edge of edgeMap.values()) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
  }

  let nodes = Array.from(nodeMap.values()).map((node) => {
    const members = memberMap.has(node.id)
      ? Array.from(memberMap.get(node.id).values())
      : [];
    const degree = degreeMap.get(node.id) || 0;

    return {
      ...node,
      degree,
      labelPriority: getNodeLabelPriority(node, degree),
      importantLabel: isImportantNodeLabel(node, degree),
      memberStockCount: members.length,
      memberStocks: members.slice(0, 30)
    };
  });

  nodes = enrichStockFocusRelationMembers(nodes, normalizedSeed, graphOptions);

  const edges = Array.from(edgeMap.values());
  const stats = buildGraphStats(normalizedSeed, nodes, edges, items, graphOptions, filterStats);

  return {
    nodes,
    edges,
    stats
  };
}

function buildGraphStats(seed, nodes, edges, sourceItems, graphOptions, filterStats) {
  const byType = nodes.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});
  const boardCount = (byType.region_board || 0) + (byType.style_board || 0) + (byType.other_board || 0);
  const latestItemAt = sourceItems
    .map((item) => item && item.updatedAt ? String(item.updatedAt) : '')
    .filter(Boolean)
    .sort()
    .pop();

  return {
    totalStocks: Number(seed.total) || 0,
    done: Number(seed.done) || 0,
    failed: Number(seed.failed) || 0,
    stockCount: byType.stock || 0,
    themeNodeCount: byType.theme || 0,
    currentThemeNodeCount: (byType.theme || 0) + (byType.industry || 0) + (byType.concept || 0),
    conceptCount: byType.concept || 0,
    conceptNodeCount: byType.concept || 0,
    industryCount: byType.industry || 0,
    industryNodeCount: byType.industry || 0,
    regionBoardCount: byType.region_board || 0,
    styleBoardCount: byType.style_board || 0,
    otherBoardCount: byType.other_board || 0,
    boardCount,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    currentGraphNodeCount: nodes.length,
    currentGraphEdgeCount: edges.length,
    hiddenStockCount: Math.max(0, (Number(seed.done) || 0) - (byType.stock || 0)),
    sharedThemeEdgeCount: edges.filter((edge) => edge.relationType === 'shared_stock').length,
    rawRelationCount: filterStats.rawRelationCount,
    resonanceCandidateCount: filterStats.resonanceCandidateCount,
    resonanceKeptRelationCount: filterStats.resonanceKeptRelationCount,
    resonanceKeptStockCount: filterStats.resonanceKeptStockCount,
    resonanceDroppedIsolatedStockCount: filterStats.resonanceDroppedIsolatedStockCount,
    resonanceFallback: filterStats.resonanceFallback,
    hiddenNoiseRelationCount: filterStats.hiddenNoiseRelationCount,
    hiddenWeakRelationCount: filterStats.hiddenWeakRelationCount,
    hiddenBoardRelationCount: filterStats.hiddenBoardRelationCount,
    hiddenStyleRegionRelationCount: filterStats.hiddenStyleRegionRelationCount,
    foldedIndustryRelationCount: filterStats.foldedIndustryRelationCount,
    globalTrimmedRelationCount: filterStats.globalTrimmedRelationCount,
    hiddenByLimitRelationCount: filterStats.hiddenByLimitRelationCount,
    hiddenByViewModeRelationCount: filterStats.hiddenByViewModeRelationCount,
    hiddenByWeightRelationCount: filterStats.hiddenByWeightRelationCount,
    graphOptions,
    updatedAt: seed.generatedAt || latestItemAt || ''
  };
}

function buildMarketGraphFromSeed(options = {}) {
  return buildMarketGraph(loadRelationSeed(options.seedPath || SEED_PATH), options);
}

function buildRelationSummary(options = {}) {
  const seed = loadRelationSeed(options.seedPath || SEED_PATH);
  const graph = buildMarketGraph(seed);

  return {
    ...graph.stats,
    seedExists: fs.existsSync(options.seedPath || SEED_PATH),
    seedPath: options.seedPath || SEED_PATH,
    generatedAt: seed.generatedAt || '',
    source: seed.source || RELATION_SOURCE
  };
}

function loadRelationRaw(options = {}) {
  const seed = loadRelationSeed(options.seedPath || SEED_PATH);
  const code = normalizeCode(options.code);

  if (code) {
    return {
      code,
      item: seed.items[code] || null,
      exists: Boolean(seed.items[code])
    };
  }

  const limit = getLimit(options.limit) || 20;
  const sampleItems = Object.values(seed.items || {})
    .slice(0, limit)
    .map((item) => ({
      code: item.code || '',
      name: item.name || '',
      market: item.market || '',
      status: item.status || '',
      updatedAt: item.updatedAt || '',
      conceptThsCount: asList(item.conceptThs).length,
      plateEastCount: asList(item.plateEast).length,
      error: item.error || ''
    }));

  return {
    version: seed.version,
    generatedAt: seed.generatedAt,
    source: seed.source,
    total: seed.total,
    done: seed.done,
    failed: seed.failed,
    sampleItems
  };
}

function loadFetchRawStatus() {
  return {
    progress: readJsonIfExists(PROGRESS_PATH, null),
    errors: readJsonIfExists(ERRORS_PATH, null),
    seedExists: fs.existsSync(SEED_PATH),
    progressExists: fs.existsSync(PROGRESS_PATH),
    errorsExists: fs.existsSync(ERRORS_PATH),
    paths: getMarketGraphPaths(),
    checkedAt: nowIso()
  };
}

function getMarketGraphPaths() {
  return {
    marketGraphDir: MARKET_GRAPH_DIR,
    seedPath: SEED_PATH,
    progressPath: PROGRESS_PATH,
    errorsPath: ERRORS_PATH
  };
}

module.exports = {
  buildMarketGraph,
  buildMarketGraphFromSeed,
  buildThemeOverviewGraph,
  buildRelationSummary,
  loadRelationSeed,
  loadRelationRaw,
  loadFetchRawStatus,
  getMarketGraphPaths,
  classifyEastPlate,
  isRegionBoard,
  isStyleBoard,
  isNoiseLabel,
  DEFAULT_GRAPH_OPTIONS,
  NOISE_LABELS,
  REGION_BOARD_KEYWORDS,
  STYLE_BOARD_KEYWORDS
};
