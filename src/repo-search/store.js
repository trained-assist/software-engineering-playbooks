'use strict';

// Where retrieval artefacts live: INSIDE the per-sha directory that repo-map
// already owns (<workspacesRoot>/repo-maps/<repoId>/<sha>/search/…), so the
// search cache is pruned by the same lifecycle as the maps and two checkouts of
// the same commit share one copy. Deleting the directory is always safe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mapDirFor, pruneOldMaps } = require('../repo-map/paths');
const { modelKey, defaultModel } = require('./embeddings');

const SEARCH_DIRNAME = 'search';
// Bumped when the chunk shape changes (v2: per-chunk precomputed terms).
const CACHE_SCHEMA = 2;

function searchDirFor({ repoPath, workspacesRoot, sha, model }) {
  return path.join(mapDirFor({ repoPath, workspacesRoot, sha }), SEARCH_DIRNAME, model ? modelKey(defaultModel(model)) : 'none');
}

function chunksFile(dir) {
  return path.join(dir, 'chunks.json');
}

function fileHashMap(root, files) {
  const out = {};
  for (const rel of files) {
    try {
      out[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
    } catch {
      // deleted / unreadable: recorded as absent so a stale chunk can be dropped
    }
  }
  return out;
}

function loadChunks({ repoPath, workspacesRoot, sha, model, refresh } = {}) {
  const dir = searchDirFor({ repoPath, workspacesRoot, sha, model });
  const file = chunksFile(dir);
  if (!refresh) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema === CACHE_SCHEMA && Array.isArray(parsed.chunks) && parsed.sha === sha) {
        return { chunks: parsed.chunks, stats: parsed.stats || {}, dir, loadedFrom: file, built: false };
      }
    } catch { /* no cache yet — rebuild below */ }
  }
  return { chunks: null, stats: null, dir, loadedFrom: null, built: false };
}

function saveChunks({ repoPath, workspacesRoot, sha, model, chunks, stats }) {
  const dir = searchDirFor({ repoPath, workspacesRoot, sha, model });
  fs.mkdirSync(dir, { recursive: true });
  const file = chunksFile(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, sha, savedAt: new Date().toISOString(), stats, chunks }));
  fs.renameSync(tmp, file);
  pruneOldMaps({ repoPath, workspacesRoot });
  return file;
}

module.exports = { SEARCH_DIRNAME, CACHE_SCHEMA, searchDirFor, chunksFile, fileHashMap, loadChunks, saveChunks };