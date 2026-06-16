const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SYNC_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'sync', 'full-a-share-sync-state.json');
const SYNC_STATE_PATH = path.resolve(process.env.SYNC_STATE_PATH || DEFAULT_SYNC_STATE_PATH);
const CACHE_DIR = path.join(PROJECT_ROOT, 'data', 'cache');
const CACHE_FILES = [
  path.join(CACHE_DIR, 'ashare-cache.sqlite'),
  path.join(CACHE_DIR, 'ashare-cache.sqlite-wal'),
  path.join(CACHE_DIR, 'ashare-cache.sqlite-shm')
];
const SYNC_VERSION = 'dev-0.1.9.13';
const RENAME_RETRY_DELAYS = [100, 200, 300, 500, 800, 1200];
const ROLLBACK_INACTIVE_ERROR = 'cannot rollback - no transaction is active';
const ARRAY_BUFFER_ERROR = 'Array buffer allocation failed';
const DONE_LIKE_STATUSES = new Set([
  'DONE',
  'PARTIAL_DONE',
  'DONE_WITH_GAPS',
  'PARTIAL_DONE_VALID'
]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableFileError(error) {
  return Boolean(error && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
}

function makeTempPath() {
  return `${SYNC_STATE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function removeFileQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_error) {
    // 临时文件清理失败不影响 repair 结果。
  }
}

async function replaceStateFile(stateText) {
  const tempPath = makeTempPath();
  let lastRenameError = null;

  try {
    fs.writeFileSync(tempPath, stateText, 'utf8');

    for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS.length; attempt += 1) {
      try {
        fs.renameSync(tempPath, SYNC_STATE_PATH);
        return {
          ok: true,
          fallback: false
        };
      } catch (error) {
        lastRenameError = error;

        if (!isRetryableFileError(error) || attempt >= RENAME_RETRY_DELAYS.length) {
          break;
        }

        await sleep(RENAME_RETRY_DELAYS[attempt]);
      }
    }

    fs.copyFileSync(tempPath, SYNC_STATE_PATH);
    return {
      ok: true,
      fallback: true,
      renameError: lastRenameError ? lastRenameError.message : ''
    };
  } finally {
    removeFileQuietly(tempPath);
  }
}

function getFileSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function getCacheSnapshots() {
  return new Map(CACHE_FILES.map((filePath) => [filePath, getFileSnapshot(filePath)]));
}

function assertCacheUnchanged(beforeSnapshots) {
  for (const filePath of CACHE_FILES) {
    const before = beforeSnapshots.get(filePath);
    const after = getFileSnapshot(filePath);

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`缓存文件被修改，已中止：${filePath}`);
    }
  }
}

function isFakeFailed(item) {
  return Boolean(
    item
    && item.status === 'FAILED'
    && item.syncMode === 'SKIPPED'
    && Number(item.barCount) > 0
    && String(item.error || '').includes('EPERM: operation not permitted, rename')
  );
}

function containsRollbackInactiveError(value) {
  return String(value || '').includes(ROLLBACK_INACTIVE_ERROR);
}

function isRollbackFailed(item) {
  return Boolean(
    item
    && item.status === 'FAILED'
    && (
      containsRollbackInactiveError(item.error)
      || containsRollbackInactiveError(item.rawError)
      || containsRollbackInactiveError(item.lastTransportError)
    )
  );
}

function containsArrayBufferError(value) {
  return String(value || '').includes(ARRAY_BUFFER_ERROR);
}

function isArrayBufferFailed(item) {
  return Boolean(
    item
    && item.status === 'FAILED'
    && (
      containsArrayBufferError(item.error)
      || containsArrayBufferError(item.rawError)
      || containsArrayBufferError(item.lastTransportError)
    )
  );
}

function clearErrorFields(item) {
  item.error = '';
  item.rawError = '';
  item.akshareError = '';
  item.eastmoneyError = '';
  item.altDailyError = '';
  item.lastTransportError = '';
}

function resetRollbackIncremental(item) {
  item.status = 'NO_NEW_DATA';
  item.noNewDataReason = item.noNewDataReason || '增量区间暂无新日线';
  clearErrorFields(item);
}

function resetRollbackFullChunked(item) {
  item.status = 'PENDING';
  item.syncMode = '';
  item.fetchStartDate = '';
  item.fetchEndDate = '';
  item.currentChunkStart = '';
  item.currentChunkEnd = '';
  item.finishedChunks = [];
  item.failedChunks = [];
  item.emptyChunks = [];
  item.emptyIncrementalRange = null;
  item.noNewDataReason = '';
  item.preferredSource = '';
  item.chunkSource = '';
  item.addedBars = 0;
  item.costMs = 0;
  clearErrorFields(item);
}

function resetArrayBufferPending(item) {
  item.status = 'PENDING';
  item.syncMode = '';
  item.fetchStartDate = '';
  item.fetchEndDate = '';
  item.currentChunkStart = '';
  item.currentChunkEnd = '';
  item.finishedChunks = [];
  item.failedChunks = [];
  item.emptyChunks = [];
  item.emptyIncrementalRange = null;
  item.noNewDataReason = '';
  item.preferredSource = '';
  item.chunkSource = '';
  item.addedBars = 0;
  item.costMs = 0;
  clearErrorFields(item);
}

function countByStatus(state, status) {
  return Object.values(state.items || {}).filter((item) => item && item.status === status).length;
}

function recalculateCounters(state) {
  const items = Object.values(state.items || {});

  state.done = items.filter((item) => item && DONE_LIKE_STATUSES.has(item.status)).length;
  state.skipped = items.filter((item) => {
    return item && (
      item.status === 'SKIPPED'
      || item.status === 'NO_NEW_DATA'
      || item.status === 'SKIPPED_NO_NEW_BAR'
    );
  }).length;
  state.failed = items.filter((item) => item && item.status === 'FAILED').length;
}

async function main() {
  if (!fs.existsSync(SYNC_STATE_PATH)) {
    throw new Error(`状态文件不存在：${SYNC_STATE_PATH}`);
  }

  const cacheSnapshots = getCacheSnapshots();
  const state = JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8'));
  let repairedFakeFailed = 0;
  let repairedRollbackFailed = 0;
  let resetToPending = 0;
  let resetToNoNewData = 0;
  let repairedArrayBufferFailed = 0;
  let resetArrayBufferToPending = 0;

  for (const item of Object.values(state.items || {})) {
    if (isArrayBufferFailed(item)) {
      if (
        item.syncMode === 'INCREMENTAL' && Number(item.barCount) > 0
        || item.syncMode === 'FULL_CHUNKED' && Number(item.barCount) === 0
      ) {
        resetArrayBufferPending(item);
        repairedArrayBufferFailed += 1;
        resetArrayBufferToPending += 1;
        continue;
      }
    }

    if (isRollbackFailed(item)) {
      if (item.syncMode === 'INCREMENTAL' && Number(item.barCount) > 0) {
        resetRollbackIncremental(item);
        repairedRollbackFailed += 1;
        resetToNoNewData += 1;
        continue;
      }

      if (item.syncMode === 'FULL_CHUNKED' && Number(item.barCount) === 0) {
        resetRollbackFullChunked(item);
        repairedRollbackFailed += 1;
        resetToPending += 1;
        continue;
      }
    }

    if (!isFakeFailed(item)) {
      continue;
    }

    item.status = 'SKIPPED';
    clearErrorFields(item);
    repairedFakeFailed += 1;
  }

  if (repairedRollbackFailed > 0 && containsRollbackInactiveError(state.lastError)) {
    state.lastError = '';
  }

  if (repairedArrayBufferFailed > 0 && containsArrayBufferError(state.lastError)) {
    state.lastError = '';
  }

  if (repairedFakeFailed > 0 || repairedRollbackFailed > 0 || repairedArrayBufferFailed > 0) {
    recalculateCounters(state);
    state.version = SYNC_VERSION;
    state.updatedAt = new Date().toISOString();
    await replaceStateFile(`${JSON.stringify(state)}\n`);
  }

  assertCacheUnchanged(cacheSnapshots);

  const remainingFailed = countByStatus(state, 'FAILED');

  console.log(JSON.stringify({
    repairedFakeFailed,
    repairedRollbackFailed,
    resetToPending,
    resetToNoNewData,
    repairedArrayBufferFailed,
    resetArrayBufferToPending,
    remainingFailed,
    sqliteModified: false,
    statePath: SYNC_STATE_PATH
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
