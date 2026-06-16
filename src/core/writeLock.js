const { AsyncLocalStorage } = require('async_hooks');

let writeQueue = Promise.resolve();
const writeLockContext = new AsyncLocalStorage();

function withWriteLock(task) {
  if (writeLockContext.getStore()) {
    return Promise.resolve().then(() => task());
  }

  const run = writeQueue.then(() => {
    return writeLockContext.run(true, () => task());
  });

  writeQueue = run.catch(() => {});
  return run;
}

module.exports = {
  withWriteLock
};
