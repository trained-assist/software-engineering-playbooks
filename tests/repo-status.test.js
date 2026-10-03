'use strict';

// Issue #109 — engineering_repo_status contract. The load-bearing part is the
// difference between "newest PR", "newest MERGED PR" and "head commit": a
// closed PR updated yesterday must not pass for a merge, and no section may be
// served without its own freshness. Deterministic: a path router replaces
// GitHub, no network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { repoStatus, clearCache } = require('../src/repo-status');

const REPO = 'trained-assist/software-engineering-playbooks';

const IDENTITY = {
  id: 10,
  full_name: REPO,
  description: 'Playbooks and engineering MCP tools',
  default_branch: 'main',
  archived: false,
  private: true,
  open_issues_count: 14,
  pushed_at: '2026-10-03T20:00:00Z',
  updated_at: '2026-10-03T20:00:00Z',
};

const NEWEST_PR = {
  number: 9, title: 'MCP tool', state: 'open', draft: false,
  created_at: '2026-10-03T19:00:00Z', updated_at: '2026-10-03T19:00:00Z', merged_at: null,
  user: { login: 'kobzevvv' }, head: { ref: 'feat/tool', sha: 'head-sha-1' },
  merge_commit_sha: null, html_url: 'https://example/pr/9',
};

// Updated yesterday, closed WITHOUT a merge — the trap for "last merge".
const CLOSED_NO_MERGE = {
  number: 8, title: 'Abandoned experiment', state: 'closed', draft: false,
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-03T12:00:00Z', merged_at: null,
  user: { login: 'kobzevvv' }, head: { ref: 'chore/exp', sha: 'dead-sha' },
  merge_commit_sha: null, html_url: 'https://example/pr/8',
};

const MERGED_OLD = {
  number: 7, title: 'Real merge', state: 'closed', draft: false,
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-02T10:00:00Z', merged_at: '2026-09-02T10:00:00Z',
  user: { login: 'kobzevvv' }, head: { ref: 'feat/real', sha: 'old-sha' },
  merge_commit_sha: 'merge-sha-7', html_url: 'https://example/pr/7',
};

function router({ calls = [], closed = [CLOSED_NO_MERGE, MERGED_OLD], checkRuns = null, failPaths = [] } = {}) {
  return async (p) => {
    // GitHub search queries arrive URL-encoded (q=repo%3A…+type%3Apr+state%3Aopen).
    const path = decodeURIComponent(String(p));
    calls.push(String(p));
    for (const fragment of failPaths) {
      if (path.includes(fragment)) {
        const e = new Error(`GitHub API 500: boom (${fragment})`);
        e.status = 500;
        e.name = 'GitHubApiError';
        throw e;
      }
    }
    if (path === `/repos/${REPO}`) return IDENTITY;
    if (path.includes('/commits?sha=')) {
      return [{
        sha: 'head-sha-1',
        commit: { message: 'P24: real playbooks\n\nlong body', committer: { date: '2026-10-03T18:00:00Z' }, author: { name: 'Vova' } },
      }];
    }
    if (path.includes('/check-runs')) {
      return checkRuns || { check_runs: [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'staging-gate', status: 'completed', conclusion: 'success' },
      ] };
    }
    if (path.includes('/pulls?state=all')) return [NEWEST_PR];
    if (path.includes('/pulls?state=closed')) return closed;
    if (path.includes('/pulls?state=open')) return [NEWEST_PR];
    if (path.includes('type:pr')) return { total_count: 1, items: [] };
    if (path.includes('type:issue')) return {
      total_count: 7,
      items: [{ number: 107, title: 'Epic', state: 'open', updated_at: '2026-10-03T20:13:00Z', labels: [{ name: 'epic' }], html_url: 'https://example/issue/107' }],
    };
    throw new Error(`unexpected path: ${path}`);
  };
}

test.beforeEach(() => clearCache());
test.after(() => clearCache());

test('status separates newest PR, newest merged PR and head commit', async () => {
  const res = await repoStatus({ repo: REPO }, { ghFetch: router() });
  assert.equal(res.ok, true);
  assert.equal(res.identity.full_name, REPO);
  assert.equal(res.identity.visibility, 'private');

  assert.equal(res.sections.head.sha, 'head-sha-1');
  assert.equal(res.sections.head.branch, 'main');

  assert.equal(res.sections.latest_pr_created.number, 9);
  assert.equal(res.sections.latest_pr_created.merged_at, null);

  assert.equal(res.sections.latest_merge.found, true);
  assert.equal(res.sections.latest_merge.number, 7, 'a closed PR updated later is not a merge');
  assert.equal(res.sections.latest_merge.merge_commit_sha, 'merge-sha-7');
  assert.equal(res.sections.latest_merge.closed_without_merge, 1);

  assert.equal(res.sections.ci.commit_sha, 'head-sha-1');
  assert.equal(res.sections.ci.status, 'success');
});

test('every section carries its own freshness', async () => {
  const res = await repoStatus({ repo: REPO }, { ghFetch: router() });
  for (const name of ['head', 'latest_pr_created', 'latest_merge', 'open_prs', 'open_issues', 'ci']) {
    const s = res.sections[name];
    assert.ok(s, `${name} present`);
    assert.ok(s.built_at, `${name} has built_at`);
    assert.ok(!s.error, `${name} has no error`);
  }
  assert.ok(res.freshness.observed_at);
  assert.equal(res.freshness.cache, 'miss');
  assert.equal(res.freshness.partial, false);
  // No section may claim the change is live in production.
  for (const key of Object.keys(res.sections)) {
    assert.ok(!/production|deployed|release/i.test(key), `section ${key} must not claim production state`);
  }
});

test('no merged PR in the window is reported as unknown, not as the newest closed PR', async () => {
  const res = await repoStatus({ repo: REPO }, { ghFetch: router({ closed: [CLOSED_NO_MERGE] }) });
  assert.equal(res.ok, true);
  assert.equal(res.sections.latest_merge.found, false);
  assert.match(res.sections.latest_merge.note, /no merged PR/);
  assert.equal(res.sections.latest_merge.number, undefined);
});

test('open PRs and issues carry counts, bounded lists and a next_cursor', async () => {
  const res = await repoStatus({ repo: REPO, limits: { prs: 1, issues: 1 } }, { ghFetch: router() });
  assert.equal(res.sections.open_prs.count, 1);
  assert.equal(res.sections.open_prs.returned, 1);
  assert.equal(res.sections.open_prs.next_cursor, '1');
  assert.equal(res.sections.open_issues.count, 7);
  assert.equal(res.sections.open_issues.items[0].number, 107);
  assert.deepEqual(res.sections.open_issues.items[0].labels, ['epic']);
  assert.deepEqual(res.freshness.limits, { prs: 1, issues: 1 });
});

test('access probe runs on every call; sections are cached and refreshable', async () => {
  const calls = [];
  const ghFetch = router({ calls });
  const first = await repoStatus({ repo: REPO }, { ghFetch });
  assert.equal(first.freshness.cache, 'miss');

  const second = await repoStatus({ repo: REPO }, { ghFetch });
  assert.equal(second.freshness.cache, 'hit');
  assert.equal(second.freshness.sections_age_sec, 0);
  assert.ok(calls.filter(p => p === `/repos/${REPO}`).length === 2, 'identity probed on both calls');
  assert.ok(calls.filter(p => p.includes('/pulls?state=all')).length === 1, 'sections served from cache');
  assert.equal(second.sections.latest_pr_created.number, 9);

  await repoStatus({ repo: REPO, refresh: true }, { ghFetch });
  assert.ok(calls.filter(p => p.includes('/pulls?state=all')).length === 2, 'refresh bypasses the cache');
});

test('private repo without access fails honestly and serves no cached answer', async () => {
  const calls = [];
  const ghFetch = router({ calls });
  await repoStatus({ repo: REPO }, { ghFetch });

  const denied = async (p) => {
    if (String(p) === `/repos/${REPO}`) {
      const e = new Error('GitHub API 404: Not Found');
      e.status = 404;
      e.name = 'GitHubApiError';
      throw e;
    }
    return router({ calls })(p);
  };
  const res = await repoStatus({ repo: REPO }, { ghFetch: denied });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NOT_FOUND');
  assert.equal(res.sections, undefined);
});

test('a broken section degrades to partial instead of failing the whole answer', async () => {
  const res = await repoStatus({ repo: REPO }, { ghFetch: router({ failPaths: ['/check-runs'] }) });
  assert.equal(res.ok, true);
  assert.equal(res.freshness.partial, true);
  assert.ok(res.sections.ci.error);
  assert.equal(res.sections.ci.error.code, 'GITHUB_ERROR');
  assert.equal(res.sections.head.sha, 'head-sha-1');
  assert.equal(res.sections.latest_merge.number, 7);
});

test('invalid input is rejected with explicit codes', async () => {
  await assert.rejects(() => repoStatus({ repo: 'not-a-repo' }, { ghFetch: router() }), e => e.code === 'INVALID_REPO');
  await assert.rejects(() => repoStatus({ repo: REPO, limits: { prs: 0 } }, { ghFetch: router() }), e => e.code === 'INVALID_LIMITS');
});

test('registry end-to-end for engineering_repo_status', async () => {
  const { callTool } = require('../src/mcp-skills/registry');
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  clearCache();
  globalThis.fetch = async (url) => {
    const path = String(url).replace('https://api.github.com', '');
    const value = await router()(path);
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
  try {
    const res = await callTool('engineering_repo_status', { repo: REPO, refresh: true });
    assert.equal(res.ok, true);
    assert.equal(res.sections.latest_merge.number, 7);
    assert.ok(res.limitations.some(l => l.includes('merged_at')));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    clearCache();
  }
});