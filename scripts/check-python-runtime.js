const { spawnSync } = require('child_process');
const {
  resolvePython,
  normalizePythonResolution,
  buildPythonArgs
} = require('../src/runtime/pythonResolver');

function runPython(pythonResolution, args) {
  const resolution = normalizePythonResolution(pythonResolution);
  return spawnSync(
    resolution.command,
    buildPythonArgs(resolution, args),
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );
}

function main() {
  const resolution = resolvePython();
  const result = runPython(resolution, [
    '-c',
    'import sys; print(sys.executable); import adata; print("adata ok")'
  ]);
  const stdoutLines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(`selectedPython=${resolution.displayPath}`);
  console.log(`resolver=${resolution.source}`);
  console.log(`sys.executable=${stdoutLines[0] || '-'}`);

  if (result.status === 0) {
    console.log('adata=ok');
    return;
  }

  console.log('adata=failed');
  if (result.stderr) {
    console.log(String(result.stderr).trim());
  }
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  main
};
