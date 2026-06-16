const fs = require('fs');
const path = require('path');

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../..');

function normalizeDisplayPath(filePath, projectRoot) {
  const absolutePath = path.resolve(filePath);
  const root = path.resolve(projectRoot || DEFAULT_PROJECT_ROOT);
  const relativePath = path.relative(root, absolutePath);

  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join('/');
  }

  return absolutePath;
}

function makePathCandidate(filePath, source, projectRoot) {
  return {
    source,
    command: filePath,
    commandArgs: [],
    displayPath: normalizeDisplayPath(filePath, projectRoot),
    path: filePath
  };
}

function getRuntimePythonCandidates(options = {}) {
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const resourcesPath = options.resourcesPath || '';
  const packagedAppRoot = resourcesPath ? path.join(resourcesPath, 'app') : '';

  const projectCandidates = [
    path.join(projectRoot, 'runtime', 'python', '.venv', 'Scripts', 'python.exe'),
    path.join(projectRoot, 'runtime', 'python', 'Scripts', 'python.exe'),
    path.join(projectRoot, 'runtime', 'python', 'python.exe')
  ];

  if (options.isPackaged) {
    return [
      ...projectCandidates,

      packagedAppRoot
        ? path.join(packagedAppRoot, 'runtime', 'python', '.venv', 'Scripts', 'python.exe')
        : '',
      packagedAppRoot
        ? path.join(packagedAppRoot, 'runtime', 'python', 'Scripts', 'python.exe')
        : '',
      packagedAppRoot
        ? path.join(packagedAppRoot, 'runtime', 'python', 'python.exe')
        : '',

      resourcesPath
        ? path.join(resourcesPath, 'runtime', 'python', '.venv', 'Scripts', 'python.exe')
        : '',
      resourcesPath
        ? path.join(resourcesPath, 'runtime', 'python', 'Scripts', 'python.exe')
        : '',
      resourcesPath
        ? path.join(resourcesPath, 'runtime', 'python', 'python.exe')
        : ''
    ].filter(Boolean);
  }

  return projectCandidates;
}

function resolveRuntimePython(options = {}) {
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;

  for (const candidatePath of getRuntimePythonCandidates(options)) {
    if (fs.existsSync(candidatePath)) {
      return makePathCandidate(candidatePath, 'runtime', projectRoot);
    }
  }

  return null;
}

function resolvePython(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const runtimePython = resolveRuntimePython({
    ...options,
    projectRoot
  });

  if (runtimePython) {
    return runtimePython;
  }

  if (env.XWB_PYTHON) {
    return {
      source: 'XWB_PYTHON',
      command: env.XWB_PYTHON,
      commandArgs: [],
      displayPath: env.XWB_PYTHON,
      path: env.XWB_PYTHON
    };
  }

  if (env.PYTHON) {
    return {
      source: 'PYTHON',
      command: env.PYTHON,
      commandArgs: [],
      displayPath: env.PYTHON,
      path: env.PYTHON
    };
  }

  if (process.platform === 'win32') {
    return {
      source: 'py -3',
      command: 'py',
      commandArgs: ['-3'],
      displayPath: 'py -3',
      path: ''
    };
  }

  return {
    source: 'python',
    command: 'python',
    commandArgs: [],
    displayPath: 'python',
    path: ''
  };
}

function normalizePythonResolution(value, options = {}) {
  if (value && typeof value === 'object' && value.command) {
    return {
      source: value.source || 'custom',
      command: value.command,
      commandArgs: Array.isArray(value.commandArgs) ? value.commandArgs : [],
      displayPath: value.displayPath || value.command,
      path: value.path || ''
    };
  }

  if (typeof value === 'string' && value.trim()) {
    return {
      source: 'custom',
      command: value,
      commandArgs: [],
      displayPath: value,
      path: value
    };
  }

  return resolvePython(options);
}

function buildPythonArgs(pythonResolution, args) {
  const resolution = normalizePythonResolution(pythonResolution);
  return [
    ...resolution.commandArgs,
    ...(Array.isArray(args) ? args : [])
  ];
}

module.exports = {
  DEFAULT_PROJECT_ROOT,
  getRuntimePythonCandidates,
  resolveRuntimePython,
  resolvePython,
  normalizePythonResolution,
  buildPythonArgs
};
