const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getPythonChildEnv } = require('../workers/pythonWorker');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const UNIVERSE_DIR = path.join(PROJECT_ROOT, 'data', 'universe');
const UNIVERSE_PATH = path.join(UNIVERSE_DIR, 'stock-universe.json');
const ADAPTER_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'aShareUniverseAdapter.py');
const UNIVERSE_VERSION = 'dev-0.1.9.0';
const ADAPTER_TIMEOUT_MS = 120000;

let MEMORY_UNIVERSE = null;

function ensureUniverseDir() {
  fs.mkdirSync(UNIVERSE_DIR, { recursive: true });
}

function getUniversePath() {
  return UNIVERSE_PATH;
}

function getPythonCommandCandidates() {
  const candidates = [];
  const addCandidate = (command) => {
    if (!command || candidates.includes(command)) {
      return;
    }

    candidates.push(command);
  };
  const bundledPython = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe'
  );

  addCandidate(process.env.PYTHON);
  addCandidate('python');
  addCandidate('py');

  if (fs.existsSync(bundledPython)) {
    addCandidate(bundledPython);
  }

  return candidates;
}

function compactErrorMessage(error, limit = 240) {
  const text = String(error && error.message ? error.message : error || '未知错误')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function parseAdapterJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`股票池 Adapter 没有返回 JSON：${text.slice(0, 240)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function inferMarket(symbol) {
  const cleanSymbol = String(symbol || '').trim();

  if (cleanSymbol.startsWith('6')) {
    return 'SH';
  }

  if (cleanSymbol.startsWith('0') || cleanSymbol.startsWith('3')) {
    return 'SZ';
  }

  if (
    cleanSymbol.startsWith('8')
    || cleanSymbol.startsWith('4')
    || cleanSymbol.startsWith('920')
  ) {
    return 'BJ';
  }

  return 'UNKNOWN';
}

function normalizeSymbol(symbol) {
  const text = String(symbol || '').trim().toUpperCase();
  const directMatch = text.match(/^\d{6}$/);

  if (directMatch) {
    return directMatch[0];
  }

  const embeddedMatch = text.match(/(\d{6})/);

  if (embeddedMatch) {
    return embeddedMatch[1];
  }

  throw new Error(`非法 A 股代码：${symbol}`);
}

function normalizeDateText(value) {
  const text = String(value || '').trim().replace(/[-/]/g, '');

  if (!/^\d{8}$/.test(text)) {
    return '';
  }

  return text;
}

function normalizeStock(rawStock) {
  const symbol = normalizeSymbol(rawStock && rawStock.symbol);
  const market = String(rawStock && rawStock.market || inferMarket(symbol)).trim().toUpperCase() || inferMarket(symbol);
  const status = String(rawStock && rawStock.status || 'ACTIVE').trim().toUpperCase();
  const listDate = normalizeDateText(
    rawStock && (rawStock.listDate || rawStock.listingDate || rawStock.listedDate || rawStock.ipoDate)
  );

  const stock = {
    symbol,
    name: String(rawStock && rawStock.name || '').trim(),
    market,
    status: status || 'ACTIVE'
  };

  if (listDate) {
    stock.listDate = listDate;
  }

  return stock;
}

function normalizeStocks(stocks) {
  const list = Array.isArray(stocks) ? stocks : [];
  const seen = new Set();
  const normalized = [];

  for (const stock of list) {
    try {
      const item = normalizeStock(stock);

      if (seen.has(item.symbol)) {
        continue;
      }

      seen.add(item.symbol);
      normalized.push(item);
    } catch (_error) {
      // 忽略异常股票代码，避免单条脏数据破坏全量股票池。
    }
  }

  return normalized;
}

function normalizeUniversePayload(payload) {
  const rawStocks = payload && Array.isArray(payload.stocks) ? payload.stocks : [];

  return {
    ok: true,
    version: payload && payload.version ? payload.version : UNIVERSE_VERSION,
    source: payload && payload.source ? payload.source : 'unknown',
    updatedAt: payload && payload.updatedAt ? payload.updatedAt : new Date().toISOString(),
    stocks: normalizeStocks(rawStocks)
  };
}

function readUniverseFromDisk() {
  if (!fs.existsSync(UNIVERSE_PATH)) {
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
  return normalizeUniversePayload(payload);
}

function writeUniverseToDisk(payload) {
  ensureUniverseDir();
  const universe = normalizeUniversePayload({
    ...payload,
    version: UNIVERSE_VERSION,
    updatedAt: new Date().toISOString()
  });

  fs.writeFileSync(UNIVERSE_PATH, `${JSON.stringify(universe, null, 2)}\n`, 'utf8');
  MEMORY_UNIVERSE = universe;

  return universe;
}

function runUniverseAdapterWithCommand(pythonCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonCommand,
      [ADAPTER_PATH],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: getPythonChildEnv()
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
      reject(new Error('股票池 Adapter 超时，请稍后重试。'));
    }, ADAPTER_TIMEOUT_MS);

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
      reject(new Error(`无法启动 Python：${error.message}`));
    });

    child.on('close', () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      try {
        const payload = parseAdapterJson(stdout);

        if (!payload.ok) {
          reject(new Error(payload.error || compactErrorMessage(stderr) || '股票池 Adapter 失败。'));
          return;
        }

        resolve(payload);
      } catch (error) {
        reject(new Error(`股票池 Adapter 解析失败：${compactErrorMessage(error)} ${compactErrorMessage(stderr, 160)}`.trim()));
      }
    });
  });
}

async function refreshStockUniverse() {
  let lastError = null;

  for (const pythonCommand of getPythonCommandCandidates()) {
    try {
      const payload = await runUniverseAdapterWithCommand(pythonCommand);
      return writeUniverseToDisk(payload);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('无法启动 Python 股票池 Adapter。');
}

async function loadStockUniverse() {
  if (MEMORY_UNIVERSE) {
    return MEMORY_UNIVERSE;
  }

  const diskUniverse = readUniverseFromDisk();

  if (diskUniverse) {
    MEMORY_UNIVERSE = diskUniverse;
    return diskUniverse;
  }

  return refreshStockUniverse();
}

async function getActiveStocksOnDate(_date) {
  const universe = await loadStockUniverse();
  return universe.stocks.filter((stock) => stock.status === 'ACTIVE');
}

function parseSymbols(symbols) {
  const rawList = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(/[,，\s]+/);

  const seen = new Set();
  const cleanSymbols = [];

  for (const symbol of rawList) {
    if (!symbol) {
      continue;
    }

    const cleanSymbol = normalizeSymbol(symbol);

    if (seen.has(cleanSymbol)) {
      continue;
    }

    seen.add(cleanSymbol);
    cleanSymbols.push(cleanSymbol);
  }

  return cleanSymbols;
}

function getFilterUniverse(options) {
  if (options && Array.isArray(options.universe)) {
    return normalizeStocks(options.universe);
  }

  if (options && Array.isArray(options.stockUniverse)) {
    return normalizeStocks(options.stockUniverse);
  }

  const diskUniverse = readUniverseFromDisk();
  return diskUniverse ? diskUniverse.stocks : [];
}

function findOrCreateStock(symbol, universe) {
  const cleanSymbol = normalizeSymbol(symbol);
  const found = universe.find((stock) => stock.symbol === cleanSymbol);

  if (found) {
    return found;
  }

  return {
    symbol: cleanSymbol,
    name: '',
    market: inferMarket(cleanSymbol),
    status: 'ACTIVE'
  };
}

function applyMaxCount(stocks, maxCount) {
  const count = Number(maxCount);

  if (!Number.isFinite(count) || count <= 0) {
    return stocks;
  }

  return stocks.slice(0, Math.max(0, Math.floor(count)));
}

function isBjMarketSymbol(symbol) {
  const text = String(symbol || '').trim();
  return text.startsWith('8') || text.startsWith('4') || text.startsWith('920');
}

function isBaoStockSupportedAshareSymbol(symbol) {
  const text = String(symbol || '').trim();

  return /^\d{6}$/.test(text)
    && (
      text.startsWith('0')
      || text.startsWith('3')
      || text.startsWith('6')
      || isBjMarketSymbol(text)
    );
}

function isBaoStockSupportedAshareStock(stock) {
  const symbol = String(stock && stock.symbol || '').trim();
  const market = String(stock && stock.market || inferMarket(symbol)).trim().toUpperCase();

  if (!isBaoStockSupportedAshareSymbol(symbol)) {
    return false;
  }

  if (market === 'BJ') {
    return isBjMarketSymbol(symbol);
  }

  if (market === 'SH') {
    return symbol.startsWith('6');
  }

  if (market === 'SZ') {
    return symbol.startsWith('0') || symbol.startsWith('3');
  }

  return symbol.startsWith('0') || symbol.startsWith('3') || symbol.startsWith('6') || isBjMarketSymbol(symbol);
}

function describeStockForMessage(stock) {
  const symbol = String(stock && stock.symbol || '').trim();
  const name = String(stock && stock.name || '').trim();
  const market = String(stock && stock.market || '').trim();

  return `${symbol}${name ? ` ${name}` : ''}${market ? `/${market}` : ''}`;
}

function filterStocksForBaoStockAshareSync(stocks, options = {}) {
  const list = Array.isArray(stocks) ? stocks : [];
  const mode = String(options.mode || '').trim().toLowerCase();
  const supported = [];
  const unsupported = [];

  for (const stock of list) {
    if (isBaoStockSupportedAshareStock(stock)) {
      supported.push(stock);
    } else {
      unsupported.push(stock);
    }
  }

  if (unsupported.length > 0 && (mode === 'symbols' || mode === 'current')) {
    const text = unsupported.slice(0, 12).map(describeStockForMessage).join('，');
    const suffix = unsupported.length > 12 ? ` 等 ${unsupported.length} 只` : '';

    throw new Error(
      `A股同步暂不支持以下代码：${text}${suffix}。当前支持沪深北 A股：0/3/6/4/8/920 开头。`
    );
  }

  return supported;
}

function filterStocksForSync(options = {}) {
  const mode = String(options.mode || 'full').trim().toLowerCase();
  const universe = getFilterUniverse(options).filter((stock) => stock.status === 'ACTIVE');
  let selected = [];

  if (mode === 'current') {
    selected = options.currentSymbol ? [findOrCreateStock(options.currentSymbol, universe)] : [];
  } else if (mode === 'symbols') {
    selected = parseSymbols(options.symbols).map((symbol) => findOrCreateStock(symbol, universe));
  } else if (mode === 'market') {
    const markets = new Set(
      (Array.isArray(options.markets) ? options.markets : [options.markets])
        .filter(Boolean)
        .map((market) => String(market).trim().toUpperCase())
    );

    selected = universe.filter((stock) => markets.has(stock.market));
  } else if (mode === 'limit') {
    selected = universe;
  } else {
    selected = universe;
  }

  return applyMaxCount(selected, options.maxCount);
}

module.exports = {
  loadStockUniverse,
  refreshStockUniverse,
  getActiveStocksOnDate,
  filterStocksForSync,
  filterStocksForBaoStockAshareSync,
  isBaoStockSupportedAshareSymbol,
  isBaoStockSupportedAshareStock,
  isBjMarketSymbol,
  normalizeSymbol,
  inferMarket,
  getUniversePath
};
