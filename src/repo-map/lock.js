'use strict';

// One build per (repository, sha). Two sessions hitting the same commit at the
// same time (spawn hook + first repo_map) must produce exactly one map, not two
// racing writers. `mkdir` is atomic on every filesystem we run on, so the lock
// is a directory; a lock older than STALE_MS is considered abandoned (a crashed
// builder) and is broken rather than waited on forever.

const fs = require('fs');
const path = require('path');

const STALE_MS = 60_000;
const STEP_MS = 50;
const TIMEOUT_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock(lockPath, fn, { staleMs = STALE_MS, timeoutMs = TIMEOUT_MS } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), String(process.pid));
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockAge(lockPath) > staleMs) {
        // Break an abandoned lock and retry immediately.
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        const err = new Error(`timed out waiting for the repo-map lock: ${path.basename(path.dirname(lockPath))}`);
        err.code = 'MAP_LOCK_TIMEOUT';
        throw err;
      }
      await sleep(STEP_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function lockAge(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

module.exports = { withLock, STALE_MS, STEP_MS, TIMEOUT_MS };
