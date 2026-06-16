const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  normalizePythonResolution,
  buildPythonArgs
} = require('../src/runtime/pythonResolver');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime', 'python');
const VENV_DIR = path.join(RUNTIME_DIR, '.venv');
const REQUIREMENTS_PATH = path.join(PROJECT_ROOT, 'requirements.txt');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

const BASE_PYTHON_CANDIDATES = [
  {
    source: 'py -3',
    command: 'py',
    commandArgs: ['-3'],
    displayPath: 'py -3',
    path: ''
  },
  {
    source: 'python',
    command: 'python',
    commandArgs: [],
    displayPath: 'python',
    path: ''
  }
];

function runPython(pythonResolution, args, options = {}) {
  const resolution = normalizePythonResolution(pythonResolution);
  return spawnSync(
    resolution.command,
    buildPythonArgs(resolution, args),
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      ...options
    }
  );
}

function compactOutput(result) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .replace(/\s+$/g, '');
}

function formatRuntimePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
}

function checkAdata(pythonResolution) {
  const result = runPython(pythonResolution, [
    '-c',
    'import sys; print(sys.executable); import adata; print("adata ok")'
  ]);

  return {
    ok: result.status === 0,
    output: compactOutput(result),
    executable: String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  };
}

function findBasePython() {
  for (const candidate of BASE_PYTHON_CANDIDATES) {
    const result = runPython(candidate, [
      '-c',
      'import sys; print(sys.executable)'
    ]);

    if (result.status === 0) {
      return {
        ...candidate,
        executable: String(result.stdout || '').trim().split(/\r?\n/)[0] || candidate.displayPath
      };
    }
  }

  return null;
}

function ensureVenvSupport(basePython) {
  const result = runPython(basePython, ['-m', 'venv', '--help']);

  if (result.status !== 0) {
    throw new Error(`base Python 不能创建 venv：${compactOutput(result) || basePython.displayPath}`);
  }
}

function createVenv(basePython) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  const result = runPython(basePython, ['-m', 'venv', VENV_DIR], {
    stdio: 'pipe'
  });

  if (result.status !== 0) {
    throw new Error(`创建 runtime venv 失败：${compactOutput(result)}`);
  }
}

function installRequirements(runtimePython) {
  const result = runPython(runtimePython, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH], {
    stdio: 'pipe'
  });

  if (result.status !== 0) {
    throw new Error(`pip install 失败：${compactOutput(result)}`);
  }

  return compactOutput(result);
}

function main() {
  const runtimePython = {
    source: 'runtime',
    command: VENV_PYTHON,
    commandArgs: [],
    displayPath: formatRuntimePath(VENV_PYTHON),
    path: VENV_PYTHON
  };

  console.log(`[python-runtime] runtimePython=${runtimePython.displayPath}`);

  if (fs.existsSync(VENV_PYTHON)) {
    const existingCheck = checkAdata(runtimePython);

    if (existingCheck.ok) {
      console.log(`[python-runtime] basePython=已存在 runtime venv`);
      console.log(`[python-runtime] pip install=跳过`);
      console.log(`[python-runtime] adata=ok`);
      console.log(`[python-runtime] sys.executable=${existingCheck.executable}`);
      return;
    }

    console.log(`[python-runtime] existing adata=failed`);
    console.log(existingCheck.output);
  }

  const basePython = findBasePython();

  if (!basePython) {
    throw new Error('没有找到可用于创建 runtime 的 Python。请先安装 Python 3，或确认 py -3 / python 可用。');
  }

  console.log(`[python-runtime] basePython=${basePython.displayPath}`);
  console.log(`[python-runtime] baseExecutable=${basePython.executable}`);

  ensureVenvSupport(basePython);
  createVenv(basePython);

  const pipOutput = installRequirements(runtimePython);
  console.log(`[python-runtime] pip install=ok`);
  if (pipOutput) {
    console.log(pipOutput);
  }

  const finalCheck = checkAdata(runtimePython);

  if (!finalCheck.ok) {
    throw new Error(`adata 检查失败：${finalCheck.output}`);
  }

  console.log(`[python-runtime] adata=ok`);
  console.log(`[python-runtime] sys.executable=${finalCheck.executable}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[python-runtime] failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  findBasePython,
  checkAdata
};
