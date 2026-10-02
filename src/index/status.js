'use strict';

const fs = require('fs');
const path = require('path');
const { INDEX_SCHEMA_VERSION, INDEX_ROOT_DIRNAME, indexRoot } = require('./schema');
const { repositoryIdentity, currentRevision, isGitRepo } = require('./build');

// Everything below resolves the on-disk root through ONE seam (resolveIndexRoot
// in repo-map/paths.js): legacy `.engineering/index` when the checkout owns it,
// otherwise the shared per-sha cache. Readers and writers must agree, so the
// root is resolved exactly once per call and reused for meta and data alike.

function rootFor(repoPath, opts) {
  const abs = path.resolve(repoPath);
  // Lazy require: repo-map/paths needs ./build above, and status is loaded
  // after build in every entry point. workspacesRoot defaults to the profile
  // root, so callers never have to know where the shared cache lives.
  const { resolveIndexRoot, resolveWorkspacesRoot } = require('../repo-map/paths');
  return resolveIndexRoot(abs, {
    workspacesRoot: resolveWorkspacesRoot(opts && opts.workspacesRoot),
    revision: opts && opts.baseRevision,
  });
}

function readIndexMeta(repoPath, opts) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootFor(repoPath, opts), 'revision.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readIndexData(repoPath, opts) {
  const abs = path.resolve(repoPath);
  const root = rootFor(abs, opts);
  const meta = readIndexMeta(abs, opts);
  if (!meta) return null;
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    const files = read('files.json');
    const modules = read('modules.json');
    const symbols = read('symbols.json');
    const tests = read('tests.json');
    return {
      root,
      meta,
      files: files.files || [],
      modules: modules.modules || [],
      hotspots: modules.hotspots || [],
      symbols: symbols.symbols || [],
      tests: tests.tests || [],
      byStem: tests.byStem || {},
    };
  } catch {
    return null;
  }
}

// Indexing is an optimization, never a correctness dependency: any reason we
// cannot prove the index matches the current repository falls back to raw.
function indexCompatibility(repoPath, { baseRevision, workspacesRoot } = {}) {
  const abs = path.resolve(repoPath);
  const opts = { baseRevision, workspacesRoot };
  const meta = readIndexMeta(abs, opts);
  if (!meta) return { usable: false, reason: 'no-index', meta: null };
  if (meta.schemaVersion !== INDEX_SCHEMA_VERSION) return { usable: false, reason: 'schema-mismatch', meta };
  if (!isGitRepo(abs)) return { usable: false, reason: 'not-a-git-repo', meta };
  if (!meta.repository || meta.repository.id !== repositoryIdentity(abs).id) {
    return { usable: false, reason: 'repo-mismatch', meta };
  }
  const head = baseRevision || currentRevision(abs);
  if (!head) return { usable: false, reason: 'unknown-revision', meta };
  if (meta.revision !== head) return { usable: false, reason: 'stale-revision', meta };
  return { usable: true, reason: 'ok', meta, root: rootFor(abs, opts) };
}

function canUseIndex(repoPath, opts) {
  return indexCompatibility(repoPath, opts).usable;
}

module.exports = {
  INDEX_ROOT_DIRNAME,
  indexRoot,
  readIndexMeta,
  readIndexData,
  indexCompatibility,
  canUseIndex,
};
