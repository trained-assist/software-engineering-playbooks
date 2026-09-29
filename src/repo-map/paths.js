'use strict';

// Where derived acceleration data (repository index + repo maps) lives.
//
// It must NOT live inside a worktree: two checkouts of the same commit then
// share one copy, and no working tree is polluted. Layout:
//
//   <workspacesRoot>/repo-maps/<repoId>/<sha>/
//     index/          # the index itself (same schema as v1)
//     map-l0.json     # rendered L0 map
//     map-l1.json     # rendered L1 skeleton
//     descriptions.json # LLM one-liners, cached by module content hash
//
// <workspacesRoot> defaults to the profile's engineering workspace root, so the
// cache sits next to the mirrors/workspaces it belongs to.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repositoryIdentity, currentRevision } = require('../index/build');
const { indexRoot } = require('../index/schema');

const MAPS_DIRNAME = 'repo-maps';
const INDEX_DIRNAME = 'index';
// Keep the last N commits worth of maps per repository; older ones are pruned
// on every successful build.
const RETAINED_SHAS = 10;

function resolveWorkspacesRoot(explicit) {
  if (explicit && String(explicit).trim()) return explicit;
  if (process.env.ENGINEERING_WORKSPACE_ROOT && String(process.env.ENGINEERING_WORKSPACE_ROOT).trim()) {
    return process.env.ENGINEERING_WORKSPACE_ROOT;
  }
  return path.join(os.homedir(), 'agent-data', 'engineering-workspaces');
}

function mapsRoot(workspacesRoot) {
  return path.join(resolveWorkspacesRoot(workspacesRoot), MAPS_DIRNAME);
}

function repoIdFor(repoPath) {
  return repositoryIdentity(path.resolve(repoPath)).id;
}

function mapDirFor({ repoPath, workspacesRoot, sha }) {
  return path.join(mapsRoot(workspacesRoot), repoIdFor(repoPath), sha);
}

function indexDirFor(options) {
  return path.join(mapDirFor(options), INDEX_DIRNAME);
}

function shaFor(repoPath) {
  return currentRevision(path.resolve(repoPath)) || null;
}

// The single seam every reader of the index goes through. A checkout that
// already owns a legacy `.engineering/index` keeps using it (it is fresh for
// its own HEAD by construction); a fresh worktree with no local index resolves
// the shared per-sha copy instead — that is how worktrees share one cache.
function resolveIndexRoot(repoPath, { workspacesRoot } = {}) {
  const abs = path.resolve(repoPath);
  const legacy = indexRoot(abs);
  if (fs.existsSync(path.join(legacy, 'revision.json'))) return legacy;
  const sha = shaFor(abs);
  if (!sha) return legacy;
  const shared = indexDirFor({ repoPath: abs, workspacesRoot, sha });
  if (fs.existsSync(path.join(shared, 'revision.json'))) return shared;
  return legacy;
}

// Drop every map of this repository except the newest `keep` ones.
function pruneOldMaps({ repoPath, workspacesRoot, keep = RETAINED_SHAS }) {
  const dir = path.dirname(mapDirFor({ repoPath, workspacesRoot, sha: 'x' }));
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/.test(e.name));
  } catch {
    return [];
  }
  if (entries.length <= keep) return [];
  const removed = [];
  const ordered = entries
    .map((e) => ({ name: e.name, mtime: statMtime(path.join(dir, e.name)) }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const entry of ordered.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* best effort: retention never fails a build */ }
  }
  return removed;
}

function statMtime(target) {
  try { return fs.statSync(target).mtimeMs; } catch { return 0; }
}

module.exports = {
  MAPS_DIRNAME,
  INDEX_DIRNAME,
  RETAINED_SHAS,
  resolveWorkspacesRoot,
  mapsRoot,
  repoIdFor,
  mapDirFor,
  indexDirFor,
  shaFor,
  resolveIndexRoot,
  pruneOldMaps,
};
