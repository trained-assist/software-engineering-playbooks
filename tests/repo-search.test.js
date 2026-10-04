'use strict';

// Issue #110 — engineering_repo_search contract: source-only retrieval over the
// existing per-sha index, honest degradation when no embedding provider is
// configured, stale/deleted files never quoted as current, and an empty answer
// that says it is not proof of absence. Fully deterministic: a temp git repo is
// indexed locally, the embedding credentials are removed from the environment,
// so `npm test` needs no network and no secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { repoSearch } = require('../src/repo-search');
const { buildIndex } = require('../src/index');

const cleanup = [];
const savedEnv = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  ENGINEERING_SEARCH_EMBED_KEY: process.env.ENGINEERING_SEARCH_EMBED_KEY,
  ENGINEERING_WORKSPACE_ROOT: process.env.ENGINEERING_WORKSPACE_ROOT,
};
delete process.env.OPENROUTER_API_KEY;
delete process.env.ENGINEERING_SEARCH_EMBED_KEY;
delete process.env.ENGINEERING_WORKSPACE_ROOT;

test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const FILES = {
  'src/lock.js': [
    'function acquireLock(name) { return name; }',
    'function releaseLock(name) { return name; }',
    'module.exports = { acquireLock, releaseLock };',
    '',
  ].join('\n'),
  'src/parking.js': [
    'function parkMessage(chatId) { return chatId; }',
    'module.exports = { parkMessage };',
    '',
  ].join('\n'),
  'docs/parking.md': [
    '# Очередь застрявших сообщений',
    '',
    'Здесь описано, как пакетное окно решает, что чат застрял, и когда сообщение',
    'возвращается пользователю повторно. Механизм называется park reoffer.',
    '',
  ].join('\n'),
  'README.md': ['# Fixture repository', ''].join('\n'),
};

function makeRepo() {
  const dir = tmp('engineering-repo-search-');
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
  buildIndex({ repoPath: dir, generatedAt: '2026-01-01T00:00:00.000Z' });
  return dir;
}

// One map root per test: the chunk cache is keyed by revision, so the second
// call in a test must reuse the cache the first call wrote — that is exactly
// the state in which freshness (stale / gone) is decided.
function mapsRoot() {
  return tmp('engineering-maps-');
}

function search(repo, query, extra = {}) {
  return repoSearch({ repo_path: repo, query, workspaces_root: extra.workspaces_root || mapsRoot(), ...extra });
}

test('exact identifier query returns the defining file as a source, with revision and line range', async () => {
  const repo = makeRepo();
  const result = await search(repo, 'acquireLock');

  assert.equal(result.hits.length > 0, true, 'expected at least one hit');
  const top = result.hits[0];
  assert.equal(top.path, 'src/lock.js');
  assert.ok(top.start_line >= 1 && top.end_line >= top.start_line, 'line range must be ordered');
  assert.equal(top.commit_sha, git(repo, ['rev-parse', 'HEAD']).trim());
  assert.equal(top.source_ref, `${top.commit_sha}:${top.path}:${top.start_line}-${top.end_line}`);
  assert.ok(typeof top.snippet === 'string' && top.snippet.length > 0, 'a hit must carry a snippet to read');
  assert.equal(result.query, 'acquireLock');
  assert.equal(result.completeness, 'partial');
});

test('natural-language question finds the document that talks about it', async () => {
  const repo = makeRepo();
  const result = await search(repo, 'когда сообщение возвращается пользователю повторно');

  const paths = result.hits.map((h) => h.path);
  assert.ok(paths.includes('docs/parking.md'), `expected docs/parking.md among ${JSON.stringify(paths)}`);
});

test('without embedding credentials dense/hybrid degrade to keyword and say so', async () => {
  const repo = makeRepo();
  const hybrid = await search(repo, 'acquireLock', { strategy: 'hybrid' });
  assert.equal(hybrid.requested_strategy, 'hybrid');
  assert.equal(hybrid.strategy, 'keyword');
  assert.equal(hybrid.degraded, 'no-embeddings-provider');
  assert.equal(hybrid.dense.enabled, false);
  assert.ok(
    hybrid.limitations.some((line) => line.includes('degraded to "keyword"') && line.includes('no-embeddings-provider')),
    `degradation must be reported: ${JSON.stringify(hybrid.limitations)}`,
  );

  const dense = await search(repo, 'acquireLock', { strategy: 'dense' });
  assert.equal(dense.requested_strategy, 'dense');
  assert.equal(dense.strategy, 'keyword');
  assert.equal(dense.degraded, 'no-embeddings-provider');
  assert.ok(dense.hits.length > 0, 'degraded search still answers lexically');
});

test('an unknown strategy is rejected instead of silently falling back', async () => {
  const repo = makeRepo();
  await assert.rejects(() => search(repo, 'acquireLock', { strategy: 'magic' }), (err) => err.code === 'INVALID_STRATEGY');
});

test('repo_path and query are required', async () => {
  await assert.rejects(() => repoSearch({ query: 'x' }), (err) => /repo_path is required/.test(err.message));
  await assert.rejects(() => repoSearch({ repo_path: '/definitely/not/here', query: 'x' }), (err) => err.code === 'REPO_NOT_FOUND');
  await assert.rejects(() => repoSearch({ repo_path: os.tmpdir(), query: '   ' }), (err) => /query is required/.test(err.message));
});

test('a file changed after the indexed revision is excluded, never quoted as current', async () => {
  const repo = makeRepo();
  const root = mapsRoot();
  const before = await search(repo, 'parkMessage', { workspaces_root: root });
  assert.ok(before.hits.some((h) => h.path === 'src/parking.js'));

  fs.writeFileSync(path.join(repo, 'src/parking.js'), 'function parkMessage(chatId) { return "changed"; }\nmodule.exports = { parkMessage };\n');
  const after = await search(repo, 'parkMessage', { workspaces_root: root });

  assert.equal(after.hits.some((h) => h.path === 'src/parking.js'), false, 'changed file must not be served as current');
  assert.ok(after.stale_files.some((s) => s.path === 'src/parking.js'), `stale must be reported: ${JSON.stringify(after.stale_files)}`);
  assert.ok(after.limitations.some((line) => line.includes('changed after the indexed revision')));

  const withStale = await search(repo, 'parkMessage', { workspaces_root: root, include_stale: true });
  const staleHit = withStale.hits.find((h) => h.path === 'src/parking.js');
  assert.ok(staleHit, 'include_stale must bring the hit back');
  assert.equal(staleHit.stale, true);
});

test('a file deleted after the indexed revision is dropped, not served', async () => {
  const repo = makeRepo();
  const root = mapsRoot();
  const before = await search(repo, 'parkMessage', { workspaces_root: root });
  assert.ok(before.hits.some((h) => h.path === 'src/parking.js'));

  fs.rmSync(path.join(repo, 'src/parking.js'));
  const result = await search(repo, 'parkMessage', { workspaces_root: root });

  assert.equal(result.hits.some((h) => h.path === 'src/parking.js'), false);
  assert.ok(result.dropped_stale.some((d) => d.path === 'src/parking.js' && d.reason === 'file-gone-from-working-tree'));
});

test('an empty answer states that no match is not proof of absence', async () => {
  const repo = makeRepo();
  const result = await search(repo, 'quantumBlockchainLedger');

  assert.equal(result.hits.length, 0, 'a query with no lexical overlap must not invent sources');
  assert.ok(result.limitations.some((line) => line.includes('No match is not proof of absence')));
  assert.ok(result.limitations.some((line) => line.includes('Module summaries are discovery-only')));
  assert.ok(result.index.chunks > 0, 'the answer must say what was actually searched');
  assert.ok(result.observed_at);
});

test('the tool is registered with the required inputs', () => {
  const registry = require('../src/mcp-skills/registry');
  const tool = registry.listTools().find((t) => t.name === 'engineering_repo_search');
  assert.ok(tool, 'engineering_repo_search must be registered');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['query', 'repo_path']);
  const strategies = tool.inputSchema.properties.strategy.enum;
  assert.deepEqual([...strategies].sort(), ['auto', 'dense', 'hybrid', 'keyword']);
  assert.ok(/degrade/i.test(tool.description), 'the description must promise honest degradation');
  assert.ok(/measured|recall/i.test(tool.description), 'the description must carry the measurement');
});

test('auto without an embedding provider answers lexically and says what it could not do', async () => {
  const repo = makeRepo();
  const result = await search(repo, 'acquireLock');

  assert.equal(result.requested_strategy, 'auto');
  assert.equal(result.strategy, 'keyword');
  assert.equal(result.degraded, 'no-embeddings-provider');
  assert.ok(
    result.limitations.some((line) => line.includes('lexical ranker answered alone') && line.includes('cross-lingual')),
    `auto must disclose the missing semantic pass: ${JSON.stringify(result.limitations)}`,
  );
  assert.ok(result.hits.length > 0, 'the lexical answer still stands');
});

test('auto keeps a confident lexical hit lexical and escalates only when lexical has none', async () => {
  const repo = makeRepo();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/api/v1/embeddings')) return realFetch(url, options);
    const body = JSON.parse(options.body);
    const data = body.input.map((text) => {
      const vec = new Array(32).fill(0);
      for (const ch of String(text)) vec[ch.charCodeAt(0) % 32] += 1;
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return { embedding: vec.map((v) => v / norm) };
    });
    return { ok: true, json: async () => ({ data }) };
  };

  try {
    const confident = await search(repo, 'acquireLock', { api_key: 'test-key' });
    assert.equal(confident.requested_strategy, 'auto');
    assert.equal(confident.strategy, 'keyword', 'a confident lexical hit must not pay the embedding pass');
    assert.equal(confident.dense.enabled, false);
    assert.equal(confident.limitations.some((line) => line.includes('semantic pass')), false);

    const crossLingual = await search(repo, 'где блокируется запуск задачи', { api_key: 'test-key' });
    assert.equal(crossLingual.strategy, 'dense', 'no confident lexical hit must escalate to semantic ranking');
    assert.equal(crossLingual.dense.enabled, true);
    assert.ok(
      crossLingual.limitations.some((line) => line.includes('Lexical ranking had no confident match')),
      `escalation must be reported: ${JSON.stringify(crossLingual.limitations)}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
