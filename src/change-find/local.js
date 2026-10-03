'use strict';

// Owner-scoped access to the host-owned workspace store (#111): the binding
// for task → change refs lives in the SAME store that already owns workspace
// records (src/workspace/store.js) — same root, same owner key, same atomic
// write and lock. No second durable store, no profile context store: this has
// to be readable from both facades (MCP and CLI) and from a fresh process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../workspace/store');
const { normTask } = require('./refs');

// Mirrors src/workspace/for-task.js DEFAULT_WORKSPACE_ROOT (unset
// ENGINEERING_WORKSPACE_ROOT → the library default).
function defaultWorkspaceRoot() {
  return path.join(os.homedir(), 'agent-data', 'engineering-workspaces');
}

function resolveRoot(workspaceRoot) {
  return workspaceRoot || process.env.ENGINEERING_WORKSPACE_ROOT || defaultWorkspaceRoot();
}

function bindingKey(principal, repositoryId, taskRef) {
  return `${principal}\0${repositoryId}\0${normTask(taskRef)}`;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function readAll(dir) {
  return readDirSafe(dir)
    .map((f) => store.readJsonSafe(path.join(dir, f)))
    .filter(Boolean);
}

function listBindings({ workspaceRoot, principal, repositoryId }) {
  if (!principal) return [];
  const root = resolveRoot(workspaceRoot);
  return readAll(store.storeDirs(root).bindings)
    .filter((r) => r && r.principal === principal && (!repositoryId || r.repositoryId === repositoryId));
}

function listWorkspaces({ workspaceRoot, principal, repositoryId }) {
  if (!principal) return [];
  const root = resolveRoot(workspaceRoot);
  return readAll(store.storeDirs(root).workspaces)
    .filter((r) => r && r.principal === principal && (!repositoryId || r.repositoryId === repositoryId));
}

function readBinding({ workspaceRoot, principal, repositoryId, taskRef }) {
  if (!principal) return null;
  const root = resolveRoot(workspaceRoot);
  return store.readJsonSafe(store.bindingFile(root, bindingKey(principal, repositoryId, taskRef)));
}

function writeBinding({ workspaceRoot, principal, repositoryId, taskRef, refs, workspaceId = null, now = Date.now }) {
  if (!principal) {
    const e = new Error('principal is required to persist a binding (host-derived USER_ID)');
    e.code = 'PRINCIPAL_MISSING';
    throw e;
  }
  const root = resolveRoot(workspaceRoot);
  store.ensureStore(root);
  const key = bindingKey(principal, repositoryId, taskRef);
  const file = store.bindingFile(root, key);
  const release = store.acquireLock(store.lockFile(root, `bind:${key}`));
  try {
    const prev = store.readJsonSafe(file);
    const at = new Date(now()).toISOString();
    const record = {
      schemaVersion: 1,
      principal,
      repositoryId,
      taskRef: String(taskRef).trim(),
      taskRefNorm: normTask(taskRef),
      refs,
      workspaceId: workspaceId || (prev && prev.workspaceId) || null,
      createdAt: (prev && prev.createdAt) || at,
      updatedAt: at,
      source: 'engineering_change_bind',
    };
    store.writeJsonAtomic(file, record);
    return record;
  } finally {
    release();
  }
}

module.exports = {
  defaultWorkspaceRoot,
  resolveRoot,
  bindingKey,
  listBindings,
  listWorkspaces,
  readBinding,
  writeBinding,
};
