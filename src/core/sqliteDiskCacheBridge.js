const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getPythonChildEnv } = require('../workers/pythonWorker');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CACHE_DB_PATH = path.join(PROJECT_ROOT, 'data', 'cache', 'ashare-cache.sqlite');
const BRIDGE_PATH = path.join(__dirname, 'sqliteDiskCacheBridge.py');
const TMP_DIR = path.join(PROJECT_ROOT, 'data', 'tmp');

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function makePayloadPath() {
  ensureTmpDir();
  return path.join(
    TMP_DIR,
    [
      'sqlite-disk-cache',
      process.pid,
      Date.now(),
      Math.random().toString(36).slice(2, 10)
    ].join('.') + '.json'
  );
}

function removeFileQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_error) {
    // Temporary payload cleanup should not hide the bridge result.
  }
}

function getPythonCommands() {
  const bundledPython = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe'
  );

  return [
    process.env.PYTHON,
    fs.existsSync(bundledPython) ? bundledPython : '',
    'python',
    'py'
  ].filter((command, index, list) => command && list.indexOf(command) === index);
}

function parseBridgeJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');

  if (jsonStart < 0) {
    throw new Error(`SQLite disk bridge did not return JSON: ${text.slice(0, 240)}`);
  }

  return JSON.parse(text.slice(jsonStart));
}

function appendNamedArg(args, name, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  args.push(name, String(value));
}

function runBridgeCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: getPythonChildEnv()
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const payload = parseBridgeJson(stdout);

        if (!payload.ok) {
          const error = new Error(payload.error || stderr || `SQLite disk bridge failed with code ${code}`);
          error.rawError = payload.traceback || stderr || stdout || '';
          error.lastTransportError = payload.error || '';
          reject(error);
          return;
        }

        resolve(payload.result || {});
      } catch (error) {
        error.rawError = stderr || stdout || '';
        reject(error);
      }
    });
  });
}

async function runSqliteDiskCacheBridge(action, options = {}) {
  let payloadPath = '';

  try {
    if (options.payload !== undefined) {
      payloadPath = makePayloadPath();
      fs.writeFileSync(payloadPath, JSON.stringify(options.payload), 'utf8');
    }

    const args = [BRIDGE_PATH, action, '--db', options.dbPath || CACHE_DB_PATH];
    const namedArgs = options.args || {};

    appendNamedArg(args, '--symbol', namedArgs.symbol);
    appendNamedArg(args, '--index-code', namedArgs.indexCode);
    appendNamedArg(args, '--start-date', namedArgs.startDate);
    appendNamedArg(args, '--end-date', namedArgs.endDate);
    appendNamedArg(args, '--payload', payloadPath);

    let lastError = null;

    for (const command of getPythonCommands()) {
      try {
        return await runBridgeCommand(command, args);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('No Python command is available for SQLite disk bridge.');
  } finally {
    removeFileQuietly(payloadPath);
  }
}

module.exports = {
  CACHE_DB_PATH,
  BRIDGE_PATH,
  runSqliteDiskCacheBridge
};
