'use strict';

// Cloud test run (plan 3e40a139): the manual-test workflow template and the
// ci_run_branch MCP tool contract. The full closed loop (scenario steps through
// the real code, incl. the core ci_run_green validator) is
// scripts/sandbox/ci-cloud-run.mjs; this file locks the two pieces the default
// `npm test` can check hermetically, without a network or a token.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('templates/ci.yml is a manual test-run workflow that cannot ship anything', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'ci.yml'), 'utf8');
  assert.match(tpl, /workflow_dispatch/, 'manual trigger declared');
  assert.match(tpl, /^\s+ref:/m, 'ref input (the branch under test)');
  assert.match(tpl, /inputs\.ref/, 'checkout uses the ref input');
  assert.match(tpl, /concurrency:/, 'own concurrency group for manual runs');
  assert.doesNotMatch(tpl, /continue-on-error/i, 'a red run must not be skipped');
  assert.doesNotMatch(tpl, /\bdeploy\b/i, 'the run never deploys');
  assert.doesNotMatch(tpl, /\bmerge\b/i, 'the run never merges');
});

// A stateful fake of the GitHub endpoints ci_run_branch touches. Same shape as
// the sandbox stub: workflows + contents (is it dispatchable?), dispatch → own
// run, run status, failed jobs, job log.
//
// Extended options (both optional, default keeps existing hermetic behaviour):
//   cfg.priorRuns — array of run objects visible from the first list call
//     (simulates runs created by a concurrent dispatch).
//   cfg.runLagPolls — number of list requests the run created by dispatch
//     stays invisible; after that many GET /workflows/:id/runs calls it
//     becomes visible (simulates GitHub publish lag).
function fakeGitHub(cfg = {}) {
  const requests = [];
  const dispatched = [];
  const runs = cfg.runs || {};
  const priorRuns = cfg.priorRuns || [];
  const runLagPolls = cfg.runLagPolls || 0;
  let dispatchCount = 0;
  // Visibility counters for runs that are created by dispatch but not yet
  // visible (lag simulation): the value is how many more list calls must pass.
  const pendingVisibility = new Map();
  const isVisible = id => {
    if (pendingVisibility.has(id)) return pendingVisibility.get(id) <= 0;
    // Runs present before any dispatch (priorRuns) are always visible.
    return priorRuns.some(r => r.id === id);
  };
  const visibleRuns = () => {
    const all = [...priorRuns];
    for (const [id, r] of Object.entries(runs)) {
      if (Number(id) === Number(cfg.dispatchRunId) && dispatchCount === 0) continue;
      if (isVisible(Number(id))) all.push(r);
    }
    return all;
  };

  const fetchStub = async (url, init = {}) => {
    const raw = String(url);
    const apiPath = raw.replace('https://api.github.com', '').split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ method, path: apiPath, url: raw });
    const res = (status, payload) => ({
      ok: status >= 200 && status < 300, status, statusText: 'OK',
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
    if (method === 'POST' && /\/dispatches$/.test(apiPath)) {
      dispatched.push(JSON.parse(init.body));
      dispatchCount++;
      const own = runs[cfg.dispatchRunId];
      if (own) {
        own.created_at = new Date(Date.now() + 1000).toISOString();
        pendingVisibility.set(Number(cfg.dispatchRunId), runLagPolls);
      }
      return res(204, null);
    }
    if (/\/actions\/jobs\/\d+\/logs/.test(apiPath)) return res(200, cfg.logText || '');
    if (/\/actions\/runs\/\d+\/jobs/.test(apiPath)) return res(200, { jobs: cfg.failedJobs || [] });
    if (/\/actions\/runs\/\d+(\?|$)/.test(apiPath)) {
      const id = apiPath.match(/runs\/(\d+)/)[1];
      return runs[id] ? res(200, runs[id]) : res(404, { message: 'Not Found' });
    }
    if (/\/actions\/workflows\/\d+\/runs/.test(apiPath)) {
      // Every list call advances the lag counters of not-yet-visible runs.
      for (const [id, n] of [...pendingVisibility]) {
        if (n > 0) pendingVisibility.set(id, n - 1);
      }
      return res(200, { workflow_runs: visibleRuns() });
    }
    if (/\/actions\/workflows(\?|$)/.test(apiPath)) return res(200, { workflows: cfg.workflows || [] });
    if (apiPath.includes('/contents/')) {
      const rest = apiPath.split('/contents/')[1].replace(/\/$/, '');
      const name = rest.split('/').pop();
      const body = (cfg.files && (cfg.files[rest] ?? cfg.files[name]));
      if (body != null) return res(200, { content: Buffer.from(body).toString('base64') });
      return res(404, { message: 'Not Found' });
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(apiPath)) return res(200, { default_branch: cfg.defaultBranch || 'main' });
    return res(404, { message: `no route ${method} ${apiPath}` });
  };
  fetchStub.requests = requests;
  fetchStub.dispatched = dispatched;
  return fetchStub;
}

const MANUAL_YML = [
  'name: manual-tests',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      ref: {type: string, default: main}',
  '      suite: {type: choice, options: [unit, all]}',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with: {ref: "${{ inputs.ref }}"}',
].join('\n');

const runFixture = (id, conclusion) => ({
  id, name: 'manual-tests', event: 'workflow_dispatch', head_branch: 'feature/x',
  status: 'completed', conclusion,
  run_started_at: '2026-09-29T04:00:00Z', updated_at: '2026-09-29T04:01:30Z',
  html_url: `https://github.com/owner/repo/actions/runs/${id}`, created_at: '2026-09-29T04:00:00Z',
});

const WFS = [{ id: 42, name: 'manual-tests', path: '.github/workflows/manual-tests.yml', state: 'active' }];

function withFake(fetchStub, env, fn) {
  const realFetch = globalThis.fetch;
  const saved = { GH_TOKEN: process.env.GH_TOKEN, USER_ID: process.env.USER_ID };
  globalThis.fetch = fetchStub;
  // `process.env.X = undefined` stores the STRING "undefined" — unset instead.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    });
}

test('ci_run_branch is registered and refuses to work without a token', async () => {
  const mod = require(path.join(ROOT, 'src', 'mcp-skills', 'tools', '63-ci-cd.js'));
  assert.equal(typeof mod.tools.ci_run_branch.handler, 'function');
  const registry = require(path.join(ROOT, 'src', 'mcp-skills', 'registry.js'));
  assert.ok(registry.listAllTools().map(t => t.name).includes('ci_run_branch'), 'in the registry');

  const seen = [];
  const r = await withFake(
    async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; },
    { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, USER_ID: undefined },
    () => mod.tools.ci_run_branch.handler({ repo: 'owner/repo', ref: 'feature/x' }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-github-token');
  assert.deepEqual(seen, [], 'no API call is made without a token');
});

test('ci_run_branch: unconfigured repo points at ci-setup, never dispatches', async () => {
  const tool = require(path.join(ROOT, 'src', 'mcp-skills', 'tools', '63-ci-cd.js')).tools.ci_run_branch;
  const gh = fakeGitHub({ workflows: [], files: {} });
  const r = await withFake(gh, { GH_TOKEN: 'test-token' }, () => tool.handler({ repo: 'owner/repo', ref: 'feature/x' }));
  assert.equal(r.ok, false);
  assert.equal(r.configured, false);
  assert.match(String(r.hint), /ci-setup/);
  assert.equal(gh.dispatched.length, 0);
});

test('ci_run_branch: dispatches the branch and returns its own run, then the real verdict', async () => {
  const tool = require(path.join(ROOT, 'src', 'mcp-skills', 'tools', '63-ci-cd.js')).tools.ci_run_branch;
  const gh = fakeGitHub({
    workflows: WFS, files: { 'manual-tests.yml': MANUAL_YML },
    runs: { 777: runFixture(777, 'success'), 888: runFixture(888, 'failure'), 999: runFixture(999, 'cancelled') },
    dispatchRunId: 777,
    failedJobs: [{ id: 5, name: 'test (unit)', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/888/job/5' }],
    logText: 'ok 1\nFAIL tests/broken.test.js — expected 1 === 2',
  });

  await withFake(gh, { GH_TOKEN: 'test-token' }, async () => {
    const d = await tool.handler({ repo: 'owner/repo', ref: 'feature/x', suite: 'unit' });
    assert.equal(d.ok, true);
    assert.equal(d.run_id, 777);
    assert.deepEqual(gh.dispatched[0], { ref: 'main', inputs: { ref: 'feature/x', suite: 'unit' } });

    const green = await tool.handler({ repo: 'owner/repo', run_id: 777 });
    assert.equal(green.ok, true);
    assert.equal(green.conclusion, 'success');
    assert.equal(green.duration, 90);
    assert.match(green.url, /runs\/777$/);

    const red = await tool.handler({ repo: 'owner/repo', run_id: 888 });
    assert.equal(red.ok, true);
    assert.equal(red.conclusion, 'failure');
    assert.equal(red.failed_jobs.length, 1);
    assert.match(red.log_tail, /FAIL tests\/broken\.test\.js/);

    const cancelled = await tool.handler({ repo: 'owner/repo', run_id: 999 });
    assert.equal(cancelled.ok, false);
    assert.match(String(cancelled.error), /cancel/i);
  });

  assert.equal(gh.dispatched.length, 1, 'only the first call dispatches; status calls just read');
  const forbidden = gh.requests.filter(r => r.method === 'DELETE' || /\/merges?(\/|$)|deploy/i.test(r.path));
  assert.deepEqual(forbidden, [], 'the tool never merges, deploys or deletes');
});

// Regression, issue #64 defect 1: the jobs endpoint has no `status` filter —
// GitHub ignores it and returns every job of the run. Reported as "9 failed
// jobs" for a run where exactly one job was red (green staging-gate,
// skipped deploy/merge included), which reads as "the deploy failed".
test('ci_run_branch: failed_jobs contains ONLY the jobs with conclusion=failure', async () => {
  const tool = require(path.join(ROOT, 'src', 'mcp-skills', 'tools', '63-ci-cd.js')).tools.ci_run_branch;
  const gh = fakeGitHub({
    workflows: WFS, files: { 'manual-tests.yml': MANUAL_YML },
    runs: { 888: runFixture(888, 'failure') },
    failedJobs: [
      { id: 1, name: 'ci', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/888/job/1' },
      { id: 2, name: 'staging-gate', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/888/job/2' },
      { id: 3, name: 'deploy-gcp', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/owner/repo/actions/runs/888/job/3' },
      { id: 4, name: 'deploy-ru', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/owner/repo/actions/runs/888/job/4' },
      { id: 5, name: 'merge', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/888/job/5' },
    ],
    logText: 'FAIL tests/broken.test.js — expected 1 to be 2',
  });

  const r = await withFake(gh, { GH_TOKEN: 'test-token' },
    () => tool.handler({ repo: 'owner/repo', run_id: 888 }));

  assert.equal(r.ok, true);
  assert.equal(r.conclusion, 'failure');
  assert.deepEqual(r.failed_jobs.map(j => j.name), ['ci'], 'only the red job is reported as failed');
  assert.match(r.log_tail, /FAIL tests\/broken\.test\.js/, 'log tail still points at the failing test');
  assert.ok(!gh.requests.some(q => /status=failure/.test(q.url)),
    'the request must not send the unsupported status=failure filter');
});

// Regression, issue #64 defect 2: the only identity of "my" run is that it did
// not exist before my dispatch. Without the pre-dispatch snapshot the tool took
// "the newest dispatch run in the last 60 s", so two dispatches 16 s apart
// both received the first run's id — an agent could report someone else's
// green/red. Here a concurrent run is already visible when we dispatch, and our
// own run only becomes visible after GitHub's publish lag.
test('ci_run_branch: two dispatches in a row return DIFFERENT own runs', async () => {
  const tool = require(path.join(ROOT, 'src', 'mcp-skills', 'tools', '63-ci-cd.js')).tools.ci_run_branch;
  const concurrent = { ...runFixture(500, 'success'), created_at: new Date(Date.now() - 4000).toISOString() };
  const gh = fakeGitHub({
    workflows: WFS, files: { 'manual-tests.yml': MANUAL_YML },
    runs: { 601: runFixture(601, 'failure') },
    priorRuns: [concurrent],          // visible from the very first list call
    dispatchRunId: 601,
    runLagPolls: 2,                   // our run appears after 2 list calls
  });

  const d = await withFake(gh, { GH_TOKEN: 'test-token' },
    () => tool.handler({ repo: 'owner/repo', ref: 'feature/red' }));

  assert.equal(d.ok, true);
  assert.equal(d.run_id, 601, `must return the freshly dispatched run, not the earlier one (got ${d.run_id})`);
  assert.notEqual(d.run_id, 500, 'the concurrent run must never be handed back as ours');

  // The snapshot of pre-dispatch run ids must be taken BEFORE the dispatch.
  const firstList = gh.requests.findIndex(r => r.method === 'GET' && /\/workflows\/\d+\/runs/.test(r.path));
  const post = gh.requests.findIndex(r => r.method === 'POST' && /\/dispatches$/.test(r.path));
  assert.ok(firstList >= 0 && firstList < post, 'GET runs (snapshot) happens before POST dispatches');
});
