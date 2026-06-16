const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getPythonChildEnv, normalizeNetworkMode } = require('../workers/pythonWorker');
const { normalizeMarketSymbol } = require('./marketSymbolService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const UNIVERSE_DIR = path.join(PROJECT_ROOT, 'data', 'universe');
const HK_UNIVERSE_PATH = path.join(UNIVERSE_DIR, 'hk-stock-universe.json');
const HK_STOCK_LIST_ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'adapters', 'hkStockListAdapter.py');
const HK_UNIVERSE_VERSION = 'dev-0.1.9.1';

function ensureUniverseDir() {
  fs.mkdirSync(UNIVERSE_DIR, { recursive: true });
}

function getHongKongStockUniversePath() {
  return HK_UNIVERSE_PATH;
}

function getPythonCommand() {
  return process.env.PYTHON || 'python';
}

function parseWorkerJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`港股列表 Worker 没有返回 JSON：${text.slice(0, 300)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function runHongKongStockListAdapter(options = {}) {
  const networkMode = normalizeNetworkMode(options.networkMode || 'direct');

  return new Promise((resolve, reject) => {
    const child = spawn(
      getPythonCommand(),
      [HK_STOCK_LIST_ADAPTER_PATH],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: getPythonChildEnv(networkMode)
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
      reject(new Error('港股股票列表拉取超时。'));
    }, 300000);

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
      reject(error);
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
          const detail = [
            payload.error || '',
            Array.isArray(payload.errors) ? payload.errors.join('\n') : '',
            payload.traceback || '',
            stderr || ''
          ].filter(Boolean).join('\n');
          throw new Error(detail || '港股股票列表拉取失败。');
        }

        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeStockItem(item) {
  const identity = normalizeMarketSymbol(item && (item.symbol || item.code || ''));

  if (identity.market !== 'HK') {
    return null;
  }

  return {
    symbol: identity.displaySymbol,
    code: identity.symbol,
    name: String(item && item.name || '').trim(),
    market: identity.market,
    exchange: identity.exchange,
    currency: identity.currency,
    source: String(item && item.source || '').trim(),
    industry: String(item && item.industry || '').trim()
  };
}

function dedupeStocks(stocks) {
  const seen = new Set();
  const result = [];

  for (const item of Array.isArray(stocks) ? stocks : []) {
    const stock = normalizeStockItem(item);

    if (!stock || seen.has(stock.symbol)) {
      continue;
    }

    seen.add(stock.symbol);
    result.push(stock);
  }

  result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return result;
}

function buildUniversePayload(fetchResult) {
  const stocks = dedupeStocks(fetchResult && fetchResult.stocks);

  return {
    version: HK_UNIVERSE_VERSION,
    market: 'HK',
    updatedAt: new Date().toISOString(),
    source: fetchResult && fetchResult.source || 'eastmoney_hk_clist_direct',
    networkMode: fetchResult && fetchResult.networkMode || '',
    rawCount: Number(fetchResult && fetchResult.rawCount) || 0,
    filteredCount: stocks.length,
    warnings: Array.isArray(fetchResult && fetchResult.warnings) ? fetchResult.warnings : [],
    stocks
  };
}

function saveHongKongStockUniverse(payload) {
  ensureUniverseDir();
  fs.writeFileSync(HK_UNIVERSE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function loadHongKongStockUniverse() {
  if (!fs.existsSync(HK_UNIVERSE_PATH)) {
    return {
      version: HK_UNIVERSE_VERSION,
      market: 'HK',
      updatedAt: '',
      source: '',
      rawCount: 0,
      filteredCount: 0,
      warnings: [],
      stocks: []
    };
  }

  const raw = JSON.parse(fs.readFileSync(HK_UNIVERSE_PATH, 'utf8'));
  const stocks = dedupeStocks(raw && raw.stocks);

  return {
    version: raw.version || HK_UNIVERSE_VERSION,
    market: 'HK',
    updatedAt: raw.updatedAt || '',
    source: raw.source || '',
    networkMode: raw.networkMode || '',
    rawCount: Number(raw.rawCount) || stocks.length,
    filteredCount: stocks.length,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    stocks
  };
}

async function refreshHongKongStockUniverse(options = {}) {
  const fetchResult = await runHongKongStockListAdapter(options);
  const payload = buildUniversePayload(fetchResult);
  saveHongKongStockUniverse(payload);

  return {
    ...payload,
    path: HK_UNIVERSE_PATH
  };
}

function normalizeSymbolList(symbols) {
  const rawList = [];

  if (Array.isArray(symbols)) {
    for (const item of symbols) {
      rawList.push(...String(item || '').split(/[,，\s]+/));
    }
  } else {
    rawList.push(...String(symbols || '').split(/[,，\s]+/));
  }

  const seen = new Set();
  const result = [];

  for (const item of rawList) {
    const text = String(item || '').trim();

    if (!text) {
      continue;
    }

    const identity = normalizeMarketSymbol(text);

    if (identity.market !== 'HK') {
      throw new Error(`港股同步只接受港股代码：${item}`);
    }

    if (seen.has(identity.displaySymbol)) {
      continue;
    }

    seen.add(identity.displaySymbol);
    result.push(identity.displaySymbol);
  }

  return result;
}

async function selectHongKongStocksForSync(options = {}) {
  const requestedSymbols = normalizeSymbolList(options.symbols);
  const universe = options.refreshList
    ? await refreshHongKongStockUniverse(options)
    : loadHongKongStockUniverse();
  const bySymbol = new Map((universe.stocks || []).map((stock) => [stock.symbol, stock]));

  if (requestedSymbols.length > 0) {
    return requestedSymbols.map((symbol) => bySymbol.get(symbol) || {
      symbol,
      code: normalizeMarketSymbol(symbol).symbol,
      name: '',
      market: 'HK',
      exchange: 'HKEX',
      currency: 'HKD',
      source: 'manual'
    });
  }

  let stocks = Array.isArray(universe.stocks) ? universe.stocks : [];
  const maxCount = Number(options.maxCount) || 0;

  if (maxCount > 0) {
    stocks = stocks.slice(0, maxCount);
  }

  return stocks;
}

module.exports = {
  HK_UNIVERSE_VERSION,
  getHongKongStockUniversePath,
  loadHongKongStockUniverse,
  refreshHongKongStockUniverse,
  selectHongKongStocksForSync,
  normalizeSymbolList
};