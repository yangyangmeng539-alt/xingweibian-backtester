const MARKET_INDEXES = Object.freeze([
  {
    indexCode: 'SH:000001',
    indexName: '上证指数',
    market: 'CN_INDEX',
    role: '上海主板总温度',
    txSymbol: 'sh000001',
    emSymbol: 'sh000001',
    bsSymbol: 'sh.000001'
  },
  {
    indexCode: 'SZ:399001',
    indexName: '深证成指',
    market: 'CN_INDEX',
    role: '深圳市场总温度',
    txSymbol: 'sz399001',
    emSymbol: 'sz399001',
    bsSymbol: 'sz.399001'
  },
  {
    indexCode: 'SZ:399006',
    indexName: '创业板指',
    market: 'CN_INDEX',
    role: '成长股温度',
    txSymbol: 'sz399006',
    emSymbol: 'sz399006',
    bsSymbol: 'sz.399006'
  },
  {
    indexCode: 'SH:000688',
    indexName: '科创50',
    market: 'CN_INDEX',
    role: '硬科技温度',
    txSymbol: 'sh000688',
    emSymbol: 'sh000688',
    bsSymbol: ''
  },
  {
    indexCode: 'BJ:899050',
    indexName: '北证50',
    market: 'CN_INDEX',
    role: '北交所温度',
    txSymbol: 'bj899050',
    emSymbol: 'bj899050',
    bsSymbol: ''
  },
  {
    indexCode: 'CSI:000300',
    indexName: '沪深300',
    market: 'CN_INDEX',
    role: '核心资产 / 大盘权重',
    txSymbol: 'sh000300',
    emSymbol: 'sh000300',
    bsSymbol: 'sh.000300'
  },
  {
    indexCode: 'CSI:000905',
    indexName: '中证500',
    market: 'CN_INDEX',
    role: '中盘股温度',
    txSymbol: 'sh000905',
    emSymbol: 'sh000905',
    bsSymbol: 'sh.000905'
  },
  {
    indexCode: 'CSI:000852',
    indexName: '中证1000',
    market: 'CN_INDEX',
    role: '小盘股温度',
    txSymbol: 'sh000852',
    emSymbol: 'sh000852',
    bsSymbol: 'sh.000852'
  },
{
  indexCode: 'CSI:932000',
  indexName: '中证2000',
  market: 'CN_INDEX',
  role: '更小市值温度',
  txSymbol: '',
  emSymbol: 'csi932000',
  csindexSymbol: '932000',
  bsSymbol: '',
  minStartDate: '20240101',
  preferSource: 'csindex',
  emChunkDays: 60
},
  {
    indexCode: 'CSI:000985',
    indexName: '中证全指',
    market: 'CN_INDEX',
    role: '全 A 宽基温度',
    txSymbol: 'sh000985',
    emSymbol: 'sh000985',
    bsSymbol: ''
  },
    {
    indexCode: 'HK:HSI',
    indexName: '恒生指数',
    market: 'HK_INDEX',
    role: '港股大盘总温度',
    txSymbol: '',
    emSymbol: '',
    bsSymbol: '',
    hkTxSymbol: 'hkHSI',
    preferSource: 'hk_tencent'
  },
  {
    indexCode: 'HK:HSTECH',
    indexName: '恒生科技',
    market: 'HK_INDEX',
    role: '港股科技 / 新经济温度',
    txSymbol: '',
    emSymbol: '',
    bsSymbol: '',
    hkTxSymbol: 'hkHSTECH',
    preferSource: 'hk_tencent'
  },
  {
    indexCode: 'HK:HSCEI',
    indexName: '恒生国企',
    market: 'HK_INDEX',
    role: '中资港股 / H股温度',
    txSymbol: '',
    emSymbol: '',
    bsSymbol: '',
    hkTxSymbol: 'hkHSCEI',
    preferSource: 'hk_tencent'
  }
]);

function normalizeIndexCode(value) {
  return String(value || '').trim().toUpperCase();
}

function listMarketIndexes(options = {}) {
  const market = String(options.market || '').trim().toUpperCase();
  const codes = Array.isArray(options.codes)
    ? new Set(options.codes.map(normalizeIndexCode).filter(Boolean))
    : null;

  return MARKET_INDEXES.filter((item) => {
    if (market && item.market !== market) return false;
    if (codes && !codes.has(item.indexCode)) return false;
    return true;
  }).map((item) => ({ ...item }));
}

function getMarketIndex(indexCode) {
  const cleanCode = normalizeIndexCode(indexCode);
  return listMarketIndexes().find((item) => item.indexCode === cleanCode) || null;
}

module.exports = {
  MARKET_INDEXES,
  normalizeIndexCode,
  listMarketIndexes,
  getMarketIndex
};