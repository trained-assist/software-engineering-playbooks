'use strict';

// Issue #113 — engineering_verify contract.
//
// Deterministic by construction: GitHub is a routed stub, the judge is either
// stubbed or explicitly starved of a key, the workspace and the store are real
// temp directories. The five acceptance fixtures of #113 each get their own
// case — missing feature, partial implementation, stale evidence, wrong
// repository, unavailable judge — plus the five acceptance criteria: per-REQ
// traceability, «file existence ≠ tool receipt», an immutable requirement set
// for the judge, and one capability behind three facades.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { verify, overallVerdict } = require('../src/verify');
const { evaluateStages } = require('../src/change-status/stages');
const { readVerification } = require('../src/change-status/verification');
const store = require('../src/workspace/store');
const registry = require('../src/mcp-skills/registry');

const REPO = 'trained-assist/software-engineering-playbooks';
const ME = 'trained-assist-product-owner';
const AT = '2026-10-04T00:00:00.000Z';
const SHA_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const SHA_OLD = '9999999999999999999999999999999999999999';

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpRoot(prefix = 'eng-verify-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function gh404(message = 'Not Found') {
  const e = new Error(`GitHub API 404: ${message}`);
  e.status = 404;
  return e;
}
function gh401(message = 'Bad credentials') {
  const e = new Error(`GitHub API 401: ${message}`);
  e.status = 401;
  return e;
}

/** Route table: { match, reply } — reply may be a value, a function or an Error. */
function makeGh(routes, calls = []) {
  const ghFetch = async (rawPath) => {
    const p = decodeURIComponent(String(rawPath));
    calls.push(p);
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(p)
        : route.match instanceof RegExp ? route.match.test(p)
          : p.includes(route.match);
      if (!hit) continue;
      if (route.reply instanceof Error) throw route.reply;
      return typeof route.reply === 'function' ? route.reply(p) : route.reply;
    }
    throw gh404(`no route for ${p}`);
  };
  return { ghFetch, calls };
}

/** Commit pinning for any repository; check/status paths are left to other routes. */
const commitRoute = (sha = SHA_A) => ({ match: /\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/, reply: { sha } });

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function makeGitRepo(files = {}, parent = null) {
  const dir = parent ? fs.mkdirSync(path.join(parent, 'repo'), { recursive: true }) || path.join(parent, 'repo') : tmpRoot('eng-verify-git-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  return dir;
}

function seedWorkspace(root, record) {
  const dirs = store.storeDirs(root);
  fs.mkdirSync(dirs.workspaces, { recursive: true });
  const id = record.workspaceId || `ws-${Math.random().toString(16).slice(2, 10)}`;
  const full = {
    schemaVersion: 1,
    workspaceId: id,
    repositoryId: REPO,
    principal: ME,
    status: 'code_ready',
    rootTaskId: 'verify-113',
    createdAt: AT,
    updatedAt: AT,
    ...record,
    workspaceId: id,
  };
  fs.writeFileSync(path.join(dirs.workspaces, `${id}.json`), JSON.stringify(full, null, 2));
  return full;
}

const noJudge = { judge: false };
const baseDeps = (extra = {}) => ({ principal: ME, workspaceRoot: tmpRoot(), ghFetch: makeGh([commitRoute()]).ghFetch, apiKey: '', ...extra });

// ── фикстуры приёмки ─────────────────────────────────────────────────────────

test('missing feature: the pinned commit has no such file → not_met, per-REQ traceability', async () => {
  const root = tmpRoot();
  const { ghFetch, calls } = makeGh([
    { match: '/repos/x/y/commits/', reply: { sha: SHA_A } },
    { match: '/contents/', reply: gh404('src/new-feature.js does not exist') },
  ]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'модуль src/new-feature.js добавлен', checks: [{ kind: 'file_at_commit', path: 'src/new-feature.js' }] }],
    target: { repo: 'x/y', commit: SHA_A },
    scope: 'implementation',
    budget: noJudge,
  }, { ...baseDeps({ ghFetch, workspaceRoot: root }) });

  assert.equal(out.verdict, 'not_met');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].verdict, 'not_satisfied');
  assert.equal(out.results[0].source, 'deterministic');
  assert.equal(out.target.pinned_sha, SHA_A);
  assert.ok(calls.some((c) => c.includes('/contents/src/new-feature.js')));
  assert.equal(out.receipt.written, true);
  assert.equal(out.receipt.commit, SHA_A);
  assert.equal(out.receipt.verdict, 'not_met');
});

test('partial implementation: one requirement proven, one refuted → partial (a single pass is never the whole answer)', async () => {
  const { ghFetch } = makeGh([
    { match: '/repos/x/y/commits/', reply: { sha: SHA_A } },
    { match: '/contents/src/ok.js', reply: { type: 'file', sha: 'blob1', size: 10 } },
    { match: '/contents/src/missing.js', reply: gh404('missing') },
  ]);
  const out = await verify({
    requirements: [
      { id: 'R1', text: 'src/ok.js существует', checks: [{ kind: 'file_at_commit', path: 'src/ok.js' }] },
      { id: 'R2', text: 'src/missing.js существует', checks: [{ kind: 'file_at_commit', path: 'src/missing.js' }] },
    ],
    target: { repo: 'x/y', commit: SHA_A },
    budget: noJudge,
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.verdict, 'partial');
  assert.deepEqual(out.results.map((r) => r.verdict), ['satisfied', 'not_satisfied']);
  assert.ok(out.results.every((r) => r.id && r.reason));
  assert.equal(out.results[0].evidence.length, 1);
});

test('stale evidence: a claim bound to another revision becomes a gap, not evidence → inconclusive', async () => {
  const { ghFetch } = makeGh([{ match: '/repos/x/y/commits/', reply: { sha: SHA_A } }]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'требование без детерминированных проверок' }],
    target: { repo: 'x/y', commit: SHA_A },
    evidence_refs: [`ci:x/y@${SHA_OLD}`],
    budget: noJudge,
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.verdict, 'inconclusive');
  assert.ok(out.gaps.some((g) => g.code === 'STALE_EVIDENCE'), JSON.stringify(out.gaps));
  assert.equal(out.evidence.length, 0);
  assert.equal(out.results[0].verdict, 'unknown');
});

test('wrong repository: a workspace or URL that belongs elsewhere is an input error, not a verdict', async () => {
  const root = tmpRoot();
  const codePath = makeGitRepo({ 'src/app.js': 'x\n' });
  seedWorkspace(root, { workspaceId: 'ws-wrong', repositoryId: 'other/repo', codePath });

  await assert.rejects(
    () => verify({ requirements: ['a'], target: { repo: REPO, workspace_ref: 'ws-wrong' }, budget: noJudge }, baseDeps({ workspaceRoot: root })),
    (e) => e.code === 'TARGET_MISMATCH'
  );
  await assert.rejects(
    () => verify({ requirements: ['a'], target: { repo: 'x/y', pr: 5, url: 'https://github.com/c/d/pull/5' }, budget: noJudge }, baseDeps()),
    (e) => e.code === 'TARGET_MISMATCH'
  );
});

test('unavailable judge: no key → unknown per requirement, inconclusive overall, never pass', async () => {
  const { ghFetch } = makeGh([{ match: '/repos/x/y/commits/', reply: { sha: SHA_A } }]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'пользовательский сценарий описан в docs/' }],
    target: { repo: 'x/y', commit: SHA_A },
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.verdict, 'inconclusive');
  assert.equal(out.results[0].verdict, 'unknown');
  assert.equal(out.judge.available, false);
  assert.ok(out.limitations.some((l) => l.code === 'JUDGE_UNAVAILABLE'));
});

test('a judge that fails mid-call (HTTP 500) is a limitation, not a failure of the requirement', async () => {
  const { ghFetch } = makeGh([{ match: '/repos/x/y/commits/', reply: { sha: SHA_A } }]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'требование только для судьи' }],
    target: { repo: 'x/y', commit: SHA_A },
  }, {
    ...baseDeps({ ghFetch, apiKey: 'sk-test' }),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(out.verdict, 'inconclusive');
  assert.ok(out.limitations.some((l) => l.code === 'JUDGE_UNAVAILABLE' && /HTTP_500/.test(l.message)));
});

// ── критерии приёмки ─────────────────────────────────────────────────────────

test('file existence never replaces a tool receipt / output validation', async () => {
  const { ghFetch } = makeGh([
    { match: '/repos/x/y/commits/', reply: { sha: SHA_A } },
    { match: '/contents/', reply: { type: 'file', sha: 'blob1', size: 10 } },
  ]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'инструмент отдаёт отчёт', evidence: 'output', checks: [{ kind: 'file_at_commit', path: 'src/tool.js' }] }],
    target: { repo: 'x/y', commit: SHA_A },
    budget: noJudge,
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.verdict, 'inconclusive');
  assert.equal(out.results[0].verdict, 'unknown');
  assert.ok(out.results[0].gaps.some((g) => g.code === 'OUTPUT_REQUIRED'), JSON.stringify(out.results[0].gaps));
});

test('a command check is inert until run_checks is on, and only inside the isolated workspace', async () => {
  const root = tmpRoot();
  const codePath = makeGitRepo({ 'src/app.js': 'x\n' }, root);
  seedWorkspace(root, { workspaceId: 'ws-iso', repositoryId: REPO, codePath });
  const target = { repo: REPO, workspace_ref: 'ws-iso' };
  const reqs = [{ id: 'R1', text: 'тест зелёный', evidence: 'output', checks: [{ kind: 'command', command: 'test -f src/app.js && echo VERIFIED_OK' }] }];

  const off = await verify({ requirements: reqs, target, budget: noJudge }, baseDeps({ workspaceRoot: root }));
  assert.equal(off.verdict, 'inconclusive');
  assert.equal(off.results[0].checks[0].reason_code, 'COMMAND_CHECK_DISABLED');

  const on = await verify({ requirements: reqs, target, run_checks: true, budget: noJudge }, baseDeps({ workspaceRoot: root }));
  assert.equal(on.verdict, 'verified');
  assert.equal(on.results[0].checks[0].receipt_type, 'output');
  assert.match(on.results[0].checks[0].evidence_ref, /cmd:/);

  // Same store (the record resolves) but a code path outside the workspace
  // root: the command must still be refused — isolation is about the disk.
  const outside = makeGitRepo({ 'src/app.js': 'x\n' });
  seedWorkspace(root, { workspaceId: 'ws-foreign', repositoryId: REPO, codePath: outside });
  const foreign = await verify({
    requirements: reqs,
    target: { repo: REPO, workspace_ref: 'ws-foreign' },
    run_checks: true,
    budget: noJudge,
  }, baseDeps({ workspaceRoot: root }));
  assert.equal(foreign.verdict, 'inconclusive');
  assert.equal(foreign.results[0].checks[0].reason_code, 'NOT_ISOLATED_WORKSPACE');
});

test('CI with zero checks is unknown — «green» cannot come from an empty run', async () => {
  const { ghFetch } = makeGh([
    { match: '/check-runs', reply: { total_count: 0, check_runs: [] } },
    { match: '/status', reply: {} },
    { match: '/repos/x/y/commits/', reply: { sha: SHA_A } },
  ]);
  const out = await verify({
    requirements: [{ id: 'R1', text: 'CI зелёный', checks: [{ kind: 'ci_green' }] }],
    target: { repo: 'x/y', commit: SHA_A },
    budget: noJudge,
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.verdict, 'inconclusive');
  assert.equal(out.results[0].checks[0].reason_code, 'CI_NO_CHECKS');
});

test('the judge cannot update accepted requirements to get a pass', async () => {
  const { ghFetch } = makeGh([{ match: '/repos/x/y/commits/', reply: { sha: SHA_A } }]);
  const items = [{ id: 'R1', text: 'оригинальная формулировка требования' }];
  const before = require('../src/verify/requirements').hashRequirements(
    require('../src/verify/requirements').normalizeExplicit(items)
  );

  const out = await verify({
    requirements: items,
    target: { repo: 'x/y', commit: SHA_A },
  }, {
    ...baseDeps({ ghFetch }),
    judge: async ({ items: handed }) => ({
      available: true,
      model: 'stub',
      results: {
        [handed[0].id]: { verdict: 'satisfied', rationale: 'доказано' },
        R9: { verdict: 'satisfied', rationale: 'выдуманный id' },
      },
    }),
  });

  assert.equal(out.verdict, 'verified');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 'R1');
  assert.equal(out.results[0].text, 'оригинальная формулировка требования');
  assert.equal(out.requirements.hash, before);
  assert.equal(out.requirements.frozen_before_judge, true);
  assert.equal(out.receipt.requirements_revision, out.requirements.revision);
});

test('an unreadable requirements source fails honestly — never as «no requirements»', async () => {
  const { ghFetch } = makeGh([{ match: `/repos/${REPO}/issues/113`, reply: gh401('Bad credentials') }]);
  await assert.rejects(
    () => verify({ requirements_ref: `issue#${REPO.split('/')[1] === 'software-engineering-playbooks' ? 113 : 113}`, repo: REPO, target: { repo: REPO, commit: SHA_A } }, baseDeps({ ghFetch })),
    (e) => e.code === 'REQUIREMENTS_SOURCE_UNREADABLE'
  );
});

test('issue# requirements source: list items become requirements, revision travels into the receipt', async () => {
  const body = ['## Результат', '- первое требование должно быть выполнено', '- второе требование тоже обязательно', '```js\n- не требование\n```'].join('\n');
  const { ghFetch } = makeGh([
    { match: `/repos/${REPO}/issues/113`, reply: { body, updated_at: '2026-10-03T20:13:36Z' } },
    { match: '/repos/x/y/commits/', reply: { sha: SHA_A } },
    { match: '/contents/', reply: { type: 'file', sha: 'blob1', size: 3 } },
  ]);
  const out = await verify({
    requirements_ref: `issue#113`,
    repo: REPO,
    target: { repo: 'x/y', commit: SHA_A },
    budget: noJudge,
  }, { ...baseDeps({ ghFetch }) });

  assert.equal(out.requirements.count, 2);
  assert.equal(out.requirements.revision, 'issue#113');
  assert.equal(out.receipt.requirements_revision, 'issue#113');
  assert.equal(out.results[0].text, 'первое требование должно быть выполнено');
});

// ── receipt → change_status ─────────────────────────────────────────────────

test('change_status reads the receipt verify wrote: pass → satisfied, partial → not_satisfied', async () => {
  const root = tmpRoot();
  const codePath = makeGitRepo({ 'src/app.js': 'x\n' });
  const head = git(codePath, 'rev-parse', 'HEAD');
  seedWorkspace(root, { workspaceId: 'ws-round', repositoryId: REPO, codePath });

  const out = await verify({
    requirements: [{ id: 'R1', text: 'файл на месте', checks: [{ kind: 'workspace_file', path: 'src/app.js' }] }],
    target: { repo: REPO, workspace_ref: 'ws-round' },
    budget: noJudge,
  }, baseDeps({ workspaceRoot: root }));
  assert.equal(out.verdict, 'verified');

  const read = readVerification({ workspaceRoot: root, principal: ME, repositoryId: REPO, kind: 'commit', change: { sha: head } });
  assert.equal(read.found, true);
  assert.equal(read.record.verdict, 'pass');
  assert.equal(read.record.commit, head);

  const facts = { git: { available: null, reason: 'нет локальных фактов в тесте' }, verification: read, delivered: { verdict: 'live', health_commit: head, merge_commit: head } };
  const ok = evaluateStages(facts, { observedAt: AT });
  assert.equal(ok.verified.status, 'satisfied');

  const partial = { ...read.record, verdict: 'partial' };
  const bad = evaluateStages({ ...facts, verification: { ...read, record: partial } }, { observedAt: AT });
  assert.equal(bad.verified.status, 'not_satisfied');
  assert.match(bad.verified.reason, /partial/);
});

test('without a profile the verdict is still returned, but no record is written (limitation, not silence)', async () => {
  const root = tmpRoot();
  const out = await verify({
    requirements: [{ id: 'R1', text: 'x', checks: [{ kind: 'file_at_commit', path: 'a.js' }] }],
    target: { repo: 'x/y', commit: SHA_A },
    budget: noJudge,
  }, { ...baseDeps({ principal: '' }), workspaceRoot: root });
  assert.equal(out.receipt, null);
  assert.ok(out.limitations.some((l) => l.code === 'NO_PRINCIPAL'));
  const vdir = path.join(root, 'verifications');
  assert.ok(!fs.existsSync(vdir) || fs.readdirSync(vdir).length === 0);
});

// ── один capability — три фасада ────────────────────────────────────────────

function facadeArgs(root) {
  const requirements = [{ id: 'R1', text: 'файл на месте', checks: [{ kind: 'workspace_file', path: 'src/app.js' }] }];
  return { requirements, target: { repo: REPO, workspace_ref: 'ws-facade' }, budget: noJudge, _storeRoot: root };
}

test('one capability, three facades: module, MCP registry and CLI agree', async () => {
  const root = tmpRoot();
  const codePath = makeGitRepo({ 'src/app.js': 'x\n' }, root);
  seedWorkspace(root, { workspaceId: 'ws-facade', repositoryId: REPO, codePath });
  const args = facadeArgs(root);

  const viaModule = await verify(args, baseDeps({ workspaceRoot: root }));
  assert.equal(viaModule.verdict, 'verified');

  const savedUser = process.env.USER_ID;
  const savedRoot = process.env.ENGINEERING_WORKSPACE_ROOT;
  process.env.USER_ID = ME;
  process.env.ENGINEERING_WORKSPACE_ROOT = root;
  let viaRegistry;
  try {
    viaRegistry = await registry.callTool('engineering_verify', {
      requirements: args.requirements,
      target: args.target,
      budget: noJudge,
    });
  } finally {
    if (savedUser === undefined) delete process.env.USER_ID; else process.env.USER_ID = savedUser;
    if (savedRoot === undefined) delete process.env.ENGINEERING_WORKSPACE_ROOT; else process.env.ENGINEERING_WORKSPACE_ROOT = savedRoot;
  }
  assert.equal(viaRegistry.verdict, 'verified');
  assert.equal(viaRegistry.results[0].verdict, viaModule.results[0].verdict);

  const cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'engineering.js'),
    'verify',
    '--requirements', JSON.stringify(args.requirements),
    '--target', JSON.stringify(args.target),
    '--principal', ME,
    '--root', root,
    '--no-judge',
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.verdict, 'verified');
  assert.equal(parsed.results[0].verdict, 'satisfied');
  assert.equal(parsed.receipt.commit, viaModule.receipt.commit);
});

test('overall verdict algebra: unknown is never folded into pass', () => {
  const req = (v) => ({ required: true, verdict: v });
  assert.equal(overallVerdict([req('satisfied')], [{}]), 'verified');
  assert.equal(overallVerdict([req('satisfied'), req('not_satisfied')], [{}]), 'partial');
  assert.equal(overallVerdict([req('not_satisfied')], [{}]), 'not_met');
  assert.equal(overallVerdict([req('unknown')], [{}]), 'inconclusive');
  assert.equal(overallVerdict([req('unknown'), req('satisfied')], [{}]), 'inconclusive');
  assert.equal(overallVerdict([req('not_satisfied'), req('unknown')], [{}]), 'not_met');
  assert.equal(overallVerdict([], []), 'inconclusive');
});
