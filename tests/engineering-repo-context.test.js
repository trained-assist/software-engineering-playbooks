'use strict';

// Slice 2 (issue #11): engineering_repo_context returns ranked {path,line,
// snippet,why} from a fresh index, and the deterministic raw ranking otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { repoContext } = require('../src/context-sources/repo-context');
const { buildIndex } = require('../src/index');
const { callTool } = require('../src/mcp-skills/registry');

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
  const dir = tmp('engineering-context-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'task-router.js'), 'function routeTask(task) { return task; }\nmodule.exports = { routeTask };\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'add task router']);
  return dir;
}

function assertEntryShape(entry) {
  assert.equal(typeof entry.path, 'string');
  assert.ok(entry.line === null || typeof entry.line === 'number');
  assert.equal(typeof entry.snippet, 'string');
  assert.equal(typeof entry.why, 'string');
}

test('repoContext uses deterministic raw ranking when no index exists', () => {
  const dir = makeRepo();
  const result = repoContext({ repoPath: dir, keywords: ['task', 'router'] });
  assert.equal(result.source, 'raw-repo');
  assert.ok(result.entries.length > 0);
  for (const entry of result.entries) assertEntryShape(entry);
  const hit = result.entries.find((e) => e.path === 'src/task-router.js');
  assert.ok(hit, 'expected the matching source file');
  assert.equal(hit.line, 1);
  assert.match(hit.snippet, /routeTask/);
  assert.match(hit.why, /content match/);
});

test('repoContext queries the index when it is fresh', () => {
  const dir = makeRepo();
  buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });
  const result = repoContext({ repoPath: dir, keywords: ['task', 'router'] });
  assert.equal(result.source, 'indexed-repo');
  for (const entry of result.entries) assertEntryShape(entry);
  const symbol = result.entries.find((e) => e.path === 'src/task-router.js' && e.line === 1);
  assert.ok(symbol, 'expected an indexed symbol entry');
  assert.match(symbol.snippet, /routeTask/);
  assert.match(symbol.why, /symbol/);
});

test('budget caps the returned entries', () => {
  const dir = makeRepo();
  const result = repoContext({ repoPath: dir, keywords: ['task', 'router'], budget: 1 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.count, 1);
});

test('engineering_repo_context is callable through the MCP registry and accepts a string keyword', async () => {
  const dir = makeRepo();
  const result = await callTool('engineering_repo_context', { repo_path: dir, keywords: 'task router' });
  assert.equal(result.source, 'raw-repo');
  assert.ok(result.keywords.includes('router'));
  assert.ok(result.entries.length > 0);
});
