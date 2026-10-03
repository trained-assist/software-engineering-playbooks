'use strict';

// Issue #112 — engineering_change_status contract.
// Deterministic by construction: the pure stage evaluator is fed a facts
// snapshot directly, GitHub is a path router (no network), the workspace store
// and the local repository are real temp directories, and the production
// endpoint is stubbed.
//
// The six distinctions of #112 each get their own case:
//   uncommitted / local-only commit / pushed-no-PR / closed-no-merge /
//   merged-no-deploy / deployed-unverified — plus unknown CI, stale verified,
//   a change without Git, and an access failure that must NOT masquerade as
//   «the change does not exist».

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { changeStatus } = require('../src/change-status/status');
const { evaluateStages, summarize, STAGE_ORDER } = require('../src/change-status/stages');
const { candidateKeys, verificationKey } = require('../src/change-status/verification');
const { prodVerdict, deliveryRepo } = require('../src/github/pr-status-core');
const store = require('../src/workspace/store');

const REPO = 'trained-assist/software-engineering-playbooks';
const AGENT_REPO = 'trained-assist/trained-assist-agent';
const ME = 'trained-assist-product-owner';
const OTHER = 'someone-else-profile';
const AT = '2026-10-04T00:00:00.000Z';

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpRoot(prefix = 'eng-change-status-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A real repository: origin/main + a topic branch, optionally dirty/ahead. */
function makeRepo({ name = 'repo', dirty = 0, ahead = 0 } = {}) {
  const dir = tmpRoot(`eng-cs-git-${name}-`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  // A bare "origin" so upstream tracking refs exist without a network.
  const origin = tmpRoot(`eng-cs-origin-${name}-`);
  execFileSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' });
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'checkout', '-q', '-b', 'eng/task');
  for (let i = 0; i < ahead; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `x${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `local ${i}`);
  }
  for (let i = 0; i < dirty; i++) {
    fs.writeFileSync(path.join(dir, `dirty${i}.txt`), `d${i}\n`);
  }
  return { dir, origin };
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
    createdAt: AT,
    updatedAt: AT,
    ...record,
    workspaceId: id,
  };
  fs.writeFileSync(path.join(dirs.workspaces, `${id}.json`), JSON.stringify(full, null, 2));
  return full;
}

function seedVerification(root, { principal = ME, changeKey = 'pr:115', repo = REPO, record = {} } = {}) {
  const dirs = store.storeDirs(root);
  fs.mkdirSync(dirs.verifications, { recursive: true });
  const full = {
    schemaVersion: 1,
    principal,
    repositoryId: repo,
    changeKey,
    verdict: 'pass',
    commit: null,
    requirements_ref: null,
    requirements_revision: null,
    verified_at: AT,
    source: 'engineering_verify',
    ...record,
  };
  fs.writeFileSync(store.verificationFile(root, verificationKey(principal, repo, changeKey)), JSON.stringify(full, null, 2));
  return full;
}

function makeGh(routes, calls = []) {
  const ghFetch = async (rawPath) => {
    const p = decodeURIComponent(String(rawPath));
    calls.push(p);
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(p) : p.includes(route.match);
      if (!hit) continue;
      if (route.error) {
        const e = new Error(route.error.message || `GitHub API ${route.error.status}: boom`);
        e.status = route.error.status;
        e.name = 'GitHubApiError';
        throw e;
      }
      return typeof route.value === 'function' ? route.value(p) : route.value;
    }
    const e = new Error(`GitHub API 404: no route for ${p}`);
    e.status = 404;
    e.name = 'GitHubApiError';
    throw e;
  };
  return { ghFetch, calls };
}

const at = (suffix) => p => p.split('?')[0] === suffix;

function prPayload(n, extra = {}) {
  return {
    number: n,
    title: `PR ${n}`,
    state: extra.state || 'open',
    draft: Boolean(extra.draft),
    merged: Boolean(extra.merged),
    merged_at: extra.merged_at || null,
    merge_commit_sha: extra.merge_commit_sha || null,
    created_at: extra.created_at || AT,
    user: { login: 'kobzevvv' },
    html_url: `https://github.com/${REPO}/pull/${n}`,
    head: { ref: extra.head_ref || 'eng/task', sha: extra.head_sha || 'aaaa111122223333444455556666777788889999' },
    base: { ref: 'main' },
  };
}

// prStatus is stubbed through deps so the test never touches a network, and so
// the delivery verdict can be declared directly instead of mocked around a
// health endpoint.
function prStatusStub(pr, { ci = { status: 'success', verdict: 'green', check_runs_total: 3 } } = {}) {
  return async (repo, number) => {
    if (Number(number) !== Number(pr.number)) return { ok: false, error: { code: 'NOT_A_PR', message: `GitHub API 404: #${number}` } };
    return {
      ok: true,
      repo,
      pr_number: pr.number,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        mergeable: true,
        merge_commit_sha: pr.merge_commit_sha,
        merged_at: pr.merged_at,
        head_sha: pr.head.sha,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        url: pr.html_url,
      },
      ci,
      summary: { total: ci.check_runs_total },
      check_runs: [],
    };
  };
}

// The delivery verdict is the one place where change_status would otherwise
// reach the network on its own, so it is injected: full-stack tests declare the
// verdict instead of standing up a health endpoint.
function withDelivery(value) {
  return { prodVerdict: async () => value };
}

const LIVE = { verdict: 'live', source: 'health-compare', compare: 'identical', health_commit: 'merge1111', merge_commit: 'merge1111' };
const NOT_YET = { verdict: 'not_yet', source: 'health-compare', compare: 'ahead', health_commit: 'old9999', merge_commit: 'merge1111' };
const UNREACHABLE = { verdict: 'unknown', evidence: 'health-unreachable', source: 'none', merge_commit: 'merge1111' };

// ── pure evaluator: the six distinctions ─────────────────────────────────────

test('uncommitted work is written but NOT committed', () => {
  const s = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h1', dirty: { files: 2, tracked: [{ code: ' M', file: 'a.txt' }], untracked: ['b.txt'] }, upstream: 'origin/eng/task', upstream_sha: 'h0', commits_ahead: 0, ahead_shas: [], merged_into_default: false },
    pr: null,
    delivered: { verdict: 'unknown', note: 'нет PR' },
    verification: { found: false },
  }, { observedAt: AT });

  assert.equal(s.written.status, 'satisfied');
  assert.equal(s.committed.status, 'not_satisfied');
  assert.match(s.committed.reason, /незакоммиченные изменения/);
  assert.equal(s.pushed.status, 'satisfied', 'nothing unpushed — the tree is dirty, not ahead');
});

test('a local-only commit is committed but NOT pushed', () => {
  const s = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h2', dirty: { files: 0, tracked: [], untracked: [] }, upstream: 'origin/eng/task', upstream_sha: 'h1', commits_ahead: 3, ahead_shas: ['h2'], merged_into_default: false },
    pr: null,
    delivered: { verdict: 'unknown' },
    verification: { found: false },
  }, { observedAt: AT });

  assert.equal(s.written.status, 'satisfied');
  assert.equal(s.committed.status, 'satisfied');
  assert.equal(s.pushed.status, 'not_satisfied');
  assert.match(s.pushed.reason, /3 коммит\(ов\) только локально/);
  assert.equal(s.pushed.revision, 'h2');
});

test('pushed without a PR is not merged, and a closed PR without merge is not merged', () => {
  const pushed = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h2', dirty: { files: 0, tracked: [], untracked: [] }, upstream: 'origin/eng/task', upstream_sha: 'h2', commits_ahead: 0, ahead_shas: [], merged_into_default: false },
    pr: null,
    delivered: { verdict: 'unknown' },
    verification: { found: false },
  }, { observedAt: AT });
  assert.equal(pushed.pushed.status, 'satisfied');
  assert.equal(pushed.merged.status, 'not_satisfied', 'на remote без merge — не смержено');

  const closed = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h2', dirty: { files: 0, tracked: [], untracked: [] }, upstream: 'origin/eng/task', upstream_sha: 'h2', commits_ahead: 0, ahead_shas: [], merged_into_default: false },
    pr: { number: 7, state: 'closed', merged: false, merge_commit_sha: null, url: `https://github.com/${REPO}/pull/7` },
    delivered: { verdict: 'unknown' },
    verification: { found: false },
  }, { observedAt: AT });
  assert.equal(closed.merged.status, 'not_satisfied');
  assert.match(closed.merged.reason, /закрыт без мержа/);
});

test('merged without deployment is merged and delivered=unknown, never satisfied', () => {
  const s = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h2', dirty: { files: 0, tracked: [], untracked: [] }, upstream: 'origin/eng/task', upstream_sha: 'h2', commits_ahead: 0, ahead_shas: [], merged_into_default: true },
    pr: { number: 7, state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111', url: `https://github.com/${REPO}/pull/7` },
    delivered: UNREACHABLE,
    verification: { found: false },
  }, { observedAt: AT });

  assert.equal(s.merged.status, 'satisfied');
  assert.equal(s.merged.revision, 'merge1111');
  assert.equal(s.delivered.status, 'unknown', 'merge есть, но прод недоступен — это unknown, а не «доставлено»');
  assert.match(s.delivered.reason, /health-unreachable/);
});

test('delivered but unverified: the two are separate facts', () => {
  const s = evaluateStages({
    git: { available: true, branch: 'eng/task', head_sha: 'h2', dirty: { files: 0, tracked: [], untracked: [] }, upstream: 'origin/eng/task', upstream_sha: 'h2', commits_ahead: 0, ahead_shas: [], merged_into_default: true },
    pr: { number: 7, state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111', url: `https://github.com/${REPO}/pull/7` },
    delivered: LIVE,
    verification: { found: false },
  }, { observedAt: AT });

  assert.equal(s.delivered.status, 'satisfied');
  assert.equal(s.verified.status, 'unknown', 'доставлено ≠ проверено');
  const sum = summarize(s);
  assert.equal(sum.verdict, 'incomplete_unknown');
  assert.equal(sum.first_missing_stage, null, 'нет not_satisfied — но ответ всё равно не «complete» из-за unknown');
});

test('a green deploy job is evidence attached to unknown, not a verdict', () => {
  const s = evaluateStages({
    git: { available: true },
    pr: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'merge1111' },
    delivered: { verdict: 'unknown', evidence: 'health-unreachable', source: 'deploy-job', deploy_run: 'https://github.com/x/y/actions/runs/1' },
    verification: { found: false },
  }, { observedAt: AT });
  assert.equal(s.delivered.status, 'unknown');
  assert.match(s.delivered.reason, /свидетельство, а не доказательство/);
  assert.ok(s.delivered.refs.includes('https://github.com/x/y/actions/runs/1'));
});

test('a new revision invalidates a previous verified (stale, not unknown)', () => {
  const record = { changeKey: 'pr:7', commit: 'oldcommit1', requirements_revision: 'issue#112@1', verified_at: AT, verdict: 'pass' };
  const stale = evaluateStages({
    git: { available: true, head_sha: 'merge1111' },
    pr: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'merge1111' },
    delivered: LIVE,
    verification: { found: true, record, key: 'pr:7', source: 'engineering_verify' },
  }, { observedAt: AT });

  assert.equal(stale.verified.status, 'not_satisfied');
  assert.match(stale.verified.reason, /устарела/);
  assert.match(stale.verified.reason, /oldcommit1/);

  const reqStale = evaluateStages({
    git: { available: true, head_sha: 'merge1111' },
    pr: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'merge1111' },
    delivered: LIVE,
    verification: { found: true, record: { ...record, commit: 'merge1111' }, key: 'pr:7', requirements_ref: 'issue#112@4' },
  }, { observedAt: AT });
  assert.equal(reqStale.verified.status, 'not_satisfied');
  assert.match(reqStale.verified.reason, /требования изменились/);

  const fresh = evaluateStages({
    git: { available: true, head_sha: 'merge1111' },
    pr: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'merge1111' },
    delivered: LIVE,
    verification: { found: true, record: { ...record, commit: 'merge1111' }, key: 'pr:7', requirements_ref: 'issue#112@1' },
  }, { observedAt: AT });
  assert.equal(fresh.verified.status, 'satisfied');
});

test('no workspace means unknown, never not_satisfied', () => {
  const s = evaluateStages({
    git: { available: null, reason: 'рабочая область не найдена' },
    pr: { number: 7, state: 'open', merged: false },
    delivered: { verdict: 'unknown' },
    verification: { found: false },
  }, { observedAt: AT });
  for (const name of ['written', 'committed', 'pushed']) {
    assert.equal(s[name].status, 'unknown', `${name} должен быть unknown, а не «не сделано»`);
  }
});

test('a change without Git is not_applicable, and delivered/verified still judged', () => {
  const s = evaluateStages({
    git: { available: false, reason: 'путь не является git-рабочей областью' },
    pr: null,
    delivered: LIVE,
    verification: { found: false },
  }, { observedAt: AT });
  for (const name of ['written', 'committed', 'pushed']) {
    assert.equal(s[name].status, 'not_applicable', `${name} not_applicable для документа без Git`);
  }
  assert.equal(s.delivered.status, 'satisfied', 'внешний документ тоже доставляется');
});

test('all six stages are always present and in order, with observed_at', () => {
  const s = evaluateStages({ git: { available: null }, delivered: { verdict: 'unknown' }, verification: { found: false } }, { observedAt: AT });
  assert.deepEqual(Object.keys(s), STAGE_ORDER);
  for (const name of STAGE_ORDER) assert.equal(s[name].observed_at, AT, `${name} без observed_at`);
});

test('next_missing_actions name the first missing stage and recommend, never act', () => {
  const s = evaluateStages({
    git: { available: true, branch: 'eng/t', head_sha: 'h2', dirty: { files: 1, tracked: [{ code: ' M', file: 'a' }], untracked: [] }, upstream: 'origin/eng/t', upstream_sha: 'h1', commits_ahead: 1, ahead_shas: ['h2'], merged_into_default: false },
    pr: { number: 7, state: 'open', merged: false },
    delivered: UNREACHABLE,
    verification: { found: false },
  }, { observedAt: AT });
  const { nextMissingActions } = require('../src/change-status/stages');
  const acts = nextMissingActions(s);
  assert.ok(acts.length >= 3);
  assert.equal(acts[0].stage, 'committed');
  assert.equal(acts[0].next, true);
  assert.equal(acts.filter(a => a.next).length, 1, 'ровно одно действие помечено как следующее');
  for (const a of acts) assert.match(a.action, /^(Написать|Закоммитить|Запушить|Открыть|Дождаться|Проверить)/);
});

// ── prodVerdict: the wrong-repo hole ─────────────────────────────────────────

test('prodVerdict refuses to judge a repo the health endpoint does not serve', async () => {
  const saved = { url: process.env.AGENT_PUBLIC_URL, repo: process.env.ENGINEERING_DELIVERY_REPO };
  process.env.AGENT_PUBLIC_URL = 'http://127.0.0.1:1'; // unreachable on purpose
  delete process.env.ENGINEERING_DELIVERY_REPO;
  const v = await prodVerdict(REPO, 'merge1111');
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.evidence, 'prod-endpoint-other-repo');
  assert.equal(v.delivery_repo, AGENT_REPO);
  assert.equal(deliveryRepo(), AGENT_REPO);
  if (saved.url === undefined) delete process.env.AGENT_PUBLIC_URL; else process.env.AGENT_PUBLIC_URL = saved.url;
  if (saved.repo !== undefined) process.env.ENGINEERING_DELIVERY_REPO = saved.repo;
});

// ── verification keys ────────────────────────────────────────────────────────

test('a change is looked up by pr, by commit and by branch — most specific first', () => {
  const keys = candidateKeys('pull', { number: 115, sha: 'ABC1234', branch: 'eng/x' });
  assert.deepEqual(keys, ['pr:115', 'commit:abc1234', 'sha:abc1234', 'branch:eng/x'], 'от самого специфичного ключа к общему');
  assert.ok(keys.indexOf('pr:115') < keys.indexOf('branch:eng/x'));
  const k = verificationKey(ME, REPO, 'PR:115');
  assert.equal(k, `${ME}\0${REPO}\0pr:115`, 'ключ регистронезависим по changeKey');
});

// ── full stack ───────────────────────────────────────────────────────────────

test('access failure is an error, not six quiet unknowns', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([
    { match: at(`/repos/${REPO}`), error: { status: 403, message: 'Forbidden' } },
  ]);
  const r = await changeStatus({ repo: REPO, change_ref: '#115' }, { ghFetch, principal: ME, workspaceRoot: root, now: () => Date.parse(AT) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'RATE_LIMITED');
  assert.ok(!r.stages, 'стадий нет — это ошибка доступа, а не «изменений нет»');
});

test('PR merged and live, verification of another profile is invisible', async () => {
  const root = tmpRoot();
  const { dir } = makeRepo({ name: 'live' });
  seedWorkspace(root, { rootTaskId: 'change-status', branch: 'eng/task', codePath: dir, workspaceId: 'ws-live' });
  seedVerification(root, { principal: OTHER, changeKey: 'pr:115', record: { commit: 'merge1111' } });

  const pr = prPayload(115, { state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111', head_sha: 'h2' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);

  const r = await changeStatus(
    { repo: REPO, change_ref: '#115', workspace_ref: 'ws-live' },
    { ghFetch, prStatus: prStatusStub(pr), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(LIVE) },
  );

  assert.equal(r.ok, true);
  assert.equal(r.stages.merged.status, 'satisfied');
  assert.equal(r.stages.delivered.status, 'satisfied');
  assert.equal(r.stages.verified.status, 'unknown', 'чужой профиль не читается');
  assert.ok(r.sources.some(s => s.name === 'verification-store' && s.ok));
  assert.equal(r.summary.verdict, 'incomplete_unknown');
});

test('PR merged, no prod endpoint: delivered is unknown and the answer says why', async () => {
  const root = tmpRoot();
  const pr = prPayload(115, { state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);
  const r = await changeStatus(
    { repo: REPO, change_ref: 'PR #115' },
    { ghFetch, prStatus: prStatusStub(pr), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.stages.merged.status, 'satisfied');
  assert.equal(r.stages.delivered.status, 'unknown');
  assert.equal(r.summary.first_missing_stage, null, 'unknown — это не «не сделано», значит и не действие');
  assert.match(r.stages.delivered.reason, /health-unreachable/);
  assert.ok(!r.next_missing_actions.some(a => a.stage === 'delivered'), 'unknown не превращается в «сделай это»');
  assert.ok(r.limitations.some(l => /health/.test(l)));
});

test('open PR with red CI is reported as not merged, and the CI verdict is carried through', async () => {
  const root = tmpRoot();
  const pr = prPayload(115, { state: 'open' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);
  const r = await changeStatus(
    { repo: REPO, change_ref: 'https://github.com/trained-assist/software-engineering-playbooks/pull/115' },
    { ghFetch, prStatus: prStatusStub(pr, { ci: { status: 'failure', verdict: 'red', check_runs_total: 4 } }), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.repo, REPO, 'репозиторий взят из URL ref');
  assert.equal(r.change.kind, 'pull');
  assert.equal(r.stages.merged.status, 'not_satisfied');
  assert.match(r.stages.merged.reason, /открыт/);
  assert.equal(r.facts.pr.ci.verdict, 'red');
});

test('a task label resolves the workspace of the calling profile, and uncommitted work shows up', async () => {
  const root = tmpRoot();
  const { dir } = makeRepo({ name: 'dirty', dirty: 3, ahead: 2 });
  seedWorkspace(root, { rootTaskId: 'change-status', branch: 'eng/task', codePath: dir, workspaceId: 'ws-dirty' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);

  const r = await changeStatus(
    { repo: REPO, change_ref: 'change-status' },
    { ghFetch, principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE) },
  );

  assert.equal(r.ok, true);
  assert.equal(r.workspace.via, 'workspace_record');
  assert.equal(r.stages.written.status, 'satisfied');
  assert.equal(r.stages.committed.status, 'not_satisfied');
  assert.match(r.stages.committed.reason, /3 файл/);
  assert.equal(r.stages.pushed.status, 'not_satisfied', '2 локальных коммита не запушены');
  assert.equal(r.facts.git.commits_ahead, 2);
});

test('another profile\'s workspace is never used', async () => {
  const root = tmpRoot();
  const { dir } = makeRepo({ name: 'foreign', dirty: 5 });
  seedWorkspace(root, { rootTaskId: 'change-status', branch: 'eng/task', codePath: dir, workspaceId: 'ws-foreign', principal: OTHER });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);

  const r = await changeStatus(
    { repo: REPO, change_ref: 'change-status' },
    { ghFetch, principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE) },
  );
  assert.equal(r.workspace.found, false);
  for (const name of ['written', 'committed', 'pushed']) assert.equal(r.stages[name].status, 'unknown');
  assert.ok(!JSON.stringify(r.facts).includes('ws-foreign'));
});

test('a verification record is honoured only when it matches commit AND requirements revision', async () => {
  const root = tmpRoot();
  seedVerification(root, { changeKey: 'pr:115', record: { commit: 'merge1111', requirements_revision: 'issue#112@2' } });
  const pr = prPayload(115, { state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);

  const good = await changeStatus(
    { repo: REPO, change_ref: '#115', requirements_ref: 'issue#112@2' },
    { ghFetch, prStatus: prStatusStub(pr), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(LIVE) },
  );
  assert.equal(good.stages.verified.status, 'satisfied');
  assert.equal(good.summary.first_missing_stage, null);
  assert.equal(good.summary.verdict, 'incomplete_unknown', 'git-стадии unknown (нет workspace) — «complete» тут недостижим');

  const moved = await changeStatus(
    { repo: REPO, change_ref: '#115', requirements_ref: 'issue#112@3' },
    { ghFetch, prStatus: prStatusStub(pr), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(LIVE) },
  );
  assert.equal(moved.stages.verified.status, 'not_satisfied');
  assert.equal(moved.summary.first_missing_stage, 'verified');
  assert.equal(moved.next_missing_actions[0].stage, 'verified');
});

test('a verification record written by another process is read back', async () => {
  const root = tmpRoot();
  const writer = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'workspace', 'store'))});
    const { verificationKey } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'change-status', 'verification'))});
    const fs = require('fs');
    const path = require('path');
    const dirs = store.storeDirs(${JSON.stringify(root)});
    fs.mkdirSync(dirs.verifications, { recursive: true });
    const rec = { schemaVersion: 1, principal: ${JSON.stringify(ME)}, repositoryId: ${JSON.stringify(REPO)}, changeKey: 'pr:115', verdict: 'pass', commit: 'merge1111', requirements_revision: 'issue#112@1', verified_at: ${JSON.stringify(AT)}, source: 'engineering_verify' };
    fs.writeFileSync(store.verificationFile(${JSON.stringify(root)}, verificationKey(${JSON.stringify(ME)}, ${JSON.stringify(REPO)}, 'pr:115')), JSON.stringify(rec));
    process.stdout.write('written');
  `;
  const out = execFileSync(process.execPath, ['-e', writer], { encoding: 'utf8' });
  assert.equal(out, 'written');

  const pr = prPayload(115, { state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);
  const r = await changeStatus(
    { repo: REPO, change_ref: '#115', requirements_ref: 'issue#112@1' },
    { ghFetch, prStatus: prStatusStub(pr), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(LIVE) },
  );
  assert.equal(r.stages.verified.status, 'satisfied');
  assert.equal(r.facts.verification.source, 'engineering_verify');
});

test('a non-git workspace path makes the git stages not_applicable end to end', async () => {
  const root = tmpRoot();
  const plain = tmpRoot('eng-cs-plain-');
  fs.writeFileSync(path.join(plain, 'doc.txt'), 'external document\n');
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);

  const r = await changeStatus(
    { repo: REPO, change_ref: '#115', workspace_ref: plain },
    { ghFetch, prStatus: prStatusStub(prPayload(115, { state: 'closed', merged: true, merged_at: AT, merge_commit_sha: 'merge1111' })), principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(LIVE) },
  );
  for (const name of ['written', 'committed', 'pushed']) assert.equal(r.stages[name].status, 'not_applicable');
  assert.equal(r.stages.delivered.status, 'satisfied');
});

test('a bare #N is resolved by asking GitHub: an issue number falls back to issue_status', async () => {
  const root = tmpRoot();
  const { ghFetch, calls } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);
  const r = await changeStatus(
    { repo: REPO, change_ref: '#115' },
    {
      ghFetch,
      prStatus: async () => ({ ok: false, error: { code: 'NOT_A_PR', message: '#115 is an issue, not a pull request' } }),
      issueStatus: async () => ({ ok: true, issue: { number: 115, state: 'open', title: 'Epic', url: 'u' }, prs: [] }),
      principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.change.kind, 'issue', '«#115» оказался issue — инструмент спросил GitHub, а не угадал');
  assert.equal(r.stages.merged.status, 'unknown');
  assert.ok(calls.some(c => c.includes('/repos/' + REPO)), 'проверка доступа выполнена');
});

test('a task label answers the workspace stages and admits it cannot see GitHub state', async () => {
  const root = tmpRoot();
  const { dir } = makeRepo({ name: 'label', dirty: 1, ahead: 1 });
  seedWorkspace(root, { rootTaskId: 'выбор диалога', branch: 'eng/task', codePath: dir, workspaceId: 'ws-label' });
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}`), value: { id: 1, full_name: REPO, default_branch: 'main' } }]);
  const r = await changeStatus(
    { repo: REPO, change_ref: 'выбор диалога' },
    { ghFetch, principal: ME, workspaceRoot: root, now: () => Date.parse(AT), ...withDelivery(UNREACHABLE) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.workspace.via, 'workspace_record');
  assert.equal(r.stages.written.status, 'satisfied');
  assert.equal(r.stages.committed.status, 'not_satisfied');
  assert.equal(r.stages.merged.status, 'not_satisfied');
  assert.match(r.stages.merged.reason, /ветке рабочей области/, 'вывод помечен как вывод из ветки рабочей области');
  assert.ok(r.limitations.some(l => /метка задачи/.test(l)));
});

test('the tool refuses a call with no change_ref at all', async () => {
  const root = tmpRoot();
  await assert.rejects(
    () => changeStatus({ repo: REPO }, { principal: ME, workspaceRoot: root }),
    e => e.code === 'INVALID_CHANGE_REF',
  );
});