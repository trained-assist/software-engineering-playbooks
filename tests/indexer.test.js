'use strict';

// Slice 1 (issue #11): deterministic index build + prepare_task index
// preference and stale/incompatible fallback. The raw path must never regress:
// any index that cannot be proven fresh is treated as absent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildIndex, indexCompatibility, INDEX_SCHEMA_VERSION, indexRoot } = require('../src/index');
const { prepareTask } = require('../src/prepare-task');

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo() {
  const dir = tmp('engineering-index-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'task-router.js'), 'function routeTask(task) { return task; }\nmodule.exports = { routeTask };\n');
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), 'class Server { start() {} }\nmodule.exports = { Server };\n');
  fs.writeFileSync(path.join(dir, 'test', 'task-router.test.js'), 'test("task router", () => {});\n');
  fs.writeFileSync(path.join(dir, 'docs', 'architecture.md'), '# Task routing architecture\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'add task router']);
  return dir;
}

test('buildIndex produces the declared deterministic index files', () => {
  const dir = makeRepo();
  const index = buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(index.meta.schemaVersion, INDEX_SCHEMA_VERSION);
  assert.equal(index.meta.revision, git(dir, ['rev-parse', 'HEAD']).trim());
  assert.equal(index.meta.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(index.meta.repository.id);
  assert.equal(index.files.length, 4);
  assert.ok(index.symbols.some((s) => s.name === 'routeTask' && s.path === 'src/task-router.js'));
  assert.ok(index.tests.includes('test/task-router.test.js'));

  for (const file of ['revision.json', 'files.json', 'modules.json', 'symbols.json', 'tests.json']) {
    assert.ok(fs.existsSync(path.join(indexRoot(dir), file)), `${file} should exist`);
  }
});

test('buildIndex is deterministic for a fixed revision and timestamp', () => {
  const dir = makeRepo();
  const stamp = '2026-01-01T00:00:00.000Z';
  const a = buildIndex({ repoPath: dir, outDir: tmp('engineering-index-a-'), generatedAt: stamp });
  const b = buildIndex({ repoPath: dir, outDir: tmp('engineering-index-b-'), generatedAt: stamp });
  const stable = (i) => JSON.stringify({ meta: i.meta, files: i.files, modules: i.modules, hotspots: i.hotspots, symbols: i.symbols, tests: i.tests });
  assert.equal(stable(a), stable(b));
});

test('prepare_task prefers the index when it is fresh, and falls back when absent', () => {
  const dir = makeRepo();

  const withoutIndex = prepareTask({ repoPath: dir, task: 'change task router behavior', preferIndex: true });
  assert.equal(withoutIndex.source, 'raw-repo');

  buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });

  const withIndex = prepareTask({ repoPath: dir, task: 'change task router behavior', preferIndex: true });
  assert.equal(withIndex.source, 'indexed-repo');
  assert.equal(withIndex.context.source, 'indexed-repo');
  assert.ok(withIndex.context.likelyFiles.some((x) => x.file === 'src/task-router.js'));
  assert.ok(withIndex.context.symbolMatches.some((s) => s.name === 'routeTask'));

  const forcedRaw = prepareTask({ repoPath: dir, task: 'change task router behavior', preferIndex: false });
  assert.equal(forcedRaw.source, 'raw-repo');
});

test('prepare_task falls back to raw when the index is stale (revision moved)', () => {
  const dir = makeRepo();
  buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(indexCompatibility(dir).reason, 'ok');

  fs.writeFileSync(path.join(dir, 'src', 'extra.js'), 'module.exports = 42;\n');
  git(dir, ['add', 'src/extra.js']);
  git(dir, ['commit', '-qm', 'add extra']);

  assert.equal(indexCompatibility(dir).usable, false);
  assert.equal(indexCompatibility(dir).reason, 'stale-revision');
  const packet = prepareTask({ repoPath: dir, task: 'change task router behavior', preferIndex: true });
  assert.equal(packet.source, 'raw-repo');
});

test('prepare_task falls back to raw on an incompatible schema version', () => {
  const dir = makeRepo();
  buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });

  const revisionFile = path.join(indexRoot(dir), 'revision.json');
  const meta = JSON.parse(fs.readFileSync(revisionFile, 'utf8'));
  meta.schemaVersion = INDEX_SCHEMA_VERSION + 999;
  fs.writeFileSync(revisionFile, JSON.stringify(meta, null, 2));

  assert.equal(indexCompatibility(dir).reason, 'schema-mismatch');
  const packet = prepareTask({ repoPath: dir, task: 'change task router behavior', preferIndex: true });
  assert.equal(packet.source, 'raw-repo');
});
