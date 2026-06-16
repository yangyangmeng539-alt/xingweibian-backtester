const path = require('path');
const { spawn } = require('child_process');
const {
  resolvePython,
  buildPythonArgs
} = require('../runtime/pythonResolver');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const BJ_SINA_DAILY_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'bjSinaDailyAdapter.py');
const BAOSTOCK_ASHARE_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'baostockAshareDailyAdapter.py');
// 注意：当前 akshareAdapter.py 实际是港股逻辑，不能再放进 A股默认刷新链路。
const AKSHARE_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'akshareAdapter.py');

const EASTMONEY_DIRECT_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'eastmoneyDirectAdapter.py');
const ALT_DAILY_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'altDailyAdapter.py');
const HK_DAILY_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'hkDailyAdapter.py');
const DATA_FETCH_FAILED_MESSAGE = '历史数据拉取失败：AKShare、东方财富直连和备用历史源均失败，请稍后重试。';
const DEFAULT_ADAPTER_TIMEOUT_MS = 60000;
const HK_ADAPTER_TIMEOUT_MS = 120000;
const PROXY_ENV_OVERRIDES = Object.freeze({
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  NO_PROXY: '*',
  no_proxy: '*'
});

function isPackagedRuntime() {
  if (process.env.XWB_IS_PACKAGED === 'true') {
    return true;
  }

  return /[\\/]resources[\\/]app$/i.test(PROJECT_ROOT);
}

function getPythonResolution() {
  return resolvePython({
    projectRoot: PROJECT_ROOT,
    resourcesPath: process.env.XWB_RESOURCES_PATH || process.resourcesPath || '',
    isPackaged: isPackagedRuntime(),
    env: process.env
  });
}

function normalizeNetworkMode(value) {
  const text = String(value || 'direct').trim().toLowerCase();
  return text || 'direct';
}

function getPythonChildEnv(networkMode = 'direct') {
  return {
    ...process.env,
    ...PROXY_ENV_OVERRIDES,
    XWB_NETWORK_MODE: normalizeNetworkMode(networkMode)
  };
}

function getAdapterTimeoutMs(source) {
  const text = String(source || '').trim();

  if (text === 'hk_daily') {
    return HK_ADAPTER_TIMEOUT_MS;
  }

  return DEFAULT_ADAPTER_TIMEOUT_MS;
}

function compactText(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function createDetailedFetchError(message, details = {}) {
  const error = new Error(message || DATA_FETCH_FAILED_MESSAGE);
  error.errorCode = details.errorCode || '';
  error.unsupportedMarket = Boolean(details.unsupportedMarket);
  error.rawError = details.rawError || '';
  error.akshareError = details.akshareError || '';
  error.eastmoneyError = details.eastmoneyError || '';
  error.altDailyError = details.altDailyError || '';
  error.lastTransportError = details.lastTransportError || '';
  error.adapterSource = details.adapterSource || '';
  error.emptyBars = Boolean(details.emptyBars);
  error.emptySource = details.emptySource || '';
  return error;
}

function getAdapterMeta(adapterPath) {

  if (adapterPath === BAOSTOCK_ASHARE_ADAPTER_PATH) {
    return {
      source: 'baostock_a_share',
      label: 'BaoStock A股'
    };
  }

  if (adapterPath === BJ_SINA_DAILY_ADAPTER_PATH) {
    return {
      source: 'bj_sina_daily',
      label: '北交所新浪日线'
    };
  }

  if (adapterPath === HK_DAILY_ADAPTER_PATH) {
    return {
      source: 'hk_daily',
      label: '港股日线'
    };
  }

  if (adapterPath === ALT_DAILY_ADAPTER_PATH) {
    return {
      source: 'alt_daily',
      label: '备用历史日线'
    };
  }

  if (adapterPath === EASTMONEY_DIRECT_ADAPTER_PATH) {
    return {
      source: 'eastmoney_direct',
      label: '东方财富直连'
    };
  }

  return {
    source: 'akshare',
    label: 'AKShare'
  };
}

function getSourceFamily(source) {
  const text = String(source || '').trim();

  if (text === 'baostock_a_share' || text.startsWith('baostock_a_share:')) {
    return 'baostock_a_share';
  }

  if (text === 'bj_sina_daily' || text.startsWith('bj_sina_daily:')) {
    return 'bj_sina_daily';
  }

  if (
    text === 'hk_daily' ||
    text.startsWith('hk_daily:') ||
    text === 'eastmoney_hk_direct' ||
    text.startsWith('eastmoney_hk_direct:') ||
    text === 'tencent_hk_direct' ||
    text.startsWith('tencent_hk_direct:')
  ) {
    return 'hk_daily';
  }

  if (text === 'eastmoney_direct' || text.startsWith('eastmoney_direct:')) {
    return 'eastmoney_direct';
  }

  if (text === 'akshare' || text.startsWith('akshare:')) {
    return 'akshare';
  }

  if (
    text === 'alt_daily' ||
    text.startsWith('alt_daily:') ||
    text === 'tencent_fqkline' ||
    text.startsWith('tencent_fqkline:')
  ) {
    return 'alt_daily';
  }

  return text || 'unknown';
}

function isEmptyBarsMessage(value) {
  return /返回空日线|empty bars|empty daily bars/i.test(String(value || ''));
}

function isBjMarketSymbol(symbol) {
  const text = String(symbol || '').trim();
  return text.startsWith('8') || text.startsWith('4') || text.startsWith('920');
}

function getAdapterConfigs(options = {}) {
  const symbol = String(options.symbol || '').trim();

  if (isBjMarketSymbol(symbol)) {
    return [
      {
        path: BJ_SINA_DAILY_ADAPTER_PATH,
        source: 'bj_sina_daily',
        label: '北交所新浪日线',
        errorKey: 'akshareError'
      }
    ];
  }

  return [
    {
      path: BAOSTOCK_ASHARE_ADAPTER_PATH,
      source: 'baostock_a_share',
      label: 'BaoStock A股',
      errorKey: 'akshareError'
    }
  ];
}

function buildAdapterRunOrder(preferredSource, options = {}) {
  const configs = getAdapterConfigs(options);
  const preferredFamily = getSourceFamily(preferredSource);
  const preferred = configs.find((config) => config.source === preferredFamily);

  if (!preferred) {
    return configs;
  }

  return [
    preferred,
    ...configs.filter((config) => config.source !== preferred.source)
  ];
}

function normalizeAdapterErrorMessage(errorText, adapterLabel) {
  const text = String(errorText || '');
  const label = adapterLabel || '历史数据';

  if (text.includes('东方财富直连失败：')) {
    return `${label} 数据拉取失败：${compactText(text, 360)}`;
  }

  if (text.includes('UNSUPPORTED_MARKET')) {
    return `${label} UNSUPPORTED_MARKET：${compactText(text, 260)}`;
  }

  if (/timeout|timed out|超时/i.test(text)) {
    return `${label} 数据拉取超时，请稍后重试。`;
  }

  const message = compactText(text.replace(/Traceback[\s\S]*/i, ''), 180);
  return `${label} 数据拉取失败：${message || '未知错误'}`;
}

function normalizeAkshareErrorMessage(errorText) {
  return normalizeAdapterErrorMessage(errorText, 'AKShare');
}

function parseWorkerJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`Python Worker 没有返回 JSON：${text.slice(0, 300)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function getTransportErrorEntries(transportErrors) {
  if (!transportErrors || typeof transportErrors !== 'object') {
    return [];
  }

  return Object.entries(transportErrors)
    .flatMap(([name, detail]) => {
      if (!detail || typeof detail !== 'object') {
        return [{ name, detail }];
      }

      if (
        Object.prototype.hasOwnProperty.call(detail, 'error') ||
        Object.prototype.hasOwnProperty.call(detail, 'traceback') ||
        Object.prototype.hasOwnProperty.call(detail, 'url')
      ) {
        return [{ name, detail }];
      }

      return Object.entries(detail).map(([nestedName, nestedDetail]) => ({
        host: name,
        name: nestedName,
        detail: nestedDetail
      }));
    });
}

function stringifyTransportErrors(transportErrors) {
  return getTransportErrorEntries(transportErrors)
    .map((entry) => {
      const detail = entry.detail;
      const prefix = entry.host ? `${entry.host} ${entry.name}` : entry.name;

      if (detail && typeof detail === 'object') {
        return `${prefix}: ${detail.error || JSON.stringify(detail)}`;
      }

      return `${prefix}: ${String(detail || '')}`;
    })
    .filter(Boolean)
    .join('\n');
}

function getPayloadLastTransportError(payload, fallback) {
  const entries = getTransportErrorEntries(payload && payload.transportErrors);

  if (entries.length === 0) {
    return fallback || '';
  }

  const names = ['curl_cffi_https', 'urllib_http', 'urllib_https'];

  for (const name of names) {
    const entry = [...entries].reverse().find((item) => item.name === name);

    if (!entry) {
      continue;
    }

    const detail = entry.detail;

    if (detail && typeof detail === 'object' && detail.error) {
      return detail.error;
    }

    if (detail) {
      return String(detail);
    }
  }

  return fallback || '';
}

function buildAdapterErrorDetails(adapterMeta, rawError, lastTransportError, payload = {}) {
  const emptyBars = isEmptyBarsMessage(rawError);
  const errorCode = String(payload.errorCode || '').trim();
  const unsupportedMarket = errorCode === 'UNSUPPORTED_MARKET' || String(rawError || '').includes('UNSUPPORTED_MARKET');
  const details = {
    errorCode,
    unsupportedMarket,
    rawError,
    lastTransportError,
    adapterSource: adapterMeta.source,
    emptyBars,
    emptySource: emptyBars ? adapterMeta.source : ''
  };

  if (adapterMeta.source === 'akshare' || adapterMeta.source === 'baostock_a_share' || adapterMeta.source === 'bj_sina_daily') {
    details.akshareError = rawError;
  }

  if (adapterMeta.source === 'eastmoney_direct') {
    details.eastmoneyError = rawError;
  }

  if (adapterMeta.source === 'alt_daily') {
    details.altDailyError = rawError;
  }

  return details;
}

function attachSourceToBars(bars, source) {
  const list = Array.isArray(bars) ? bars : [];
  Object.defineProperty(list, 'source', {
    configurable: true,
    enumerable: false,
    value: source || 'unknown'
  });
  return list;
}

function runPythonAdapter(adapterPath, options) {
  const symbol = String(options.symbol || '').trim();
  const startDate = String(options.startDate || '').trim();
  const endDate = String(options.endDate || '').trim();
  const adjust = String(options.adjust || 'qfq').trim();
  const networkMode = normalizeNetworkMode(options.networkMode || 'direct');
  const adapterMeta = getAdapterMeta(adapterPath);

  return new Promise((resolve, reject) => {
    const pythonResolution = getPythonResolution();
    const childEnv = getPythonChildEnv(networkMode);
    const adapterArgs = [adapterPath, symbol, startDate, endDate, adjust];

    const child = spawn(
      pythonResolution.command,
      buildPythonArgs(pythonResolution, adapterArgs),
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: childEnv
      }
    );

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;
      child.kill('SIGKILL');
      reject(createDetailedFetchError(`${adapterMeta.label} 数据拉取超时，请稍后重试。`, {
        rawError: `${adapterMeta.label} timeout: ${symbol} ${startDate}-${endDate}`,
        lastTransportError: `${adapterMeta.label} 数据拉取超时，请稍后重试。`,
        akshareError: (adapterMeta.source === 'akshare' || adapterMeta.source === 'baostock_a_share' || adapterMeta.source === 'bj_sina_daily') ? `${adapterMeta.label} 数据拉取超时，请稍后重试。` : '',
        eastmoneyError: adapterMeta.source === 'eastmoney_direct' ? `${adapterMeta.label} 数据拉取超时，请稍后重试。` : '',
        altDailyError: adapterMeta.source === 'alt_daily' ? `${adapterMeta.label} 数据拉取超时，请稍后重试。` : '',
        adapterSource: adapterMeta.source
      }));
    }, getAdapterTimeoutMs(adapterMeta.source));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      reject(createDetailedFetchError(`无法启动 Python：${error.message}`, {
        rawError: [
          `pythonSource=${pythonResolution.source}`,
          `python=${pythonResolution.displayPath || pythonResolution.command}`,
          error && error.stack ? error.stack : error.message
        ].filter(Boolean).join('\n'),
        lastTransportError: `无法启动 Python：${error.message}`,
        akshareError: ['akshare', 'baostock_a_share', 'bj_sina_daily'].includes(adapterMeta.source)
          ? `无法启动 Python：${error.message}`
          : '',
        eastmoneyError: adapterMeta.source === 'eastmoney_direct' ? `无法启动 Python：${error.message}` : '',
        altDailyError: adapterMeta.source === 'alt_daily' ? `无法启动 Python：${error.message}` : '',
        adapterSource: adapterMeta.source
      }));
    });

    child.on('close', () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      try {
        const payload = parseWorkerJson(stdout);

        if (!payload.ok) {
          const transportErrorText = stringifyTransportErrors(payload.transportErrors);
          const errorCode = payload.errorCode || '';
          const rawError = [
            errorCode,
            payload.error || '',
            payload.rawError || '',
            payload.traceback || '',
            transportErrorText
          ].filter(Boolean).join('\n').trim();
          const message = normalizeAdapterErrorMessage(rawError, adapterMeta.label);
          reject(createDetailedFetchError(
            message,
            buildAdapterErrorDetails(
              adapterMeta,
              rawError,
              getPayloadLastTransportError(payload, message),
              payload
            )
          ));
          return;
        }

        const source = payload.source || adapterMeta.source;
        const bars = attachSourceToBars(payload.bars || [], source);
        resolve({
          source,
          bars
        });
      } catch (error) {
        const rawError = `${error.message || error}\n${stderr}`.trim();
        const message = normalizeAdapterErrorMessage(rawError, adapterMeta.label);
        reject(createDetailedFetchError(
          message,
          buildAdapterErrorDetails(adapterMeta, rawError, message)
        ));
      }
    });
  });
}

async function runDataFetchAttempt(options) {
  const attemptOptions = options || {};
  let lastError = null;
  let akshareError = '';
  let eastmoneyError = '';
  let altDailyError = '';
  let rawError = '';
  let lastTransportError = '';
  let emptyBars = false;
  let emptySource = '';
  let unsupportedMarket = false;
  let errorCode = '';
  const rawErrorParts = [];
  const adapterOrder = buildAdapterRunOrder(attemptOptions.preferredSource, attemptOptions);

  function rememberRawError(label, value) {
    const text = String(value || '').trim();

    if (!text) {
      return;
    }

    rawErrorParts.push(`${label}:\n${text}`);
    rawError = rawErrorParts.join('\n\n');
  }

  for (let index = 0; index < adapterOrder.length; index += 1) {
    const adapter = adapterOrder[index];
    const nextAdapter = adapterOrder[index + 1];

    try {
      const result = await runPythonAdapter(adapter.path, attemptOptions);
      const source = getSourceFamily(result.source || adapter.source);

      if (Array.isArray(result.bars) && result.bars.length > 0) {
        return {
          source,
          bars: result.bars
        };
      }

      if (source === 'baostock_a_share') {
        return {
          source,
          bars: []
        };
      }

      const emptyMessage = `${adapter.label} 数据拉取失败：返回空日线。`;
      emptyBars = true;
      emptySource = source;

      if (adapter.errorKey === 'akshareError') {
        akshareError = emptyMessage;
      } else if (adapter.errorKey === 'eastmoneyError') {
        eastmoneyError = emptyMessage;
      } else if (adapter.errorKey === 'altDailyError') {
        altDailyError = emptyMessage;
      }

      rememberRawError(adapter.label, emptyMessage);
      lastTransportError = emptyMessage;
      console.error(
        `[pythonWorker] ${adapter.label} returned empty bars${nextAdapter ? `, trying ${nextAdapter.label}.` : '.'}`
      );
    } catch (error) {
      lastError = error;
      const errorText = error && error[adapter.errorKey]
        ? error[adapter.errorKey]
        : error && error.message ? error.message : String(error || '');

      if (adapter.errorKey === 'akshareError') {
        akshareError = errorText;
      } else if (adapter.errorKey === 'eastmoneyError') {
        eastmoneyError = errorText;
      } else if (adapter.errorKey === 'altDailyError') {
        altDailyError = errorText;
      }

      if (error && error.emptyBars) {
        emptyBars = true;
        emptySource = getSourceFamily(error.emptySource || error.adapterSource || adapter.source);
      }

      if (error && (error.unsupportedMarket || error.errorCode === 'UNSUPPORTED_MARKET')) {
        unsupportedMarket = true;
        errorCode = 'UNSUPPORTED_MARKET';
      }

      rememberRawError(adapter.label, error && error.rawError ? error.rawError : errorText);
      lastTransportError = error && error.lastTransportError ? error.lastTransportError : errorText;
      console.error(
        `[pythonWorker] ${adapter.label} failed${nextAdapter ? `, trying ${nextAdapter.label}` : ''}: ${compactText(error.message, 220)}`
      );
    }
  }

  throw createDetailedFetchError(DATA_FETCH_FAILED_MESSAGE, {
    errorCode,
    unsupportedMarket,
    akshareError,
    eastmoneyError,
    altDailyError,
    rawError: rawError || (lastError && lastError.rawError) || [akshareError, eastmoneyError, altDailyError].filter(Boolean).join('\n'),
    lastTransportError: lastTransportError || (lastError && lastError.lastTransportError) || (lastError && lastError.message) || '',
    emptyBars,
    emptySource
  });
}

async function fetchDailyBarsFromPython(options = {}) {
  try {
    return await runDataFetchAttempt(options);
  } catch (error) {
    console.error(`[pythonWorker] Data fetch failed: ${compactText(error.message, 220)}`);
    throw createDetailedFetchError(error && error.message ? error.message : DATA_FETCH_FAILED_MESSAGE, {
      errorCode: error && error.errorCode ? error.errorCode : '',
      unsupportedMarket: error && error.unsupportedMarket,
      akshareError: error && error.akshareError ? error.akshareError : '',
      eastmoneyError: error && error.eastmoneyError ? error.eastmoneyError : '',
      altDailyError: error && error.altDailyError ? error.altDailyError : '',
      rawError: error && error.rawError ? error.rawError : (error && error.stack ? error.stack : String(error || '')),
      lastTransportError: error && error.lastTransportError ? error.lastTransportError : '',
      adapterSource: error && error.adapterSource ? error.adapterSource : '',
      emptyBars: error && error.emptyBars,
      emptySource: error && error.emptySource ? error.emptySource : ''
    });
  }
}

module.exports = {
  fetchDailyBarsFromPython,
  DATA_FETCH_FAILED_MESSAGE,
  getSourceFamily,
  getPythonChildEnv,
  normalizeNetworkMode,
  createDetailedFetchError,
  normalizeAkshareErrorMessage,
  normalizeAdapterErrorMessage,
  buildAdapterRunOrder,
  runDataFetchAttempt,
  runPythonAdapter
};
