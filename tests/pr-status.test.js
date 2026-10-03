'use strict';

// Contract tests for src/github/pr-status-core.js — slices S3 (state/checks/
// verdict/failed-job logs) and S4 (autofix, prod verdict, response budget).
// Runs against the shared fixture server (tests/fixtures/github/pr-status.js)
// behind a hermetic fetch guard: no network, no real token.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const fixture = require('./fixtures/github/pr-status');

process.env.GH_TOKEN = 'test-token-pr-status';
delete process.env.GITHUB_TOKEN;
delete process.env.AGENT_PUBLIC_URL;

const ORIGINAL_FETCH = globalThis.fetch;
const { prStatus, aggregate } = require('../src/github/pr-status-core');

let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('error', () => {});
      let r = null;
      try { r = fixture.resolve(req.method, `http://127.0.0.1${req.url}`); } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `fixture error: ${e.message}` }));
        return;
      }
      const status = r ? r.status : 404;
      const headers = { ...(r && r.headers) };
      if (status >= 300 && status < 400) { res.writeHead(status, headers); res.end(); return; }
      let body = r ? r.body : { message: 'Not Found' };
      if (typeof body === 'string') {
        headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8';
        body = Buffer.from(body);
      } else {
        headers['content-type'] = 'application/json';
        body = Buffer.from(JSON.stringify(body === undefined ? null : body));
      }
      headers['content-length'] = String(body.length);
      res.writeHead(status, headers);
      res.end(body);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function installGuard(port) {
  const local = `http://127.0.0.1:${port}`;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : (input && typeof input.url === 'string') ? input.url : String(input);
    let u;
    try { u = new URL(raw); } catch { u = new URL(raw, 'https://api.github.com'); }
    if (u.origin === 'https://api.github.com') return ORIGINAL_FETCH(local + u.pathname + u.search, init);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return ORIGINAL_FETCH(raw, init);
    return Promise.reject(new Error(`network call outside fixtures: ${u.origin}${u.pathname}`));
  };
}

test.before(async () => {
  server = await startServer();
  installGuard(server.address().port);
  process.env.AGENT_PUBLIC_URL = `http://127.0.0.1:${server.address().port}/agent`;
});

test.after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.AGENT_PUBLIC_URL;
  if (server) server.close();
});

const R = fixture.REPOS;

// #112: the health endpoint describes ONE deployed service. A verdict is only
// issued for the repository that endpoint actually serves, so each prod test
// below declares which repo its fixture health endpoint stands in for. The
// refusal case (a foreign repo gets no verdict at all) has its own test.
function healthServes(repo) {
  process.env.ENGINEERING_DELIVERY_REPO = repo;
  return () => { delete process.env.ENGINEERING_DELIVERY_REPO; };
}

test('S3: open PR with failed CI → red verdict, compressed log tail, expired log handled', async () => {
  const r = await prStatus(R.X, 42);
  assert.equal(r.ok, true);
  assert.equal(r.pr.state, 'open');
  assert.equal(r.pr.number, 42);
  assert.equal(r.ci.status, 'failure');
  assert.equal(r.ci.verdict, 'red');
  assert.equal(r.summary.total, 3);
  assert.ok(r.check_runs.some(c => c.name === 'staging-gate'), 'staging-gate visible');
  assert.ok(!JSON.stringify(r).includes(process.env.GH_TOKEN), 'token never leaks');

  const fj = r.failed_jobs || [];
  assert.ok(fj.length >= 1 && fj.length <= 3, `failed_jobs 1..3, got ${fj.length}`);
  const withLog = fj.find(x => x.log_tail);
  assert.ok(withLog, 'at least one job with a log tail');
  assert.ok(withLog.name && withLog.url, 'job exposes name + url');
  assert.ok(withLog.log_tail.length < fixture.JOB_LOG_22.length / 4, 'log tail compressed');
  assert.match(withLog.log_tail, /ERROR|AssertionError|Process completed/, 'compressed tail keeps the error');
  const expired = fj.find(x => x.log_error === 'expired');
  assert.ok(expired, '410 log → log_error: expired, log_tail null');
  assert.equal(expired.log_tail, null);
});

test('S3: aggregate — pending / none / all-skipped are not green', () => {
  const pending = aggregate([{ status: 'in_progress', conclusion: null }], null, null);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.verdict, 'pending');

  const none = aggregate([], null, null);
  assert.equal(none.status, 'no-checks');
  assert.equal(none.verdict, 'none');

  const allSkipped = aggregate([{ status: 'completed', conclusion: 'skipped' }], null, null);
  assert.equal(allSkipped.status, 'neutral', 'all-skipped → no evidence');
  assert.equal(allSkipped.verdict, 'none');

  const csSuccess = aggregate([], { state: 'success', total_count: 1 }, null);
  assert.equal(csSuccess.status, 'success', 'commit-status fallback still works');
  assert.equal(csSuccess.verdict, 'green');
});

test('S3/S4: merged PR → live prod verdict from health-compare only', async () => {
  const restore = healthServes(R.X);
  try {
    const r = await prStatus(R.X, 77);
  assert.equal(r.ok, true);
  assert.equal(r.pr.merged, true);
  assert.equal(r.pr.merge_commit_sha, 'sha-merged');
  assert.equal(r.ci.verdict, 'green');
  assert.ok(r.prod, 'prod block present for a merged PR');
    assert.equal(r.prod.verdict, 'live');
    assert.equal(r.prod.source, 'health-compare', 'live only from health-compare');
  } finally { restore(); }
});

test('S4: a repo the health endpoint does not serve gets NO prod verdict (#112)', async () => {
  const restore = healthServes(R.X);
  try {
    const r = await prStatus(R.Y, 78);
    assert.equal(r.ok, true);
    assert.equal(r.prod.verdict, 'unknown');
    assert.equal(r.prod.evidence, 'prod-endpoint-other-repo');
    assert.equal(r.prod.delivery_repo, R.X);
  } finally { restore(); }
});

test('S4: lagging production → not_yet (never live)', async () => {
  const restore = healthServes(R.Y);
  try {
    const r = await prStatus(R.Y, 78);
    assert.equal(r.ok, true);
    assert.equal(r.prod.verdict, 'not_yet');
  } finally { restore(); }
});

test('S4: repo without a health endpoint → unknown + deploy-green evidence', async () => {
  // This repo IS declared as served, but its merge commit is not the one prod
  // runs — a green deploy job must stay evidence, never the verdict.
  const restore = healthServes(R.SKILL);
  try {
    const r = await prStatus(R.SKILL, 5);
    assert.equal(r.ok, true);
    assert.equal(r.prod.verdict, 'unknown');
    assert.match(String(r.prod.evidence), /deploy/i, 'deploy job is evidence, not a verdict');
    assert.notEqual(r.prod.source, 'health-compare');
  } finally { restore(); }
});

test('S4: open PR has no prod block; autofix PR is found by branch prefix', async () => {
  const r = await prStatus(R.X, 42);
  assert.equal(r.prod, undefined, 'no prod block for an open PR');
  assert.ok(r.autofix_pr, 'autofix PR found');
  assert.equal(r.autofix_pr.number, 43);
  assert.ok(r.autofix_pr.url && r.autofix_pr.state);

  const none = await prStatus(R.Y, 78);
  assert.equal(none.autofix_pr, null, 'no matching branch → null');
});

test('S4: over-budget response is truncated with explicit counters', async () => {
  const r = await prStatus(R.X, 99);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, 'over 1.5k tokens → truncated');
  const om = r.truncated_omitted || {};
  assert.ok((om.check_runs || 0) > 0 || (om.failed_jobs || 0) > 0, 'omitted counters present');
  assert.ok(r.check_runs.length <= 20, `check_runs <= 20, got ${r.check_runs.length}`);
  assert.ok(r.failed_jobs.length <= 3, `failed_jobs <= 3, got ${r.failed_jobs.length}`);
  for (const j of r.failed_jobs) {
    if (j.log_tail) assert.ok(j.log_tail.length <= 8000, `log_tail <= 8000, got ${j.log_tail.length}`);
  }
  assert.ok(JSON.stringify(r).length <= 20000, `response <= 20k chars, got ${JSON.stringify(r).length}`);
});

test('S3: typed errors — NOT_A_PR / NOT_FOUND / GITHUB_AUTH', async () => {
  const asIssue = await prStatus(R.X, 52);
  assert.equal(asIssue.ok, false);
  assert.equal(asIssue.error.code, 'NOT_A_PR');
  assert.match(`${asIssue.error.hint}${asIssue.error.message}`, /issue_status/);

  const missing = await prStatus(R.X, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.match(missing.error.message, /404/, 'message keeps the API status for the alias throw');

  const auth = await prStatus('auth-test/x', 1);
  assert.equal(auth.ok, false);
  assert.equal(auth.error.code, 'GITHUB_AUTH');
  assert.ok(!JSON.stringify(auth).includes(process.env.GH_TOKEN), 'auth error does not leak the token');
});
