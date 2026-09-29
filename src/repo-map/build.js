'use strict';

// Builds the shared per-sha artefacts: the index itself, the rendered L0 map,
// and the module descriptions that feed it. Everything is derived data —
// deleting the cache is always safe, and a rebuild is idempotent.

const fs = require('fs');
const path = require('path');
const { buildIndex, currentRevision } = require('../index/build');
const { mapDirFor, pruneOldMaps } = require('./paths');
const { withLock } = require('./lock');
const { describeModules } = require('./llm');
const { renderL0 } = require('./l0');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function isBuilt(dir) {
  return fs.existsSync(path.join(dir, 'map-l0.json'))
    && fs.existsSync(path.join(dir, 'index', 'revision.json'));
}

// Reads an index out of a specific cache directory (not through the repo-path
// seam): the caller already knows exactly which commit's index it wants.
function readIndexDir(dir) {
  try {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const meta = read('revision.json');
    const files = read('files.json');
    const modules = read('modules.json');
    const symbols = read('symbols.json');
    const tests = read('tests.json');
    return {
      root: dir,
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

async function buildMap({ repoPath, workspacesRoot } = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  const abs = path.resolve(repoPath);
  const sha = currentRevision(abs);
  if (!sha) throw new Error(`not a git repository (no HEAD): ${abs}`);

  const dir = mapDirFor({ repoPath: abs, workspacesRoot, sha });
  if (isBuilt(dir)) return { status: 'exists', sha, dir };

  const repoDir = path.dirname(dir);
  return withLock(path.join(repoDir, `${sha}.lock`), async () => {
    if (isBuilt(dir)) return { status: 'exists', sha, dir };

    const indexDir = path.join(dir, 'index');
    fs.mkdirSync(indexDir, { recursive: true });
    const index = buildIndex({ repoPath: abs, outDir: indexDir });
    const { descriptions, available } = await describeModules({
      index,
      cacheFile: path.join(repoDir, 'descriptions.json'),
    });
    const text = renderL0({
      index,
      sha,
      repoPath: abs,
      descriptions,
      descriptionAvailable: available,
    });
    writeJsonAtomic(path.join(dir, 'map-l0.json'), { sha, revision: index.meta.revision, text });
    pruneOldMaps({ repoPath: abs, workspacesRoot });

    return { status: 'built', sha, dir };
  });
}

module.exports = { buildMap, isBuilt, readIndexDir, writeJsonAtomic };
