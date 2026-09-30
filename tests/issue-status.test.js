'use strict';

// Contract tests for issueStatus (slice S5): related PRs across repos from the
// GraphQL timeline, dedup, cross-repo PRs without access, plus the REST and
// body-link fallbacks and the empty case.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const fixture = require('./fixtures/github/pr-status');

process.env.GH_TOKEN = 'test-token-issue-status';
delete process.env.GITHUB_TOKEN;
delete process.env.AGENT_PUBLIC_URL;

const ORIGINAL_FETCH = globalThis.fetch;
const { issueStatus } = require('../src/github/pr-status-core');

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

// Route-table stub for the fallback cases (GraphQL down / no links / body links).
function withFetch(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const raw = typeof input === 'string' ? input : String(input && input.url || input);
    for (const [match, body] of routes) {
      if (!raw.includes(match)) continue;
      if (body instanceof Error) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'Not Found' }) };
      if (typeof body === 'function') return body(raw);
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'Not Found' }) };
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

const DEFAULTS = [
  ['/check-runs', { check_runs: [] }],
  ['/commits/', { state: 'success', total_count: 1, statuses: [] }],
  ['/actions/runs', { total_count: 0, workflow_runs: [] }],
  ['/comments', []],
];

const pr = (repo, n) => ({
  number: n, title: `PR ${n}`, state: 'open', draft: false, merged: false,
  merge_commit_sha: null, merged_at: null, mergeable: true,
  html_url: `https://github.com/${repo}/pull/${n}`,
  head: { sha: `sha-${n}`, ref: `branch-${n}` }, base: { ref: 'main' },
});

test.before(async () => {
  server = await startServer();
  installGuard(server.address().port);
});

test.after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (server) server.close();
});

const R = fixture.REPOS;

test('S5: related PRs across repositories, dedup, no_access, compact answer', async () => {
  const s = await issueStatus(R.X, 52);
  assert.equal(s.ok, true);
  assert.equal(s.issue.state, 'open');
  assert.ok(s.issue.title);

  const prs = s.prs || [];
  const x42 = prs.filter(p => p.repo === R.X && Number(p.number) === 42);
  assert.equal(x42.length, 1, `X#42 exactly once, got ${x42.length}`);

  const repos = new Set(prs.filter(p => !p.error).map(p => p.repo));
  assert.ok(repos.size >= 2, `at least 2 repos, got ${[...repos].join(', ')}`);

  const denied = prs.filter(p => p.error === 'no_access');
  assert.ok(denied.some(p => String(p.ref).includes('other-private')), `cross-repo no_access, got ${JSON.stringify(denied)}`);

  assert.ok(!JSON.stringify(s).includes('log_tail'), 'issue_status stays compact: no log tails');
  assert.equal(s.prs_omitted, 0);
});

test('S5: missing issue → typed NOT_FOUND', async () => {
  const s = await issueStatus(R.X, 999);
  assert.equal(s.ok, false);
  assert.equal(s.error.code, 'NOT_FOUND');
});

test('S5 fallback: GraphQL down → REST timeline still finds cross-repo PRs', async () => {
  const routes = [
    ['/graphql', Object.assign(new Error('graphql down'), {})],
    ...DEFAULTS,
    ['/issues/52/timeline', [
      { event: 'cross-referenced', source: { type: 'pull_request', issue: { html_url: 'https://github.com/owner/repo-a/pull/10', number: 10, repository: { full_name: 'owner/repo-a' } } } },
      { event: 'cross-referenced', source: { type: 'pull_request', issue: { html_url: 'https://github.com/owner/repo-b/pull/20', number: 20, repository: { full_name: 'owner/repo-b' } } } },
    ]],
    ['/issues/52', { number: 52, state: 'open', title: 'rest fallback', html_url: 'https://github.com/owner/repo/issues/52', body: '' }],
    ['/pulls/10', pr('owner/repo-a', 10)],
    ['/pulls/20', pr('owner/repo-b', 20)],
  ];
  await withFetch(routes, async () => {
    const s = await issueStatus('owner/repo', 52);
    assert.equal(s.ok, true);
    const repos = new Set(s.prs.filter(p => !p.error).map(p => p.repo));
    assert.deepEqual([...repos].sort(), ['owner/repo-a', 'owner/repo-b']);
  });
});

test('S5: no linked PRs at all → empty list, not an error', async () => {
  const routes = [
    ['/graphql', new Error('graphql down')],
    ...DEFAULTS,
    ['/issues/7/timeline', []],
    ['/issues/7', { number: 7, state: 'open', title: 'lonely', html_url: 'https://github.com/owner/repo/issues/7', body: '' }],
  ];
  await withFetch(routes, async () => {
    const s = await issueStatus('owner/repo', 7);
    assert.equal(s.ok, true);
    assert.deepEqual(s.prs, []);
    assert.equal(s.prs_omitted, 0);
  });
});

test('S5: PRs linked only from the issue body are picked up', async () => {
  const routes = [
    ['/graphql', new Error('graphql down')],
    ...DEFAULTS,
    ['/issues/9/timeline', []],
    ['/issues/9', { number: 9, state: 'open', title: 'body links', html_url: 'https://github.com/owner/repo/issues/9', body: 'Fixes trained-assist/Z#7 and closes https://github.com/owner/repo-c/pull/33' }],
    ['/pulls/7', pr('trained-assist/Z', 7)],
    ['/pulls/33', pr('owner/repo-c', 33)],
  ];
  await withFetch(routes, async () => {
    const s = await issueStatus('owner/repo', 9);
    assert.equal(s.ok, true);
    const repos = new Set(s.prs.filter(p => !p.error).map(p => p.repo));
    assert.ok(repos.has('trained-assist/Z'), `body link owner/repo#N, got ${[...repos].join(', ')}`);
    assert.ok(repos.has('owner/repo-c'), `body link /pull/N URL, got ${[...repos].join(', ')}`);
  });
});
