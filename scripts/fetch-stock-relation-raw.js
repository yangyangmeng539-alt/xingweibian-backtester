const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  resolvePython,
  normalizePythonResolution,
  buildPythonArgs
} = require('../src/runtime/pythonResolver');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MARKET_GRAPH_DIR = path.join(PROJECT_ROOT, 'data', 'market-graph');
const SEED_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-raw.seed.json');
const PROGRESS_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-progress.json');
const ERRORS_PATH = path.join(MARKET_GRAPH_DIR, 'stock-relation-errors.json');
const WORKER_PATH = path.join(__dirname, 'fetch_stock_relation_raw_worker.py');
const RELATION_VERSION = 'dev-0.1.0';
const RELATION_SOURCE = 'adata:get_concept_ths|get_plate_east';
const DEFAULT_CONCURRENCY = 2;
const MAX_RETRIES_PER_STOCK = 2;
const WORKER_TIMEOUT_MS = 120000;
const PYTHON_PREFLIGHT_TIMEOUT_MS = 20000;
const PYTHON_PREFLIGHT_CODE = 'import sys; print(sys.executable); import adata;';
const SLEEP_MIN_MS = 300;
const SLEEP_MAX_MS = 800;
const SKIP_PROGRESS_FLUSH_COUNT = 50;
const PROGRESS_FLUSH_COMPLETED_COUNT = 50;
const PROGRESS_FLUSH_INTERVAL_MS = 2000;
const SAFE_WRITE_RENAME_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EXDEV']);
const writeWarnings = [];
let activeRunContext = null;
let terminalProgressWritten = false;

const STOCK_POOL_LOADERS = [
  {
    source: 'data/universe/stock-universe.json',
    path: path.join(PROJECT_ROOT, 'data', 'universe', 'stock-universe.json'),
    load: readStockUniverse
  },
  {
    source: 'data/sync/cache-index.json',
    path: path.join(PROJECT_ROOT, 'data', 'sync', 'cache-index.json'),
    load: readCacheIndexUniverse
  },
  {
    source: 'data/sync/full-a-share-sync-state.json',
    path: path.join(PROJECT_ROOT, 'data', 'sync', 'full-a-share-sync-state.json'),
    load: readSyncStateUniverse
  }
];

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

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSleepMs() {
  return SLEEP_MIN_MS + Math.floor(Math.random() * (SLEEP_MAX_MS - SLEEP_MIN_MS + 1));
}

function compactText(value, limit = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function ensureMarketGraphDir() {
  fs.mkdirSync(MARKET_GRAPH_DIR, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;

  fs.writeFileSync(tempPath, jsonText, 'utf8');

  try {
    fs.renameSync(tempPath, filePath);
    return null;
  } catch (error) {
    if (!error || !SAFE_WRITE_RENAME_FALLBACK_CODES.has(error.code)) {
      throw error;
    }

    fs.writeFileSync(filePath, jsonText, 'utf8');

    let cleanupError = '';

    try {
      fs.unlinkSync(tempPath);
    } catch (unlinkError) {
      cleanupError = unlinkError && unlinkError.message ? unlinkError.message : String(unlinkError);
    }

    const warning = {
      filePath,
      tempPath,
      code: error.code,
      message: error.message,
      cleanupError,
      at: nowIso()
    };

    writeWarnings.push(warning);
    return warning;
  }
}

function appendArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
    return;
  }

  if (Array.isArray(args[key])) {
    args[key].push(value);
    return;
  }

  args[key] = [args[key], value];
}

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];

    if (!part.startsWith('--')) {
      args._.push(part);
      continue;
    }

    const eqIndex = part.indexOf('=');

    if (eqIndex >= 0) {
      appendArg(args, part.slice(2, eqIndex), part.slice(eqIndex + 1));
      continue;
    }

    const key = part.slice(2);
    const next = argv[index + 1];

    if (next && !next.startsWith('--')) {
      appendArg(args, key, next);
      index += 1;
    } else {
      appendArg(args, key, true);
    }
  }

  return args;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (value === true || value === 'true' || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === '0') {
    return false;
  }

  return fallback;
}

function parseNumber(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const num = Number(raw);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(num)));
}

function parseList(value) {
  const list = Array.isArray(value) ? value : [value];

  return list
    .flatMap((item) => String(item || '').split(/[,，\s]+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCode(value) {
  const text = String(value || '').replace(/\D/g, '').trim();

  if (!text) {
    return '';
  }

  return text.padStart(6, '0').slice(-6);
}

function inferMarket(code) {
  const symbol = normalizeCode(code);

  if (/^(43|83|87|88|92)/.test(symbol)) {
    return 'BJ';
  }

  if (/^(0|2|3)/.test(symbol)) {
    return 'SZ';
  }

  if (/^(5|6|9)/.test(symbol)) {
    return 'SH';
  }

  return '';
}

function normalizeStock(rawStock, fallbackSymbol = '') {
  const code = normalizeCode(
    rawStock && (rawStock.code || rawStock.symbol || rawStock.stock_code || rawStock.stockCode) || fallbackSymbol
  );

  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  return {
    code,
    name: String(rawStock && (rawStock.name || rawStock.stock_name || rawStock.stockName) || '').trim(),
    market: String(rawStock && rawStock.market || inferMarket(code)).trim().toUpperCase() || inferMarket(code),
    status: String(rawStock && rawStock.status || 'ACTIVE').trim().toUpperCase() || 'ACTIVE'
  };
}

function uniqueStocks(stocks) {
  const seen = new Set();
  const list = [];

  for (const stock of Array.isArray(stocks) ? stocks : []) {
    const normalized = normalizeStock(stock);

    if (!normalized || seen.has(normalized.code)) {
      continue;
    }

    seen.add(normalized.code);
    list.push(normalized);
  }

  return list;
}

function readStockUniverse(filePath) {
  const payload = readJsonFile(filePath, null);
  return uniqueStocks(payload && payload.stocks);
}

function readCacheIndexUniverse(filePath) {
  const payload = readJsonFile(filePath, null);
  const items = payload && payload.items && typeof payload.items === 'object' ? payload.items : {};

  return uniqueStocks(Object.entries(items).map(([symbol, item]) => ({
    ...item,
    symbol
  })));
}

function readSyncStateUniverse(filePath) {
  const payload = readJsonFile(filePath, null);
  const items = payload && payload.items && typeof payload.items === 'object' ? payload.items : {};

  return uniqueStocks(Object.entries(items).map(([symbol, item]) => ({
    ...item,
    symbol
  })));
}

function loadStockPool() {
  for (const loader of STOCK_POOL_LOADERS) {
    if (!fs.existsSync(loader.path)) {
      continue;
    }

    const stocks = loader.load(loader.path);

    if (stocks.length > 0) {
      return {
        source: loader.source,
        stocks
      };
    }
  }

  return {
    source: '',
    stocks: []
  };
}

function buildOptions(args) {
  const only = parseList(args.only || args.symbols || args.symbol);
  const limit = parseNumber(args.limit, 0, 0);
  const concurrency = parseNumber(args.concurrency, DEFAULT_CONCURRENCY, 1, 8);

  return {
    only: only.map(normalizeCode).filter((code) => /^\d{6}$/.test(code)),
    limit,
    concurrency,
    retryFailed: parseBoolean(args['retry-failed'] || args.retryFailed, false),
    force: parseBoolean(args.force, false)
  };
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

function loadSeed() {
  const raw = readJsonFile(SEED_PATH, null);
  const seed = {
    ...createEmptySeed(),
    ...(raw && typeof raw === 'object' ? raw : {})
  };

  seed.version = RELATION_VERSION;
  seed.source = RELATION_SOURCE;
  seed.items = seed.items && typeof seed.items === 'object' ? seed.items : {};
  return seed;
}

function recomputeSeedCounts(seed, selectedTotal) {
  const items = Object.values(seed.items || {});
  seed.total = Math.max(Number(selectedTotal) || 0, items.length);
  seed.done = items.filter((item) => item && item.status === 'DONE').length;
  seed.failed = items.filter((item) => item && item.status === 'FAILED').length;
  seed.generatedAt = nowIso();
  return seed;
}

function buildSelectedStocks(stockPool, options, seed = null) {
  const lookup = new Map(stockPool.stocks.map((stock) => [stock.code, stock]));
  const onlySet = options.only.length > 0 ? new Set(options.only) : null;
  let selected = stockPool.stocks;

  if (options.retryFailed) {
    selected = Object.values(seed && seed.items || {})
      .filter((item) => item && item.status === 'FAILED' && normalizeCode(item.code))
      .filter((item) => !onlySet || onlySet.has(normalizeCode(item.code)))
      .map((item) => {
        const code = normalizeCode(item.code);
        return lookup.get(code) || {
          code,
          name: item.name || '',
          market: item.market || inferMarket(code),
          status: 'FAILED'
        };
      });

    if (options.limit > 0) {
      selected = selected.slice(0, options.limit);
    }

    return uniqueStocks(selected);
  }

  if (options.only.length > 0) {
    selected = options.only.map((code) => lookup.get(code) || {
      code,
      name: '',
      market: inferMarket(code),
      status: 'ACTIVE'
    });
  }

  if (options.limit > 0 && options.only.length === 0) {
    selected = selected.slice(0, options.limit);
  }

  return uniqueStocks(selected);
}

function getPythonCommand() {
  return resolvePython({
    projectRoot: PROJECT_ROOT
  }).displayPath;
}

function getPythonResolution(options = {}) {
  return resolvePython({
    projectRoot: PROJECT_ROOT,
    ...options
  });
}

function getPythonChildEnv() {
  return {
    ...process.env,
    ...PROXY_ENV_OVERRIDES
  };
}

function buildPythonPreflightStatus(overrides = {}) {
  return {
    status: overrides.status || 'not_checked',
    ok: overrides.ok === true,
    selectedPython: overrides.selectedPython || '',
    resolverSource: overrides.resolverSource || '',
    executable: overrides.executable || '',
    error: overrides.error || '',
    stderr: overrides.stderr || '',
    checkedAt: overrides.checkedAt || ''
  };
}

function runPythonPreflight(pythonResolution = getPythonResolution()) {
  return new Promise((resolve) => {
    const resolution = normalizePythonResolution(pythonResolution, {
      projectRoot: PROJECT_ROOT
    });
    const startedAt = nowIso();
    let stdout = '';
    let stderr = '';
    let finished = false;
    let child = null;

    function finish(status) {
      if (finished) {
        return;
      }

      finished = true;
      resolve(buildPythonPreflightStatus({
        ...status,
        selectedPython: resolution.displayPath,
        resolverSource: resolution.source,
        checkedAt: status.checkedAt || nowIso()
      }));
    }

    try {
      child = spawn(
        resolution.command,
        buildPythonArgs(resolution, ['-c', PYTHON_PREFLIGHT_CODE]),
        {
          cwd: PROJECT_ROOT,
          windowsHide: true,
          env: getPythonChildEnv()
        }
      );
    } catch (error) {
      finish({
        status: 'failed',
        error: `无法启动 Python：${error.message}`,
        checkedAt: startedAt
      });
      return;
    }

    const timer = setTimeout(() => {
      if (child) {
        child.kill('SIGKILL');
      }

      finish({
        status: 'failed',
        error: 'Python 预检超时。',
        stderr
      });
    }, PYTHON_PREFLIGHT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        status: 'failed',
        error: `无法启动 Python：${error.message}`,
        stderr
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const executable = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';

      if (code === 0) {
        finish({
          status: 'passed',
          ok: true,
          executable,
          stderr
        });
        return;
      }

      finish({
        status: 'failed',
        executable,
        error: compactText(stderr || stdout || `Python 预检失败，退出码 ${code}。`, 800),
        stderr
      });
    });
  });
}

function buildPythonPreflightError(preflight) {
  const status = preflight || {};
  const parts = [
    'Python 预检失败',
    status.selectedPython ? `命令：${status.selectedPython}` : '',
    status.resolverSource ? `来源：${status.resolverSource}` : '',
    status.executable ? `解释器：${status.executable}` : '',
    status.error ? `错误：${status.error}` : ''
  ].filter(Boolean);

  return parts.join('；');
}

function parseWorkerJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');

  if (start < 0) {
    throw new Error(`Python worker 没有返回 JSON：${text.slice(0, 260)}`);
  }

  return JSON.parse(text.slice(start));
}

function runPythonWorker(stock, pythonResolution = getPythonResolution()) {
  return new Promise((resolve, reject) => {
    const resolution = normalizePythonResolution(pythonResolution, {
      projectRoot: PROJECT_ROOT
    });
    const child = spawn(
      resolution.command,
      buildPythonArgs(resolution, [WORKER_PATH, stock.code]),
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
      reject(new Error(`${stock.code} 关系数据采集超时。`));
    }, WORKER_TIMEOUT_MS);

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
      reject(new Error(`无法启动 Python worker：${error.message}`));
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
          const details = [payload.error, payload.traceback, stderr].filter(Boolean).join('\n');
          reject(new Error(compactText(details || `${stock.code} 关系数据采集失败。`, 800)));
          return;
        }

        resolve(payload);
      } catch (error) {
        reject(new Error(compactText(`${error.message}\n${stderr}`, 800)));
      }
    });
  });
}

async function fetchStockWithRetries(stock, pythonCommand) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_STOCK; attempt += 1) {
    try {
      const payload = await runPythonWorker(stock, pythonCommand);
      return {
        ok: true,
        retryCount: attempt,
        payload
      };
    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES_PER_STOCK) {
        await sleep(randomSleepMs());
      }
    }
  }

  return {
    ok: false,
    retryCount: MAX_RETRIES_PER_STOCK,
    error: lastError
  };
}

function makeDoneItem(stock, payload, retryCount) {
  return {
    code: stock.code,
    name: stock.name || '',
    market: stock.market || inferMarket(stock.code),
    status: 'DONE',
    updatedAt: nowIso(),
    conceptThs: Array.isArray(payload.conceptThs) ? payload.conceptThs : [],
    plateEast: Array.isArray(payload.plateEast) ? payload.plateEast : [],
    error: '',
    retryCount
  };
}

function makeFailedItem(stock, error, retryCount) {
  return {
    code: stock.code,
    name: stock.name || '',
    market: stock.market || inferMarket(stock.code),
    status: 'FAILED',
    updatedAt: nowIso(),
    conceptThs: [],
    plateEast: [],
    error: compactText(error && error.message ? error.message : error, 800),
    retryCount
  };
}

function buildErrorsPayload(seed) {
  const items = {};

  for (const [code, item] of Object.entries(seed.items || {})) {
    if (item && item.status === 'FAILED') {
      items[code] = {
        code,
        name: item.name || '',
        market: item.market || '',
        updatedAt: item.updatedAt || '',
        error: item.error || '',
        retryCount: Number(item.retryCount) || 0
      };
    }
  }

  return {
    version: RELATION_VERSION,
    updatedAt: nowIso(),
    total: Object.keys(items).length,
    items
  };
}

function buildProgressPayload(context, overrides = {}) {
  const percent = context.selectedTotal > 0
    ? Math.min(100, (context.completed / context.selectedTotal) * 100)
    : 100;

  return {
    version: RELATION_VERSION,
    updatedAt: nowIso(),
    running: Boolean(overrides.running),
    total: context.selectedTotal,
    completed: context.completed,
    skipped: context.skipped,
    fetched: context.fetched,
    failedThisRun: context.failedThisRun,
    concurrency: context.options.concurrency,
    percent,
    current: overrides.current || '',
    selectedPython: context.pythonResolution ? context.pythonResolution.displayPath : (context.selectedPython || ''),
    pythonResolverSource: context.pythonResolution ? context.pythonResolution.source : '',
    pythonPreflight: context.pythonPreflight || buildPythonPreflightStatus({
      status: 'not_checked',
      selectedPython: context.pythonResolution ? context.pythonResolution.displayPath : (context.selectedPython || ''),
      resolverSource: context.pythonResolution ? context.pythonResolution.source : ''
    }),
    stockPoolSource: context.stockPoolSource,
    seedPath: SEED_PATH,
    errorsPath: ERRORS_PATH,
    lastMessage: overrides.lastMessage || context.lastMessage || '',
    finishedAt: overrides.finishedAt || '',
    done: context.completed,
    failed: context.failedThisRun,
    seedDone: context.seed.done,
    seedFailed: context.seed.failed,
    writeWarnings: writeWarnings.length
  };
}

function rememberProgressWrite(context) {
  context.lastProgressWriteMs = Date.now();
  context.lastProgressCompleted = context.completed;
  context.lastProgressSkipped = context.skipped;
}

function shouldWriteProgress(context, options = {}) {
  if (options.force) {
    return true;
  }

  const now = Date.now();
  const lastWriteMs = Number(context.lastProgressWriteMs) || 0;
  const completedSinceWrite = context.completed - (Number(context.lastProgressCompleted) || 0);
  const skippedSinceWrite = context.skipped - (Number(context.lastProgressSkipped) || 0);

  return (
    now - lastWriteMs >= PROGRESS_FLUSH_INTERVAL_MS ||
    completedSinceWrite >= PROGRESS_FLUSH_COMPLETED_COUNT ||
    skippedSinceWrite >= SKIP_PROGRESS_FLUSH_COUNT
  );
}

function saveProgress(context, progressOverrides = {}, options = {}) {
  if (!shouldWriteProgress(context, options)) {
    return null;
  }

  const warning = safeWriteJson(PROGRESS_PATH, buildProgressPayload(context, progressOverrides));
  rememberProgressWrite(context);
  return warning;
}

function saveOutputs(context, progressOverrides = {}) {
  recomputeSeedCounts(context.seed, context.selectedTotal);
  safeWriteJson(SEED_PATH, context.seed);
  safeWriteJson(ERRORS_PATH, buildErrorsPayload(context.seed));
  saveProgress(context, progressOverrides, { force: true });
  context.seedDirty = false;
}

function saveFinalOutputs(context, progressOverrides = {}) {
  recomputeSeedCounts(context.seed, context.selectedTotal);

  if (context.seedDirty) {
    safeWriteJson(SEED_PATH, context.seed);
    safeWriteJson(ERRORS_PATH, buildErrorsPayload(context.seed));
    context.seedDirty = false;
  }

  saveProgress(context, progressOverrides, { force: true });
}

function writeTerminalProgress(context, lastMessage) {
  if (terminalProgressWritten) {
    return;
  }

  terminalProgressWritten = true;

  if (!context) {
    try {
      const existing = readJsonFile(PROGRESS_PATH, {});
      safeWriteJson(PROGRESS_PATH, {
        ...(existing && typeof existing === 'object' ? existing : {}),
        version: RELATION_VERSION,
        updatedAt: nowIso(),
        finishedAt: nowIso(),
        running: false,
        lastMessage,
        writeWarnings: writeWarnings.length
      });
    } catch (error) {
      console.error(`[stock-relation] progress write failed: ${compactText(error && error.message ? error.message : error, 800)}`);
    }

    return;
  }

  context.lastMessage = lastMessage;

  try {
    saveProgress(context, {
      running: false,
      current: context.current || '',
      lastMessage,
      finishedAt: nowIso()
    }, { force: true });
  } catch (error) {
    console.error(`[stock-relation] progress write failed: ${compactText(error && error.message ? error.message : error, 800)}`);
  }
}

function shouldSkipStock(stock, existing, options) {
  if (!existing || options.force) {
    return false;
  }

  return existing.status === 'DONE';
}

async function processStock(stock, context) {
  const existing = context.seed.items[stock.code];
  context.current = stock.code;

  if (shouldSkipStock(stock, existing, context.options)) {
    context.completed += 1;
    context.skipped += 1;
    context.lastMessage = `${stock.code} 已有 ${existing.status} 记录，跳过。`;
    saveProgress(context, {
      running: true,
      current: stock.code,
      lastMessage: context.lastMessage
    });
    return;
  }

  context.lastMessage = `${stock.code} ${stock.name || ''} 开始采集。`.trim();
  saveProgress(context, {
    running: true,
    current: stock.code,
    lastMessage: context.lastMessage
  });

  const result = await fetchStockWithRetries(stock, context.pythonResolution);

  if (result.ok) {
    context.seed.items[stock.code] = makeDoneItem(stock, result.payload, result.retryCount);
    context.fetched += 1;
    context.lastMessage = `${stock.code} 采集完成：同花顺概念 ${context.seed.items[stock.code].conceptThs.length} 条，东方财富板块 ${context.seed.items[stock.code].plateEast.length} 条。`;
  } else {
    context.seed.items[stock.code] = makeFailedItem(stock, result.error, result.retryCount);
    context.failedThisRun += 1;
    context.lastMessage = `${stock.code} 采集失败：${compactText(result.error && result.error.message ? result.error.message : result.error, 180)}`;
  }

  context.completed += 1;
  context.seedDirty = true;
  saveOutputs(context, {
    running: true,
    current: stock.code,
    lastMessage: context.lastMessage
  });
}

async function runWorkerPool(stocks, context) {
  let index = 0;

  async function runner() {
    while (index < stocks.length) {
      const currentIndex = index;
      index += 1;
      await processStock(stocks[currentIndex], context);

      if (index < stocks.length) {
        await sleep(randomSleepMs());
      }
    }
  }

  const workers = [];
  const concurrency = Math.min(context.options.concurrency, Math.max(1, stocks.length));

  for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
    workers.push(runner());
  }

  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = buildOptions(args);
  const stockPool = loadStockPool();
  const seed = loadSeed();
  const selectedStocks = buildSelectedStocks(stockPool, options, seed);
  const pythonResolution = getPythonResolution();
  const context = {
    options,
    seed,
    selectedPython: pythonResolution.displayPath,
    pythonResolution,
    pythonPreflight: buildPythonPreflightStatus({
      status: 'checking',
      selectedPython: pythonResolution.displayPath,
      resolverSource: pythonResolution.source,
      checkedAt: nowIso()
    }),
    selectedTotal: selectedStocks.length,
    completed: 0,
    skipped: 0,
    fetched: 0,
    failedThisRun: 0,
    current: '',
    seedDirty: false,
    lastProgressWriteMs: 0,
    lastProgressCompleted: 0,
    lastProgressSkipped: 0,
    lastMessage: '正在检查 Python 运行环境。',
    stockPoolSource: stockPool.source
  };

  recomputeSeedCounts(context.seed, context.selectedTotal);
  activeRunContext = context;

  if (selectedStocks.length === 0) {
    context.lastMessage = options.retryFailed
      ? '当前没有 FAILED 关系数据可重试。'
      : '没有可采集的本地股票池，请检查 data/universe/stock-universe.json 或 data/sync/*.json。';
    saveProgress(context, {
      running: false,
      lastMessage: context.lastMessage,
      finishedAt: nowIso()
    }, { force: true });

    if (options.retryFailed) {
      console.log(`[stock-relation] ${context.lastMessage}`);
      return;
    }

    throw new Error(context.lastMessage);
  }

  saveProgress(context, {
    running: true,
    lastMessage: context.lastMessage
  }, { force: true });

  context.pythonPreflight = await runPythonPreflight(pythonResolution);

  if (!context.pythonPreflight.ok) {
    context.lastMessage = buildPythonPreflightError(context.pythonPreflight);
    saveProgress(context, {
      running: false,
      lastMessage: context.lastMessage,
      finishedAt: nowIso()
    }, { force: true });
    console.error(`[stock-relation] ${context.lastMessage}`);
    process.exitCode = 1;
    return;
  }

  context.lastMessage = `Python 预检通过：${context.pythonPreflight.executable || pythonResolution.displayPath}`;
  saveProgress(context, {
    running: true,
    lastMessage: context.lastMessage
  }, { force: true });

  console.log(`[stock-relation] python=${context.pythonPreflight.executable || pythonResolution.displayPath}`);
  console.log(`[stock-relation] start total=${selectedStocks.length} concurrency=${options.concurrency} source=${stockPool.source}`);
  await runWorkerPool(selectedStocks, context);

  context.lastMessage = `采集结束：本次完成 ${context.completed}，新采集 ${context.fetched}，跳过 ${context.skipped}，失败 ${context.failedThisRun}。`;
  saveFinalOutputs(context, {
    running: false,
    lastMessage: context.lastMessage,
    finishedAt: nowIso()
  });
  terminalProgressWritten = true;

  console.log('[stock-relation] final');
  console.log(JSON.stringify({
    total: context.selectedTotal,
    completed: context.completed,
    fetched: context.fetched,
    skipped: context.skipped,
    failedThisRun: context.failedThisRun,
    seedDone: context.seed.done,
    seedFailed: context.seed.failed,
    writeWarnings: writeWarnings.length,
    seedPath: SEED_PATH,
    progressPath: PROGRESS_PATH,
    errorsPath: ERRORS_PATH
  }, null, 2));

  if (context.failedThisRun > 0) {
    process.exitCode = 1;
  }
}

function handleInterrupted(signal) {
  const message = `采集被中断：${signal}`;
  writeTerminalProgress(activeRunContext, message);
  console.error(`[stock-relation] ${message}`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

function handleFatalError(error, source = 'uncaughtException') {
  const message = `采集异常退出：${compactText(error && error.message ? error.message : error, 800)}`;
  writeTerminalProgress(activeRunContext, message);
  console.error(`[stock-relation] ${source}: ${compactText(error && error.stack ? error.stack : error, 1200)}`);
  process.exit(1);
}

if (require.main === module) {
  process.once('SIGINT', () => handleInterrupted('SIGINT'));
  process.once('SIGTERM', () => handleInterrupted('SIGTERM'));
  process.once('uncaughtException', (error) => handleFatalError(error, 'uncaughtException'));
  process.once('unhandledRejection', (reason) => handleFatalError(reason, 'unhandledRejection'));

  main().catch((error) => {
    const message = `采集异常退出：${compactText(error && error.message ? error.message : error, 800)}`;
    writeTerminalProgress(activeRunContext, message);
    console.error(`[stock-relation] failed: ${compactText(error && error.message ? error.message : error, 800)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  buildOptions,
  normalizeCode,
  inferMarket,
  getPythonCommand,
  getPythonResolution,
  runPythonPreflight,
  loadStockPool,
  buildSelectedStocks,
  loadSeed,
  runPythonWorker,
  main
};
