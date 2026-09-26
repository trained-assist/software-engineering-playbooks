'use strict';

const fs = require('fs');
const path = require('path');
const { INDEX_SCHEMA_VERSION, INDEX_ROOT_DIRNAME, indexRoot } = require('./schema');
const { repositoryIdentity, currentRevision, isGitRepo } = require('./build');

function readIndexMeta(repoPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(indexRoot(path.resolve(repoPath)), 'revision.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readIndexData(repoPath) {
  const abs = path.resolve(repoPath);
  const root = indexRoot(abs);
  const meta = readIndexMeta(abs);
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
function indexCompatibility(repoPath, { baseRevision } = {}) {
  const abs = path.resolve(repoPath);
  const meta = readIndexMeta(abs);
  if (!meta) return { usable: false, reason: 'no-index', meta: null };
  if (meta.schemaVersion !== INDEX_SCHEMA_VERSION) return { usable: false, reason: 'schema-mismatch', meta };
  if (!isGitRepo(abs)) return { usable: false, reason: 'not-a-git-repo', meta };
  if (!meta.repository || meta.repository.id !== repositoryIdentity(abs).id) {
    return { usable: false, reason: 'repo-mismatch', meta };
  }
  const head = baseRevision || currentRevision(abs);
  if (!head) return { usable: false, reason: 'unknown-revision', meta };
  if (meta.revision !== head) return { usable: false, reason: 'stale-revision', meta };
  return { usable: true, reason: 'ok', meta };
}

function canUseIndex(repoPath) {
  return indexCompatibility(repoPath).usable;
}

module.exports = {
  INDEX_ROOT_DIRNAME,
  readIndexMeta,
  readIndexData,
  indexCompatibility,
  canUseIndex,
};
