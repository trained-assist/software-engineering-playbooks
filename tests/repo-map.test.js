'use strict';

// repo_map (issue #49): the shared per-sha cache, the L0/L1 renders, the MCP
// tool and the background build on spawn. Every assertion here is a slice test
// from docs/repo-map/proposal.md §4 — the sandbox (scripts/sandbox/repo-map.mjs)
// is the e2e contract, these are the unit contracts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildMap, renderMap, mapStatus } = require('../src/repo-map');
const { resolveIndexRoot, mapDirFor, mapsRoot } = require('../src/repo-map/paths');
const { buildIndex, indexRoot } = require('../src/index');
const registry = require('../src/mcp-skills/registry');

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
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Conservative deterministic estimator, same as the sandbox: ceil(len/3).
const estTokens = (text) => Math.ceil(text.length / 3);

function makeRepo() {
  const dir = tmp('repo-map-src-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', main: 'src/server.js' }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), "'use strict';\nclass Server {\n  start() { return 'up'; }\n}\nmodule.exports = { Server };\n");
  fs.writeFileSync(path.join(dir, 'src', 'router.js'), "'use strict';\nfunction routeTask(task) { return task; }\nconst formatTask = (t) => `task:${t}`;\nmodule.exports = { routeTask, formatTask };\n");
  fs.writeFileSync(path.join(dir, 'tests', 'router.test.js'), "test('route', () => {});\n");
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'arch.md'), '# Architecture\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture v1']);
  return dir;
}

function commit(repo, rel, content) {
  fs.writeFileSync(path.join(repo, rel), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', `add ${rel}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

test('shared cache: two checkouts of one commit resolve to one map directory', async () => {
  const workspacesRoot = tmp('repo-map-ws-');
  const a = makeRepo();
  const sha = git(a, ['rev-parse', 'HEAD']);

  const remote = tmp('repo-map-remote-');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(a, ['remote', 'add', 'origin', remote]);
  git(a, ['push', '-q', 'origin', 'main']);
  const b = tmp('repo-map-clone-');
  execFileSync('git', ['clone', '-q', remote, b]);

  const dirA = mapDirFor({ repoPath: a, workspacesRoot, sha });
  const dirB = mapDirFor({ repoPath: b, workspacesRoot, sha });
  assert.equal(dirA, dirB, 'one commit → one cache directory');

  const built = await buildMap({ repoPath: a, workspacesRoot });
  assert.equal(built.status, 'built');
  assert.ok(dirA.startsWith(mapsRoot(workspacesRoot)), 'cache lives under <workspacesRoot>/repo-maps');

  const seen = await renderMap({ repoPath: b, workspacesRoot, level: 0 });
  assert.equal(seen.status, 'ready');
  assert.equal(seen.sha, sha);
  assert.equal(mapStatus({ repoPath: b, workspacesRoot }).status, 'ready', 'clone reads the shared cache');

  assert.ok(!fs.existsSync(path.join(b, '.engineering', 'index')), 'no worktree pollution');
  assert.ok(!fs.existsSync(path.join(a, '.engineering', 'index')), 'source checkout untouched too');
});

test('resolveIndexRoot prefers the checkout legacy index and falls back to the shared one', async () => {
  const workspacesRoot = tmp('repo-map-seam-');
  const repo = makeRepo();
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const legacy = indexRoot(repo);
  const shared = mapDirFor({ repoPath: repo, workspacesRoot, sha });

  // No index anywhere → legacy (the place a fresh build would write).
  assert.equal(resolveIndexRoot(repo, { workspacesRoot }), legacy);

  // Only the shared copy exists → a fresh worktree resolves it.
  fs.mkdirSync(path.join(shared, 'index'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'index', 'revision.json'), '{}');
  assert.equal(resolveIndexRoot(repo, { workspacesRoot }), path.join(shared, 'index'));

  // A checkout owning its own index wins: it is fresh for its own HEAD.
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'revision.json'), '{}');
  assert.equal(resolveIndexRoot(repo, { workspacesRoot }), legacy);
});

test('L0 fits the 2k-token budget with an honest header, L1 is byte-stable', async () => {
  const workspacesRoot = tmp('repo-map-l0-');
  const repo = makeRepo();
  const sha = git(repo, ['rev-parse', 'HEAD']);

  const l0 = await renderMap({ repoPath: repo, workspacesRoot, level: 0 });
  assert.equal(l0.status, 'ready');
  assert.ok(l0.text.trim().length > 0, 'never empty');
  assert.ok(estTokens(l0.text) <= 2000, `L0 budget: ${estTokens(l0.text)} tokens`);
  const head = l0.text.split('\n').slice(0, 15).join('\n');
  assert.ok(head.includes(sha.slice(0, 8)), 'header carries the commit');
  assert.match(head, /опущено/i, 'header says what is omitted');
  assert.match(head, /L1|скелет/i, 'header says how to get more');
  assert.match(l0.text, /router/);
  assert.match(l0.text, /server/);
  assert.match(l0.text, /тест/i);

  const a = await renderMap({ repoPath: repo, workspacesRoot, level: 1 });
  const b = await renderMap({ repoPath: repo, workspacesRoot, level: 1 });
  assert.equal(a.status, 'ready');
  assert.equal(a.text, b.text, 'L1 is byte-for-byte reproducible');
  for (const token of ['routeTask', 'formatTask', 'class Server', 'start(', 'src/router.js']) {
    assert.ok(a.text.includes(token), `L1 carries «${token}»`);
  }

  const focused = await renderMap({ repoPath: repo, workspacesRoot, level: 1, focus: ['routeTask'] });
  const iRouter = focused.text.indexOf('src/router.js');
  const iServer = focused.text.indexOf('src/server.js');
  assert.ok(iRouter !== -1 && iServer !== -1);
  assert.ok(iRouter < iServer, 'focus lifts the matching file above the rest');
});

test('a new commit invalidates the map lazily; a foreign sha is never served', async () => {
  const workspacesRoot = tmp('repo-map-inv-');
  const repo = makeRepo();

  const first = await renderMap({ repoPath: repo, workspacesRoot, level: 0 });
  const sha1 = first.sha;

  const sha2 = commit(repo, 'src/feature.js', "'use strict';\nmodule.exports = { feature: true };\n");
  assert.equal(mapStatus({ repoPath: repo, workspacesRoot }).status, 'missing', 'old map is not the new commit');

  const second = await renderMap({ repoPath: repo, workspacesRoot, level: 0 });
  assert.equal(second.sha, sha2, 'rebuilt on demand for the new commit');
  assert.notEqual(sha2, sha1);
  assert.match(second.text, /feature/);

  const foreign = await renderMap({ repoPath: repo, workspacesRoot, level: 0, sha: '0'.repeat(40) });
  assert.notEqual(foreign.status, 'ready');
  assert.ok(foreign.text.trim().length > 0, 'even the mismatch answer explains what to do');

  assert.notEqual(mapStatus({ repoPath: repo, workspacesRoot }).sha, '0'.repeat(40));
});

test('descriptions come from the LLM only when a key is present', async () => {
  const workspacesRoot = tmp('repo-map-llm-');
  const repo = makeRepo();
  const MARK = 'МОК-ОПИСАНИЕ МОДУЛЯ';

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: MARK } }] }) };
  };
  try {
    delete process.env.OPENROUTER_API_KEY;
    const plain = await renderMap({ repoPath: repo, workspacesRoot, level: 0 });
    assert.equal(calls, 0, 'no key → no model call');
    assert.ok(!plain.text.includes(MARK), 'structure only');

    process.env.OPENROUTER_API_KEY = 'sk-test';
    // The no-key map above already exists for this commit; without a key the
    // build never described anything, so it has to be rebuilt, not reused.
    fs.rmSync(mapsRoot(workspacesRoot), { recursive: true, force: true });
    const described = await renderMap({ repoPath: repo, workspacesRoot, level: 0 });
    assert.ok(calls > 0, `model called (${calls}×)`);
    assert.ok(described.text.includes(MARK), 'description lands in the map');

    const before = calls;
    const again = await buildMap({ repoPath: repo, workspacesRoot });
    assert.equal(again.status, 'exists');
    assert.equal(calls, before, 'rebuild of a known commit costs nothing');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test('repo_map tool: registered, never empty, answers with the current commit', async () => {
  const workspacesRoot = tmp('repo-map-tool-');
  const repo = makeRepo();
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const originalRoot = process.env.ENGINEERING_WORKSPACE_ROOT;
  process.env.ENGINEERING_WORKSPACE_ROOT = workspacesRoot;
  try {
    const names = registry.listTools().map((t) => t.name);
    assert.ok(names.includes('repo_map'), 'tool is registered');
    assert.ok(require('../provider-manifest.json').actions.some((a) => a.name === 'repo_map'), 'manifest exposes it');

    const empty = await registry.callTool('repo_map', {});
    assert.ok(String(empty).trim(), 'no arguments → an explanation, never silence');

    const out = await registry.callTool('repo_map', { repo, level: 0 });
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    assert.ok(text.trim());
    assert.ok(text.includes(sha.slice(0, 8)), 'answer carries the current commit');
    assert.ok(/status=ready/.test(text), 'explicit status');
  } finally {
    if (originalRoot === undefined) delete process.env.ENGINEERING_WORKSPACE_ROOT;
    else process.env.ENGINEERING_WORKSPACE_ROOT = originalRoot;
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('spawn builds the map in the background and status reports it', async () => {
  const { spawnWorkspaceForTask, statusWorkspaceForTask } = require('../src/workspace');
  const workspaceRoot = tmp('repo-map-spawn-ws-');
  const mirrorsRoot = tmp('repo-map-spawn-mirrors-');
  const source = makeRepo();
  const remote = tmp('repo-map-spawn-remote-');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', '-q', 'origin', 'main']);

  const opts = {
    principal: 'tester',
    repositoryUrl: remote,
    rootTaskId: 'repo-map-hook',
    workspaceRoot,
    mirrorsRoot,
  };
  const spawned = spawnWorkspaceForTask(opts);
  assert.equal(spawned.status, 'code_ready');

  const status = statusWorkspaceForTask(opts);
  assert.ok(status.repoMap && typeof status.repoMap.status === 'string', 'status carries the map state');

  // The build must not block spawn, but it must finish on its own.
  const deadline = Date.now() + 20000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = mapStatus({ repoPath: spawned.codePath, workspacesRoot: workspaceRoot }).status === 'ready';
    if (!ready) await sleep(200);
  }
  assert.ok(ready, 'background build completed after spawn returned');
  assert.ok(fs.existsSync(mapsRoot(workspaceRoot)), 'cache root created under the workspace root');
});

test('REPO_MAP_SPAWN_BUILD=0 turns the spawn hook off', async () => {
  const { spawnWorkspaceForTask } = require('../src/workspace');
  const workspaceRoot = tmp('repo-map-kill-ws-');
  const mirrorsRoot = tmp('repo-map-kill-mirrors-');
  const source = makeRepo();
  const remote = tmp('repo-map-kill-remote-');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', '-q', 'origin', 'main']);

  const original = process.env.REPO_MAP_SPAWN_BUILD;
  process.env.REPO_MAP_SPAWN_BUILD = '0';
  try {
    const spawned = spawnWorkspaceForTask({
      principal: 'tester',
      repositoryUrl: remote,
      rootTaskId: 'repo-map-kill',
      workspaceRoot,
      mirrorsRoot,
    });
    assert.equal(spawned.status, 'code_ready');
    await sleep(500);
    assert.equal(
      mapStatus({ repoPath: spawned.codePath, workspacesRoot: workspaceRoot }).status,
      'missing',
      'kill-switch: no map is built',
    );
  } finally {
    if (original === undefined) delete process.env.REPO_MAP_SPAWN_BUILD;
    else process.env.REPO_MAP_SPAWN_BUILD = original;
  }
});
