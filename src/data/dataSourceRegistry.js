const DATA_SOURCES = [
  {
    id: 'akshare',
    name: 'AKShare',
    market: 'A_SHARE',
    timeframe: 'daily',
    enabled: true,
    note: '第一版使用 Python Worker 调用 AKShare 拉取 A 股历史日线。'
  }
];

function getDefaultDataSource() {
  return DATA_SOURCES.find((item) => item.enabled);
}

module.exports = {
  DATA_SOURCES,
  getDefaultDataSource
};