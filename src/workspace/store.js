'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('./errors');

const STORE_DIRNAME = '.engineering-workspaces';

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shortHash(value, length = 16) {
  return hash(value).slice(0, length);
}

function storeRoot(workspaceRoot) {
  return path.join(workspaceRoot, STORE_DIRNAME);
}

function storeDirs(workspaceRoot) {
  const root = storeRoot(workspaceRoot);
  return {
    root,
    operations: path.join(root, 'operations'),
    owners: path.join(root, 'owners'),
    intents: path.join(root, 'intents'),
    workspaces: path.join(root, 'workspaces'),
    // Task → change refs chosen by an owner (#111). Same host-owned store root,
    // same owner scoping and atomic writes as the records above — engineering_
    // change_find/bind must not open a second durable store of their own.
    bindings: path.join(root, 'bindings'),
    // Verification verdicts per change (#112), written by engineering_verify
    // and READ by engineering_change_status so «проверено» is a fact on disk,
    // not a claim in a chat log. Same root, same owner key, same atomic write.
    verifications: path.join(root, 'verifications'),
    locks: path.join(root, 'locks'),
  };
}

function ensureStore(workspaceRoot) {
  const dirs = storeDirs(workspaceRoot);
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJson(file, { required = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (required) fail('CORRUPT_STATE', `missing state file: ${file}`);
      return null;
    }
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail('CORRUPT_STATE', `corrupt state file: ${file}`, { cause: e.message });
  }
}

function readJsonSafe(file) {
  try { return readJson(file); } catch { return null; }
}

function removeDirIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* directory absent or not empty */ }
}

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function processAlive(pid) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function lockOwner(lockPath) {
  return readJsonSafe(path.join(lockPath, 'owner.json'));
}

function lockAgeMs(lockPath) {
  try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return 0; }
}

function acquireLock(lockPath, { timeoutMs = 5000, staleMs = 30000, retryMs = 20 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      writeJsonAtomic(path.join(lockPath, 'owner.json'), { pid: process.pid, host: os.hostname(), at: new Date().toISOString() });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = lockOwner(lockPath);
      const stale = lockAgeMs(lockPath) > staleMs && (!owner || !processAlive(owner.pid));
      if (stale) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        fail('BUSY', 'workspace operation lock is held by another process', { lockPath });
      }
      sleepSync(retryMs);
    }
  }
}

function operationFile(workspaceRoot, operationKey) {
  return path.join(storeDirs(workspaceRoot).operations, `${hash(operationKey)}.json`);
}

function ownerFile(workspaceRoot, ownerKey) {
  return path.join(storeDirs(workspaceRoot).owners, `${hash(ownerKey)}.json`);
}

function intentFile(workspaceRoot, workspaceId) {
  return path.join(storeDirs(workspaceRoot).intents, `${workspaceId}.json`);
}

function workspaceFile(workspaceRoot, workspaceId) {
  return path.join(storeDirs(workspaceRoot).workspaces, `${workspaceId}.json`);
}

// One binding per owner+repository+task. The key is hashed like operations/
// owners so free-text task labels never become path segments.
function bindingFile(workspaceRoot, bindingKey) {
  return path.join(storeDirs(workspaceRoot).bindings, `${hash(bindingKey)}.json`);
}

// One verification verdict per owner+repository+change (#112). Same hashed-key
// discipline as bindings: a change key may contain slashes and never becomes a
// path segment.
function verificationFile(workspaceRoot, verificationKey) {
  return path.join(storeDirs(workspaceRoot).verifications, `${hash(verificationKey)}.json`);
}

function lockFile(workspaceRoot, key) {
  return path.join(storeDirs(workspaceRoot).locks, `${hash(key)}.lock`);
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch { return []; }
}

module.exports = {
  STORE_DIRNAME,
  hash,
  shortHash,
  storeRoot,
  storeDirs,
  ensureStore,
  writeJsonAtomic,
  readJson,
  readJsonSafe,
  removeDirIfEmpty,
  acquireLock,
  operationFile,
  ownerFile,
  intentFile,
  workspaceFile,
  bindingFile,
  verificationFile,
  lockFile,
  listFiles,
};
