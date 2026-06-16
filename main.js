const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, clipboard } = require('electron');
const { runBacktestForSymbol } = require('./src/core/backtestEngine');
const { runMarketStateForMarket } = require('./src/core/marketStateRunnerService');
const {
  syncMarketIndexDailyBars,
  getMarketIndexOverview,
  getMarketIndexSummary
} = require('./src/data/indexDailyDataService');
const { runStructureCandidatePool } = require('./src/core/structureCandidatePoolService');
const { refreshStockUniverse } = require('./src/data/stockUniverseService');
const {
  listUserSupplyChainPrimaryChains,
  listUserSupplyChainSecondaryChains,
  queryUserSupplyChain,
  searchSupplyChainEditorStocks,
  saveUserSupplyChain,
  deleteUserSupplyChain
} = require('./src/core/supplyChainUserEditService');
const {
  refreshHongKongStockUniverse
} = require('./src/data/hkStockUniverseService');
const {
  syncFullMarketHistory,
  loadSyncState,
  buildProgress,
  getSyncStatePath
} = require('./src/data/fullMarketSyncService');
const {
  buildRelationSummary,
  buildMarketGraphFromSeed,
  loadRelationSeed,
  loadRelationRaw,
  loadFetchRawStatus
} = require('./src/marketGraph/marketGraphBuilder');
const supplyChainSeedService = require('./src/services/marketSupplyChainSeedService');
const {
  getPythonResolution: getMarketGraphPythonResolution,
  runPythonPreflight: runMarketGraphPythonPreflight
} = require('./scripts/fetch-stock-relation-raw');

let activeHongKongSyncProcess = null;
let latestHongKongSyncProgress = null;
let hongKongSyncLogs = [];

let activeFullMarketSyncTask = null;
let activeFullMarketSyncStopSignal = null;
let latestFullMarketSyncProgress = null;

let activeMarketGraphFetchProcess = null;
let activeMarketGraphFetchStarting = false;
let marketGraphFetchLogs = [];
let latestMarketGraphPythonPreflight = null;
const HK_SYNC_SCRIPT = path.join('scripts', 'sync-full-hk.js');
const HK_SYNC_STATE_PATH = path.join(__dirname, 'data', 'sync', 'full-hk-sync-state.json');
const HK_SYNC_LOG_LIMIT = 160;
const MARKET_GRAPH_FETCH_LOG_LIMIT = 200;
const MARKET_GRAPH_FETCH_SCRIPT = path.join('scripts', 'fetch-stock-relation-raw.js');
const APP_DISPLAY_NAME = '形位变股票结构观察器';
const CUSTOM_SERVICE_EMAIL = '532629821@qq.com';
const CUSTOM_SERVICE_WECHAT = 'ks532629821';
const CUSTOM_SERVICE_SUBJECT = '形位变股票结构观察器定制服务咨询';
const MARKET_GRAPH_FETCH_MODE_ARGS = Object.freeze({
  sample5: ['--only=300750,002594,600519,000001,920018', '--concurrency=1', '--force'],
  limit50: ['--limit=50', '--concurrency=2'],
  limit300: ['--limit=300', '--concurrency=2'],
  all: ['--concurrency=2'],
  retryFailed: ['--retry-failed', '--concurrency=2']
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function showMainWindow() {
  const win = getMainWindow();

  if (!win) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.setSkipTaskbar(false);
  win.show();
  win.focus();
}

function ensureTrayReady() {
  if (tray) {
    return tray;
  }

  return createTray();
}

function hideMainWindowToTray() {
  const win = getMainWindow();

  if (!win) {
    return false;
  }

  const activeTray = ensureTrayReady();

  if (!activeTray) {
    // 极端情况下托盘创建失败，也不要让窗口关闭导致程序退出。
    // 至少先缩到任务栏，避免用户以为软件崩了。
    win.setSkipTaskbar(false);

    if (!win.isMinimized()) {
      win.minimize();
    }

    return false;
  }

  win.setSkipTaskbar(true);
  win.hide();
  return true;
}

function quitAppFromMenu() {
  isQuitting = true;
  app.quit();
}

function clickRendererElement(elementId) {
  const win = getMainWindow();

  if (!win || !elementId) {
    return;
  }

  showMainWindow();

  const safeElementId = JSON.stringify(String(elementId));

  win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById(${safeElementId});
      if (el && typeof el.click === 'function') {
        el.click();
        return true;
      }
      return false;
    })();
  `).catch(() => {});
}

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, '32.ico'),
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, 'assets', '32.ico'),
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, 'resources', '32.ico'),
    path.join(__dirname, 'resources', 'icon.ico'),
    path.join(__dirname, 'build', '32.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'renderer', 'assets', '32.ico'),
    path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', '32.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(process.resourcesPath || '', 'assets', '32.ico'),
    path.join(process.resourcesPath || '', 'assets', 'icon.ico')
  ];

  return candidates.find((filePath) => {
    try {
      return filePath && fs.existsSync(filePath);
    } catch (_error) {
      return false;
    }
  }) || '';
}

function createFallbackTrayIcon() {
  const fallbackIconPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAV0lEQVR42mNgoDYQEJX/jw/j1fx1j91/QgbgNASkGYZJNgQmSLYhyILIhhAyDGfAEWsISQZgM4R2BhDrDYKJh5AhRKc+XFFMUhJGN4SsfAAzhHaZiRwAACajJc6N0LpsAAAAAElFTkSuQmCC';

  try {
    return nativeImage.createFromBuffer(Buffer.from(fallbackIconPngBase64, 'base64'));
  } catch (_error) {
    return nativeImage.createEmpty();
  }
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: showMainWindow
    },
    {
      label: '最小化到托盘',
      click: hideMainWindowToTray
    },
    { type: 'separator' },
    {
      label: '开始结构观察',
      click: () => clickRendererElement('runButton')
    },
    {
      label: '刷新指数态',
      click: () => clickRendererElement('marketIndexRefreshButton')
    },
    {
      label: '同步指数',
      click: () => clickRendererElement('marketIndexSyncButton')
    },
    {
      label: '刷新结构候选池',
      click: () => clickRendererElement('structureCandidatePoolRefreshButton')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: quitAppFromMenu
    }
  ]);
}

function createTray() {
  if (tray) {
    return tray;
  }

  const iconPath = resolveAppIconPath();
  let icon = null;

  if (iconPath) {
    icon = nativeImage.createFromPath(iconPath);
  }

  if (!icon || icon.isEmpty()) {
    console.warn(`[tray] app icon not found or invalid, use fallback tray icon. iconPath=${iconPath || '-'}`);
    icon = createFallbackTrayIcon();
  }

  if (!icon || icon.isEmpty()) {
    console.warn('[tray] fallback tray icon invalid, tray disabled.');
    return null;
  }

  tray = new Tray(icon);
  tray.setToolTip('形位变股票市场结构观察器');
  tray.setContextMenu(buildTrayContextMenu());

  tray.on('double-click', () => {
    showMainWindow();
  });

  tray.on('click', () => {
    showMainWindow();
  });

  return tray;
}

function openAboutWindow() {
  const parentWindow = getMainWindow();
  const aboutWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    title: `关于 ${APP_DISPLAY_NAME}`,
    parent: parentWindow || undefined,
    modal: false,
    show: false,
    backgroundColor: '#10151f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });

  aboutWindow.setMenu(null);
  aboutWindow.loadFile(path.join(__dirname, 'renderer', 'about.html'));
}

async function showCustomServiceDialog() {
  const parentWindow = getMainWindow();

  const detail = [
    '可定制内容：',
    '',
    '1. 主题图谱包：指定概念、题材、产业主题的关系图整理。',
    '2. 深度行业图谱包：按上游、中游、下游、终端应用整理产业链。',
    '3. 指定股票池定制：围绕用户指定股票池生成关系图和产业链图。',
    '4. 港股 / A 股结构数据整理：补充关系、产业链、节点说明。',
    '5. 软件功能定制：界面、筛选器、导出、私有版本等按工作量报价。',
    '',
    '参考报价：',
    '主题图谱包：99 / 199 起',
    '深度行业图谱包：299 / 599 起',
    '指定股票池定制：499 起',
    '功能定制：按工作量报价',
    '',
    `联系邮箱：${CUSTOM_SERVICE_EMAIL}`,
    `微信号：${CUSTOM_SERVICE_WECHAT}`,
    '',
    '说明：开源版本免费使用，定制服务只针对额外数据整理、图谱整理和功能开发。'
  ].join('\n');

  const result = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'info',
    title: '定制服务',
    message: '形位变定制服务',
    detail,
    buttons: ['复制联系方式', '打开邮件', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });

  if (result.response === 0) {
    clipboard.writeText(`邮箱：${CUSTOM_SERVICE_EMAIL}\n微信：${CUSTOM_SERVICE_WECHAT}`);
  }

  if (result.response === 1) {
    const mailto = `mailto:${CUSTOM_SERVICE_EMAIL}?subject=${encodeURIComponent(CUSTOM_SERVICE_SUBJECT)}`;
    shell.openExternal(mailto);
  }
}

function openRendererModal(modalType) {
  const win = getMainWindow();

  if (!win) {
    return;
  }

  showMainWindow();

  win.webContents.send('app-menu:open-modal', {
    type: modalType
  });
}

function createAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '显示主窗口',
          accelerator: 'Ctrl+Shift+O',
          click: showMainWindow
        },
        {
          label: '最小化到托盘',
          accelerator: 'Ctrl+M',
          click: hideMainWindowToTray
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Ctrl+Q',
          click: quitAppFromMenu
        }
      ]
    },
    {
      label: '结构',
      submenu: [
        {
          label: '开始结构观察',
          accelerator: 'Ctrl+Enter',
          click: () => clickRendererElement('runButton')
        },
        {
          label: '刷新结构候选池',
          click: () => clickRendererElement('structureCandidatePoolRefreshButton')
        }
      ]
    },
    {
      label: '市场',
      submenu: [
        {
          label: '刷新市场态总览',
          click: () => clickRendererElement('marketStateOverviewRefreshButton')
        },
        {
          label: '刷新指数态',
          click: () => clickRendererElement('marketIndexRefreshButton')
        },
        {
          label: '同步指数',
          click: () => clickRendererElement('marketIndexSyncButton')
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'Ctrl+R',
          role: 'reload'
        },
        {
          label: '开发者工具',
          accelerator: 'F12',
          role: 'toggleDevTools'
        },
        { type: 'separator' },
        {
          label: '放大',
          role: 'zoomIn'
        },
        {
          label: '缩小',
          role: 'zoomOut'
        },
        {
          label: '重置缩放',
          role: 'resetZoom'
        }
      ]
    },
{
  label: '关于我',
  click: () => openRendererModal('about')
},
{
  label: '定制服务',
  click: () => openRendererModal('customService')
}
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function appendMarketGraphFetchLog(source, value) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    marketGraphFetchLogs.push(`[${source}] ${line}`);
  }

  if (marketGraphFetchLogs.length > MARKET_GRAPH_FETCH_LOG_LIMIT) {
    marketGraphFetchLogs = marketGraphFetchLogs.slice(-MARKET_GRAPH_FETCH_LOG_LIMIT);
  }
}

function buildMarketGraphFetchEnv() {
  const env = {
    ...process.env
  };

  [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
  ].forEach((key) => {
    delete env[key];
  });

  if (process.env.XWB_PYTHON) {
    env.XWB_PYTHON = process.env.XWB_PYTHON;
  }

  if (process.env.PYTHON) {
    env.PYTHON = process.env.PYTHON;
  }

  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveMarketGraphPython() {
  return getMarketGraphPythonResolution({
    projectRoot: __dirname,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
}

function normalizeMarketGraphFetchProgress(rawProgress, seedSummary) {
  const progress = rawProgress && typeof rawProgress === 'object' ? rawProgress : {};
  const seed = seedSummary || {};

  return {
    total: toFiniteNumber(progress.total, toFiniteNumber(seed.total, 0)),
    done: toFiniteNumber(progress.completed ?? progress.done, 0),
    failed: toFiniteNumber(progress.failedThisRun ?? progress.failed, 0),
    skipped: toFiniteNumber(progress.skipped, 0),
    current: progress.current ? String(progress.current) : '',
    updatedAt: progress.updatedAt ? String(progress.updatedAt) : ''
  };
}

function normalizeMarketGraphPythonPreflight(rawProgress) {
  const progress = rawProgress && typeof rawProgress === 'object' ? rawProgress : {};
  const fromProgress = progress.pythonPreflight && typeof progress.pythonPreflight === 'object'
    ? progress.pythonPreflight
    : null;
  const latest = latestMarketGraphPythonPreflight && typeof latestMarketGraphPythonPreflight === 'object'
    ? latestMarketGraphPythonPreflight
    : null;
  const source = latest || fromProgress || {};
  const selectedPython = progress.selectedPython || source.selectedPython || resolveMarketGraphPython().displayPath;

  return {
    status: source.status || 'not_checked',
    ok: source.ok === true,
    selectedPython,
    resolverSource: source.resolverSource || progress.pythonResolverSource || '',
    executable: source.executable || '',
    error: source.error || '',
    stderr: source.stderr || '',
    checkedAt: source.checkedAt || ''
  };
}

function buildMarketGraphSeedSummary() {
  const seed = loadRelationSeed();

  return {
    total: Number(seed.total) || 0,
    done: Number(seed.done) || 0,
    failed: Number(seed.failed) || 0
  };
}

function normalizeMarketGraphFetchErrors(rawErrors) {
  const payload = rawErrors && typeof rawErrors === 'object' ? rawErrors : {};
  const items = Array.isArray(payload.items)
    ? payload.items
    : Object.values(payload.items || {});

  return {
    total: Number(payload.total) || items.length,
    updatedAt: payload.updatedAt || '',
    items: items.map((item) => ({
      code: item && item.code ? String(item.code) : '',
      name: item && item.name ? String(item.name) : '',
      market: item && item.market ? String(item.market) : '',
      stage: item && item.stage ? String(item.stage) : 'relation',
      error: item && item.error ? String(item.error) : ''
    }))
  };
}

function formatMarketGraphFetchExit(code, signal) {
  return `code=${code === null || code === undefined ? '-' : code} signal=${signal || '-'}`;
}

function writeMarketGraphProgressFile(progressPath, progress) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

function patchMarketGraphProgressAfterChildClose(code, signal) {
  try {
    const rawStatus = loadFetchRawStatus();
    const progress = rawStatus.progress && typeof rawStatus.progress === 'object'
      ? rawStatus.progress
      : null;

    if (!progress || !progress.running) {
      return {
        processExited: true,
        staleRunning: false
      };
    }

    const now = new Date().toISOString();
    const nextProgress = {
      ...progress,
      running: false,
      processExited: true,
      staleRunning: true,
      updatedAt: now,
      finishedAt: now,
      lastMessage: `采集进程已退出：${formatMarketGraphFetchExit(code, signal)}`
    };

    const progressPath = rawStatus.paths && rawStatus.paths.progressPath
      ? rawStatus.paths.progressPath
      : path.join(__dirname, 'data', 'market-graph', 'stock-relation-progress.json');

    writeMarketGraphProgressFile(progressPath, nextProgress);
    appendMarketGraphFetchLog('main', 'progress running=false after child exit');

    return {
      processExited: true,
      staleRunning: true
    };
  } catch (error) {
    appendMarketGraphFetchLog('main', `progress patch failed: ${error && error.message ? error.message : error}`);
    return {
      processExited: true,
      staleRunning: false
    };
  }
}

function getMarketGraphFetchRelationStatus() {
  const rawStatus = loadFetchRawStatus();
  const seedSummary = buildMarketGraphSeedSummary();
  const running = Boolean(activeMarketGraphFetchStarting || (activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child));
  const progressRunning = Boolean(rawStatus.progress && rawStatus.progress.running);
  const staleRunning = Boolean(progressRunning && !running);
  const processExited = Boolean(staleRunning || (rawStatus.progress && rawStatus.progress.processExited));
  const pythonPreflight = normalizeMarketGraphPythonPreflight(rawStatus.progress);

  return {
    running,
    staleRunning,
    processExited,
    pid: activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child
      ? activeMarketGraphFetchProcess.child.pid
      : null,
    progress: normalizeMarketGraphFetchProgress(rawStatus.progress, seedSummary),
    seedSummary,
    selectedPython: pythonPreflight.selectedPython,
    pythonPreflight,
    logs: marketGraphFetchLogs.slice(-MARKET_GRAPH_FETCH_LOG_LIMIT),
    seedExists: Boolean(rawStatus.seedExists),
    progressExists: Boolean(rawStatus.progressExists),
    checkedAt: rawStatus.checkedAt || new Date().toISOString()
  };
}

async function startMarketGraphFetchRelation(payload) {
  if (activeMarketGraphFetchStarting || (activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child)) {
    return {
      alreadyRunning: true,
      status: getMarketGraphFetchRelationStatus()
    };
  }

  const mode = String(payload && payload.mode || '').trim();
  const modeArgs = MARKET_GRAPH_FETCH_MODE_ARGS[mode];

  if (!modeArgs) {
    throw new Error(`不支持的关系采集模式：${mode || '-'}`);
  }

  activeMarketGraphFetchStarting = true;
  const pythonResolution = resolveMarketGraphPython();
  latestMarketGraphPythonPreflight = {
    status: 'checking',
    ok: false,
    selectedPython: pythonResolution.displayPath,
    resolverSource: pythonResolution.source,
    executable: '',
    error: '',
    stderr: '',
    checkedAt: new Date().toISOString()
  };
  appendMarketGraphFetchLog('main', `正在检查 Python：${latestMarketGraphPythonPreflight.selectedPython}`);

  try {
    latestMarketGraphPythonPreflight = await runMarketGraphPythonPreflight(pythonResolution);
  } catch (error) {
    latestMarketGraphPythonPreflight = {
      ...latestMarketGraphPythonPreflight,
      status: 'failed',
      ok: false,
      error: error && error.message ? error.message : String(error),
      checkedAt: new Date().toISOString()
    };
  }

  if (!latestMarketGraphPythonPreflight.ok) {
    activeMarketGraphFetchStarting = false;
    appendMarketGraphFetchLog('main', `Python 预检失败：${latestMarketGraphPythonPreflight.error || '未知错误'}`);
    throw new Error(`Python 预检失败：${latestMarketGraphPythonPreflight.error || '请确认当前 Python 已安装 adata'}`);
  }

  appendMarketGraphFetchLog(
    'main',
    `Python 预检通过：${latestMarketGraphPythonPreflight.executable || latestMarketGraphPythonPreflight.selectedPython}`
  );

  const args = [
    MARKET_GRAPH_FETCH_SCRIPT,
    ...modeArgs
  ];
  let child = null;

  try {
    child = spawn('node', args, {
      cwd: __dirname,
      windowsHide: true,
      shell: false,
      env: buildMarketGraphFetchEnv()
    });
  } catch (error) {
    activeMarketGraphFetchStarting = false;
    throw error;
  }

  activeMarketGraphFetchProcess = {
    child,
    mode,
    startedAt: new Date().toISOString()
  };
  activeMarketGraphFetchStarting = false;
  appendMarketGraphFetchLog('main', `start mode=${mode} pid=${child.pid || '-'} args=${args.join(' ')}`);

  child.stdout.on('data', (chunk) => {
    appendMarketGraphFetchLog('stdout', chunk);
  });

  child.stderr.on('data', (chunk) => {
    appendMarketGraphFetchLog('stderr', chunk);
  });

  child.on('error', (error) => {
    appendMarketGraphFetchLog('error', error && error.message ? error.message : error);

    if (activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child === child) {
      activeMarketGraphFetchProcess = null;
    }
  });

  child.on('close', (code, signal) => {
    appendMarketGraphFetchLog('main', `exit mode=${mode} code=${code === null ? '-' : code} signal=${signal || '-'}`);

    if (activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child === child) {
      patchMarketGraphProgressAfterChildClose(code, signal);
      activeMarketGraphFetchProcess = null;
    }
  });

  return {
    alreadyRunning: false,
    status: getMarketGraphFetchRelationStatus()
  };
}

function stopMarketGraphFetchRelation() {
  if (!activeMarketGraphFetchProcess || !activeMarketGraphFetchProcess.child) {
    return getMarketGraphFetchRelationStatus();
  }

  const child = activeMarketGraphFetchProcess.child;
  appendMarketGraphFetchLog('main', `stop requested pid=${child.pid || '-'}`);
  child.kill();
  return getMarketGraphFetchRelationStatus();
}

function getSafeTimestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quotePowerShellLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function runPowerShellExpandArchive(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    const command = [
      'Expand-Archive',
      '-LiteralPath',
      quotePowerShellLiteral(zipPath),
      '-DestinationPath',
      quotePowerShellLiteral(outputDir),
      '-Force'
    ].join(' ');

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      {
        windowsHide: true,
        shell: false
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
        return;
      }

      reject(new Error(`数据包解压失败，code=${code}，${stderr || stdout || '无错误输出'}`));
    });
  });
}

function removeSqliteSidecarFiles(cacheDir) {
  if (!fs.existsSync(cacheDir)) {
    return [];
  }

  const removed = [];

  fs.readdirSync(cacheDir).forEach((name) => {
    if (!name.endsWith('.sqlite-wal') && !name.endsWith('.sqlite-shm')) {
      return;
    }

    const filePath = path.join(cacheDir, name);
    fs.rmSync(filePath, {
      force: true
    });
    removed.push(filePath);
  });

  return removed;
}

function copyPathIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(targetPath), {
    recursive: true
  });

  const stat = fs.statSync(sourcePath);

  if (stat.isDirectory()) {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true
    });
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true
    });
  } else {
    fs.copyFileSync(sourcePath, targetPath);
  }

  return true;
}

function findExtractedDataRoot(extractRoot) {
  const directDataRoot = path.join(extractRoot, 'data');

  if (fs.existsSync(directDataRoot)) {
    return directDataRoot;
  }

  const children = fs.readdirSync(extractRoot, {
    withFileTypes: true
  });

  for (const child of children) {
    if (!child.isDirectory()) {
      continue;
    }

    const nestedDataRoot = path.join(extractRoot, child.name, 'data');

    if (fs.existsSync(nestedDataRoot)) {
      return nestedDataRoot;
    }
  }

  return '';
}

function assertNoDataPackImportConflict() {
  if (activeFullMarketSyncTask && latestFullMarketSyncProgress && latestFullMarketSyncProgress.running) {
    throw new Error('A 股同步正在运行，请先停止同步后再导入数据包。');
  }

  if (activeHongKongSyncProcess && activeHongKongSyncProcess.child) {
    throw new Error('港股同步正在运行，请先停止同步后再导入数据包。');
  }

  if (activeMarketGraphFetchProcess && activeMarketGraphFetchProcess.child) {
    throw new Error('关系图采集正在运行，请先停止采集后再导入数据包。');
  }
}

function backupCurrentDataBeforeImport(targetDataRoot) {
  const backupRoot = path.join(
    targetDataRoot,
    'backups',
    `data-pack-import-${getSafeTimestampForFile()}`
  );

  const backupItems = [];

  const currentDb = path.join(targetDataRoot, 'cache', 'ashare-cache.sqlite');
  const currentUniverse = path.join(targetDataRoot, 'universe');
  const currentMarketGraph = path.join(targetDataRoot, 'market-graph');

  if (copyPathIfExists(currentDb, path.join(backupRoot, 'data', 'cache', 'ashare-cache.sqlite'))) {
    backupItems.push('data/cache/ashare-cache.sqlite');
  }

  if (copyPathIfExists(currentUniverse, path.join(backupRoot, 'data', 'universe'))) {
    backupItems.push('data/universe');
  }

  [
    'cross-market-relation.seed.json',
    'cross-market-supply-chain.seed.json',
    'stock-relation-raw.seed.json'
  ].forEach((fileName) => {
    const sourcePath = path.join(currentMarketGraph, fileName);
    const targetPath = path.join(backupRoot, 'data', 'market-graph', fileName);

    if (copyPathIfExists(sourcePath, targetPath)) {
      backupItems.push(`data/market-graph/${fileName}`);
    }
  });

  return {
    backupRoot,
    backupItems
  };
}

async function importDataPackFromZip(zipPath) {
  assertNoDataPackImportConflict();

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error('数据包文件不存在。');
  }

  if (!String(zipPath).toLowerCase().endsWith('.zip')) {
    throw new Error('请选择 zip 格式的数据包。');
  }

  const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'xwb-data-pack-import-'));

  try {
    await runPowerShellExpandArchive(zipPath, tempRoot);

    const sourceDataRoot = findExtractedDataRoot(tempRoot);

    if (!sourceDataRoot) {
      throw new Error('数据包格式错误：找不到 data 目录。');
    }

    const sourceDb = path.join(sourceDataRoot, 'cache', 'ashare-cache.sqlite');

    if (!fs.existsSync(sourceDb)) {
      throw new Error('数据包格式错误：找不到 data/cache/ashare-cache.sqlite。');
    }

    const targetDataRoot = path.join(__dirname, 'data');
    const targetCacheDir = path.join(targetDataRoot, 'cache');
    const targetDb = path.join(targetCacheDir, 'ashare-cache.sqlite');
    const targetUniverse = path.join(targetDataRoot, 'universe');
    const targetMarketGraph = path.join(targetDataRoot, 'market-graph');

    fs.mkdirSync(targetCacheDir, {
      recursive: true
    });
    fs.mkdirSync(targetMarketGraph, {
      recursive: true
    });

    const backup = backupCurrentDataBeforeImport(targetDataRoot);

    removeSqliteSidecarFiles(targetCacheDir);

    fs.copyFileSync(sourceDb, targetDb);

    const importedItems = [
      'data/cache/ashare-cache.sqlite'
    ];

    const sourceUniverse = path.join(sourceDataRoot, 'universe');

    if (fs.existsSync(sourceUniverse)) {
      fs.rmSync(targetUniverse, {
        recursive: true,
        force: true
      });
      fs.cpSync(sourceUniverse, targetUniverse, {
        recursive: true,
        force: true
      });
      importedItems.push('data/universe');
    }

    [
      'cross-market-relation.seed.json',
      'cross-market-supply-chain.seed.json',
      'stock-relation-raw.seed.json'
    ].forEach((fileName) => {
      const sourcePath = path.join(sourceDataRoot, 'market-graph', fileName);
      const targetPath = path.join(targetMarketGraph, fileName);

      if (!fs.existsSync(sourcePath)) {
        return;
      }

      fs.copyFileSync(sourcePath, targetPath);
      importedItems.push(`data/market-graph/${fileName}`);
    });

    removeSqliteSidecarFiles(targetCacheDir);

    return {
      zipPath,
      dataRoot: targetDataRoot,
      backupPath: backup.backupRoot,
      backupItems: backup.backupItems,
      importedItems,
      importedAt: new Date().toISOString()
    };
  } finally {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true
    });
  }
}

function compactErrorMessage(error) {
  const message = error && error.message ? error.message : String(error);
  const clean = String(message || '未知错误').replace(/\s+/g, ' ').trim();

  if (clean.length <= 300) {
    return clean;
  }

  return `${clean.slice(0, 300)}...`;
}

function getSavedFullMarketSyncProgress(message) {
  return buildProgress({
    state: loadSyncState(),
    statePath: getSyncStatePath(),
    lastMessage: message || ''
  });
}

function normalizeSymbolsForProgress(symbols) {
  if (Array.isArray(symbols)) {
    return symbols
      .flatMap((item) => String(item || '').split(/[,，\s]+/))
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.padStart(6, '0'));
  }

  return String(symbols || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.padStart(6, '0'));
}

function buildFreshFullMarketStartProgress(input, concurrency) {
  const payload = input || {};
  const symbols = normalizeSymbolsForProgress(payload.symbols);
  const mode = symbols.length > 0
    ? 'symbols'
    : String(payload.mode || 'full').trim().toLowerCase();

  let total = 0;

  if (mode === 'symbols') {
    total = symbols.length;
  } else if (mode === 'current') {
    total = payload.currentSymbol ? 1 : 0;
  } else {
    const maxCount = Number(payload.maxCount);
    total = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 0;
  }

  return {
    running: true,
    total,
    done: 0,
    skipped: 0,
    failed: 0,
    completed: 0,
    concurrency,
    activeWorkers: 0,
    runningSymbols: [],
    currentIndex: 0,
    currentSymbol: '',
    currentName: '',
    currentStatus: 'STARTING',
    elapsedMs: 0,
    avgCostMs: 0,
    estimatedRemainingMs: 0,
    percent: 0,
    lastMessage: '同步任务准备启动。',
    recentMessages: [],
    statePath: getSyncStatePath(),
    mode,
    symbols,
    markets: Array.isArray(payload.markets) ? payload.markets : [],
    maxCount: Number(payload.maxCount) || 0
  };
}

function getCurrentFullMarketSyncProgress(message) {
  if (latestFullMarketSyncProgress) {
    return message
      ? {
        ...latestFullMarketSyncProgress,
        lastMessage: message
      }
      : latestFullMarketSyncProgress;
  }

  return getSavedFullMarketSyncProgress(message);
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function getTodayDateText() {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  return `${y}${m}${d}`;
}

function normalizeDateText(value, fallback) {
  const text = String(value || fallback || '').trim().replace(/-/g, '');

  if (/^\d{8}$/.test(text)) {
    return text;
  }

  return fallback;
}

function appendHongKongSyncLog(source, value) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    hongKongSyncLogs.push(`[${source}] ${line}`);
  }

  if (hongKongSyncLogs.length > HK_SYNC_LOG_LIMIT) {
    hongKongSyncLogs = hongKongSyncLogs.slice(-HK_SYNC_LOG_LIMIT);
  }
}

function buildHongKongSyncArgs(payload, concurrency) {
  const input = payload || {};
  const startDate = normalizeDateText(input.startDate, '20180101');
  const endDate = normalizeDateText(input.endDate, getTodayDateText());
  const force = Boolean(input.force);
  const maxCount = Number(input.maxCount) || 0;
  const symbols = Array.isArray(input.symbols)
    ? input.symbols.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const args = [
    HK_SYNC_SCRIPT,
    `--start=${startDate}`,
    `--end=${endDate}`,
    `--concurrency=${concurrency}`,
    `--force=${force ? 'true' : 'false'}`
  ];

  if (maxCount > 0) {
    args.push(`--max=${Math.floor(maxCount)}`);
  }

  if (input.refreshList) {
    args.push('--refresh-list');
  }

  if (symbols.length > 0) {
    args.push('--symbols', ...symbols);
  }

  return args;
}

function loadHongKongSyncState() {
  return readJsonFileSafe(HK_SYNC_STATE_PATH, {
    version: 'dev-0.1.9.1',
    market: 'HK',
    running: false,
    startedAt: '',
    finishedAt: '',
    total: 0,
    done: 0,
    skipped: 0,
    noDailyBars: 0,
    failed: 0,
    items: {},
    lastError: ''
  });
}

function buildHongKongSyncProgress(message) {
  const state = loadHongKongSyncState();
  const items = Object.values(state.items || {});
  const runningItems = items.filter((item) => item.status === 'RUNNING');
  const currentItem = runningItems[0] || items.find((item) => item.status === 'FAILED') || items[items.length - 1] || {};
  const done = Number(state.done) || items.filter((item) => item.status === 'DONE').length;
  const skipped = Number(state.skipped) || items.filter((item) => item.status === 'SKIPPED').length;
  const noDailyBars = Number(state.noDailyBars) || items.filter((item) => item.status === 'NO_DAILY_BARS').length;
  const failed = Number(state.failed) || items.filter((item) => item.status === 'FAILED').length;
  const total = Number(state.total) || items.length;
  const completed = done + skipped + noDailyBars + failed;
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : Date.now();
  const finishedAtMs = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  const elapsedMs = Math.max(0, (state.running ? Date.now() : finishedAtMs) - startedAtMs);
  const avgCostMs = completed > 0 ? elapsedMs / completed : 0;
  const remaining = Math.max(0, total - completed);
  const estimatedRemainingMs = state.running && avgCostMs > 0 ? remaining * avgCostMs : 0;
  const latestLog = hongKongSyncLogs.length > 0 ? hongKongSyncLogs[hongKongSyncLogs.length - 1] : '';

  return {
    running: Boolean(state.running || activeHongKongSyncProcess),
    market: 'HK',
    total,
    done,
    skipped,
    noDailyBars,
    failed,
    completed,
    concurrency: 0,
    activeWorkers: runningItems.length,
    runningSymbols: runningItems.map((item) => item.symbol),
    currentIndex: completed,
    currentSymbol: currentItem.symbol || '',
    currentName: currentItem.name || '',
    currentStatus: state.running || activeHongKongSyncProcess
      ? 'RUNNING'
      : failed > 0
        ? 'DONE_WITH_FAILED'
        : 'DONE',
    elapsedMs,
    avgCostMs,
    estimatedRemainingMs,
    percent: total > 0 ? Math.min(100, (completed / total) * 100) : 0,
    lastMessage: message || latestLog || state.lastError || '港股同步状态已读取。',
    recentMessages: hongKongSyncLogs.slice(-12),
    statePath: HK_SYNC_STATE_PATH,
    mode: 'hk_full',
    symbols: [],
    markets: ['HK'],
    maxCount: 0
  };
}

function getCurrentHongKongSyncProgress(message) {
  if (latestHongKongSyncProgress) {
    return message
      ? {
        ...latestHongKongSyncProgress,
        lastMessage: message
      }
      : latestHongKongSyncProgress;
  }

  return buildHongKongSyncProgress(message);
}

function startHongKongSync(payload) {
  if (activeHongKongSyncProcess) {
    return getCurrentHongKongSyncProgress('港股同步已经在运行。');
  }

  const input = payload || {};
  const requestedConcurrency = Number(input.concurrency);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.min(8, Math.max(1, Math.floor(requestedConcurrency)))
    : 3;
  const args = buildHongKongSyncArgs(input, concurrency);

  hongKongSyncLogs = [];
  appendHongKongSyncLog('main', `start pid=- args=${args.join(' ')}`);

  const child = spawn('node', args, {
    cwd: __dirname,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      NO_PROXY: '*',
      no_proxy: '*'
    }
  });

  activeHongKongSyncProcess = {
    child,
    startedAt: new Date().toISOString()
  };

  latestHongKongSyncProgress = buildHongKongSyncProgress('港股同步任务已启动。');

  child.stdout.on('data', (chunk) => {
    appendHongKongSyncLog('stdout', chunk);
    latestHongKongSyncProgress = buildHongKongSyncProgress();
  });

  child.stderr.on('data', (chunk) => {
    appendHongKongSyncLog('stderr', chunk);
    latestHongKongSyncProgress = buildHongKongSyncProgress();
  });

  child.on('error', (error) => {
    appendHongKongSyncLog('error', compactErrorMessage(error));
    latestHongKongSyncProgress = {
      ...buildHongKongSyncProgress(compactErrorMessage(error)),
      running: false,
      currentStatus: 'FAILED',
      failed: (latestHongKongSyncProgress && latestHongKongSyncProgress.failed) || 1
    };
    activeHongKongSyncProcess = null;
  });

  child.on('close', (code) => {
    appendHongKongSyncLog('main', `exit code=${code}`);
    activeHongKongSyncProcess = null;
    latestHongKongSyncProgress = buildHongKongSyncProgress(code === 0 ? '港股同步完成。' : `港股同步退出，code=${code}`);
  });

  return latestHongKongSyncProgress;
}

function stopHongKongSync() {
  if (activeHongKongSyncProcess && activeHongKongSyncProcess.child) {
    appendHongKongSyncLog('main', `stop requested pid=${activeHongKongSyncProcess.child.pid || '-'}`);
    activeHongKongSyncProcess.child.kill();
    const progress = buildHongKongSyncProgress('已请求停止港股同步。');

    latestHongKongSyncProgress = {
      ...progress,
      currentStatus: 'STOPPING'
    };

    return latestHongKongSyncProgress;
  }

  return buildHongKongSyncProgress('当前没有港股同步任务。');
}

function startFullMarketSync(payload) {
  if (activeFullMarketSyncTask && latestFullMarketSyncProgress && latestFullMarketSyncProgress.running) {
    return latestFullMarketSyncProgress;
  }

  const input = payload || {};
  const requestedConcurrency = Number(input.concurrency);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.min(3, Math.max(1, Math.floor(requestedConcurrency)))
    : 1;

  activeFullMarketSyncStopSignal = {
    requested: false
  };

  latestFullMarketSyncProgress = buildFreshFullMarketStartProgress(input, concurrency);

  activeFullMarketSyncTask = syncFullMarketHistory(
    {
      ...input,
      concurrency,
      stopSignal: activeFullMarketSyncStopSignal
    },
    (progress) => {
      latestFullMarketSyncProgress = progress;
    }
  )
    .then((progress) => {
      latestFullMarketSyncProgress = progress;
      return progress;
    })
    .catch((error) => {
      latestFullMarketSyncProgress = {
        ...(latestFullMarketSyncProgress || buildFreshFullMarketStartProgress(input, concurrency)),
        running: false,
        currentStatus: 'FAILED',
        activeWorkers: 0,
        runningSymbols: [],
        lastMessage: compactErrorMessage(error)
      };
      return latestFullMarketSyncProgress;
    })
    .finally(() => {
      activeFullMarketSyncTask = null;
      activeFullMarketSyncStopSignal = null;
    });

  return latestFullMarketSyncProgress;
}

function normalizePositiveInteger(value, fallback, max = Number.POSITIVE_INFINITY) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }

  return Math.min(max, Math.floor(num));
}

function createMainWindow() {
  const appIconPath = resolveAppIconPath();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: APP_DISPLAY_NAME,
    icon: appIconPath || undefined,
    backgroundColor: '#10151f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  mainWindow = win;

  if (typeof win.setBackgroundColor === 'function') {
  win.setBackgroundColor('#10151f');
}

  // 关键：先最大化，再加载页面，避免 1440x900 首帧白块。
  win.maximize();

  win.once('ready-to-show', () => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.show();
      }
    }, 120);
  });

  win.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    // 关键：先拦截关闭。
    // 不能等托盘创建成功后再 preventDefault，否则托盘图标异常时会直接退出。
    event.preventDefault();
    hideMainWindowToTray();
  });

  win.on('show', () => {
    win.setSkipTaskbar(false);
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('backtest:run', async (_event, payload) => {
  try {
    const result = await runBacktestForSymbol(payload || {});
    return {
      ok: true,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-state:run', async (_event, payload) => {
  try {
    const result = await runMarketStateForMarket(payload || {});

    return {
      ok: Boolean(result && result.ok),
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-index:overview', async (_event, payload) => {
  try {
    const result = await getMarketIndexOverview(payload || {});
    return {
      ok: true,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-index:sync', async (_event, payload) => {
  try {
    const result = await syncMarketIndexDailyBars(payload || {});
    return {
      ok: Boolean(result && result.ok),
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-index:summary', async (_event, payload) => {
  try {
    const result = await getMarketIndexSummary(payload || {});
    return {
      ok: true,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('structure-candidates:run', async (_event, payload) => {
  try {
    const result = await runStructureCandidatePool(payload || {});

    return {
      ok: Boolean(result && result.ok),
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('prediction:node-run', async (_event, payload) => {
  try {
    const input = payload || {};
    const params = input.params && typeof input.params === 'object' ? input.params : {};
    const result = await runBacktestForSymbol({
      ...params,
      symbol: input.symbol,
      startDate: input.startDate,
      endDate: input.endDate,
      clickedDate: input.clickedDate,
      refresh: Boolean(input.refresh),
      cacheOnly: Boolean(input.cacheOnly),
      sourceMode: input.sourceMode || ''
    });

    return {
      ok: true,
      symbol: result.symbol,
      market: result.market || '',
      displaySymbol: result.displaySymbol || result.symbol,
      currency: result.currency || '',
      exchange: result.exchange || '',
      selectedNodeDate: result.selectedNodeDate,
      barStart: result.barStart,
      barEnd: result.barEnd,
      barCount: result.barCount,
      nodePredictionAnalysis: result.nodePredictionAnalysis,
      latestPrediction: result.predictionAnalysis && result.predictionAnalysis.latestPrediction
        ? result.predictionAnalysis.latestPrediction
        : null
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:universe-refresh', async () => {
  try {
    const universe = await refreshStockUniverse();

    return {
      ok: true,
      total: universe.stocks.length,
      source: universe.source,
      updatedAt: universe.updatedAt
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:full-market-start', async (_event, payload) => {
  try {
    const progress = startFullMarketSync(payload || {});

    return {
      ok: true,
      progress
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:full-market-status', async () => {
  try {
    return {
      ok: true,
      progress: getCurrentFullMarketSyncProgress()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:full-market-stop', async () => {
  try {
    if (activeFullMarketSyncStopSignal) {
      activeFullMarketSyncStopSignal.requested = true;
    }

    const progress = getCurrentFullMarketSyncProgress('已请求停止，同步会在当前股票处理完后退出。');

    return {
      ok: true,
      progress: {
        ...progress,
        currentStatus: progress.running ? 'STOPPING' : progress.currentStatus
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:hk-universe-refresh', async (_event, payload) => {
  try {
    const universe = await refreshHongKongStockUniverse({
      networkMode: payload && payload.networkMode || 'direct'
    });

    return {
      ok: true,
      total: universe.stocks.length,
      rawCount: universe.rawCount || universe.stocks.length,
      source: universe.source,
      updatedAt: universe.updatedAt,
      path: universe.path || ''
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:hk-start', async (_event, payload) => {
  try {
    const progress = startHongKongSync(payload || {});

    return {
      ok: true,
      progress
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:hk-status', async () => {
  try {
    return {
      ok: true,
      progress: getCurrentHongKongSyncProgress()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('sync:hk-stop', async () => {
  try {
    return {
      ok: true,
      progress: stopHongKongSync()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('data-pack:import', async (event) => {
  try {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parentWindow || undefined, {
      title: '选择形位变数据包',
      properties: ['openFile'],
      filters: [
        {
          name: '形位变数据包',
          extensions: ['zip']
        }
      ]
    });

    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return {
        ok: false,
        canceled: true
      };
    }

    const importResult = await importDataPackFromZip(result.filePaths[0]);

    return {
      ok: true,
      ...importResult
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:relation-summary', async () => {
  try {
    return {
      ok: true,
      summary: buildRelationSummary()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:relation-raw', async (_event, payload) => {
  try {
    return {
      ok: true,
      raw: loadRelationRaw(payload || {})
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:graph', async (_event, payload) => {
  try {
    return {
      ok: true,
      graph: buildMarketGraphFromSeed(payload || {})
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:sample-graph', async (_event, payload) => {
  try {
    const input = payload || {};
    const limit = normalizePositiveInteger(input.limit, 50, 500);

    return {
      ok: true,
      graph: buildMarketGraphFromSeed({
        ...input,
        limit
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:fetch-relation-start', async (_event, payload) => {
  try {
    const result = await startMarketGraphFetchRelation(payload || {});

    return {
      ok: true,
      alreadyRunning: result.alreadyRunning,
      status: result.status
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error),
      status: getMarketGraphFetchRelationStatus()
    };
  }
});

ipcMain.handle('market-graph:fetch-relation-status', async () => {
  try {
    return {
      ok: true,
      status: getMarketGraphFetchRelationStatus()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:fetch-relation-stop', async () => {
  try {
    return {
      ok: true,
      status: stopMarketGraphFetchRelation()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:fetch-relation-errors', async () => {
  try {
    return {
      ok: true,
      errors: normalizeMarketGraphFetchErrors(loadFetchRawStatus().errors)
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('market-graph:fetch-raw-status', async () => {
  try {
    return {
      ok: true,
      status: {
        ...loadFetchRawStatus(),
        relationFetch: getMarketGraphFetchRelationStatus()
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-user:primary', async () => {
  try {
    return listUserSupplyChainPrimaryChains();
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-user:secondary', async (_event, payload) => {
  try {
    return listUserSupplyChainSecondaryChains(payload || {});
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-user:query', async (_event, payload) => {
  try {
    return queryUserSupplyChain(payload || {});
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-user:save', async (_event, payload) => {
  try {
    return saveUserSupplyChain(payload || {});
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-user:delete', async (_event, payload) => {
  try {
    return deleteUserSupplyChain(payload || {});
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain-editor:search-stocks', async (_event, payload) => {
  try {
    return await searchSupplyChainEditorStocks(payload || {});
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:summary', async () => {
  try {
    return {
      ok: true,
      summary: supplyChainSeedService.getSupplyChainSummary()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:list-primary-chains', async () => {
  try {
    return {
      ok: true,
      chains: supplyChainSeedService.listPrimaryChains()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:list-secondary-chains', async (_event, payload) => {
  try {
    return {
      ok: true,
      result: supplyChainSeedService.listSecondaryChains(payload || {})
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:query-stock', async (_event, payload) => {
  try {
    const input = payload || {};
    return {
      ok: true,
      stock: supplyChainSeedService.queryStockSupplyChain(input.code || input.symbol || input, input)
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:query-chain', async (_event, payload) => {
  try {
    const input = payload || {};
    return {
      ok: true,
      chain: supplyChainSeedService.queryChain(input.chainId || input.id || input, input)
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:expand-node', async (_event, payload) => {
  try {
    const input = payload || {};
    return {
      ok: true,
      result: supplyChainSeedService.expandSupplyChainNode(input.nodeId || input.id || input, input)
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:list-user-overrides', async () => {
  try {
    return {
      ok: true,
      overrides: supplyChainSeedService.loadUserOverrides()
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

ipcMain.handle('supply-chain:apply-user-override', async (_event, payload) => {
  try {
    return {
      ok: true,
      result: supplyChainSeedService.applyUserOverride(payload || {})
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorMessage(error)
    };
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  createAppMenu();
  createMainWindow();

  setTimeout(() => {
    createTray();
  }, 1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Windows 下主窗口关闭不代表退出。
  // 真正退出只允许走：托盘右键退出 / 文件-退出 / app.quit()
  if (isQuitting) {
    return;
  }
});
