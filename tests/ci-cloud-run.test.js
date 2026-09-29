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
function fakeGitHub(cfg = {}) {
  const requests = [];
  const dispatched = [];
  const runs = cfg.runs || {};
  const fetchStub = async (url, init = {}) => {
    const apiPath = String(url).replace('https://api.github.com', '').split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ method, path: apiPath });
    const res = (status, payload) => ({
      ok: status >= 200 && status < 300, status, statusText: 'OK',
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
    if (method === 'POST' && /\/dispatches$/.test(apiPath)) {
      dispatched.push(JSON.parse(init.body));
      const own = runs[cfg.dispatchRunId];
      if (own) own.created_at = new Date(Date.now() + 1000).toISOString();
      return res(204, null);
    }
    if (/\/actions\/jobs\/\d+\/logs/.test(apiPath)) return res(200, cfg.logText || '');
    if (/\/actions\/runs\/\d+\/jobs/.test(apiPath)) return res(200, { jobs: cfg.failedJobs || [] });
    if (/\/actions\/runs\/\d+(\?|$)/.test(apiPath)) {
      const id = apiPath.match(/runs\/(\d+)/)[1];
      return runs[id] ? res(200, runs[id]) : res(404, { message: 'Not Found' });
    }
    if (/\/actions\/workflows\/\d+\/runs/.test(apiPath)) {
      return res(200, { workflow_runs: dispatched.length ? Object.values(runs) : [] });
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
    failedJobs: [{ id: 5, name: 'test (unit)', html_url: 'https://github.com/owner/repo/actions/runs/888/job/5' }],
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
