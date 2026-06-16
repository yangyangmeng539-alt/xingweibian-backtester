const https = require('https');

const DIRECT_RULE_HINT = [
  'push2his.eastmoney.com',
  'push2.eastmoney.com',
  'quote.eastmoney.com',
  'datacenter-web.eastmoney.com'
];

const HEALTH_CHECK_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116&ut=7eea3edcaed734bea9cbfc24409ed989&klt=101&fqt=1&secid=0.300750&beg=20250101&end=20250131';

function buildHealthResult(ok, status, message) {
  return {
    ok,
    status,
    message,
    directRuleHint: DIRECT_RULE_HINT
  };
}

function compactError(value) {
  const text = String(value || '未知错误').replace(/\s+/g, ' ').trim();

  if (text.length <= 180) {
    return text;
  }

  return `${text.slice(0, 180)}...`;
}

function checkDataSourceHealth() {
  return new Promise((resolve) => {
    const request = https.get(
      HEALTH_CHECK_URL,
      {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            resolve(buildHealthResult(
              false,
              'BLOCKED_BY_PROXY_OR_NETWORK',
              `东方财富历史数据接口返回异常状态：${response.statusCode || '未知'}。`
            ));
            return;
          }

          try {
            const payload = JSON.parse(body);
            const klines = payload && payload.data && payload.data.klines;

            if (Array.isArray(klines)) {
              resolve(buildHealthResult(
                true,
                'OK',
                '东方财富历史数据接口可访问。'
              ));
              return;
            }

            resolve(buildHealthResult(
              false,
              'UNKNOWN',
              '东方财富历史数据接口响应格式异常。'
            ));
          } catch (error) {
            resolve(buildHealthResult(
              false,
              'UNKNOWN',
              `东方财富历史数据接口响应解析失败：${compactError(error.message)}。`
            ));
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });

    request.on('error', (error) => {
      const message = /timeout/i.test(error.message)
        ? '东方财富历史数据接口连接超时。'
        : `东方财富历史数据接口连接失败：${compactError(error.message)}。`;

      resolve(buildHealthResult(
        false,
        'BLOCKED_BY_PROXY_OR_NETWORK',
        message
      ));
    });
  });
}

module.exports = {
  checkDataSourceHealth,
  DIRECT_RULE_HINT
};
