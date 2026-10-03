'use strict';

// Issue #108 — engineering_repo_find contract: name / former-name / purpose
// retrieval, honest no_match, archive filtering, pagination, freshness,
// auth-error propagation. Fully deterministic: GitHub is a fixture, the
// definitions file is a temp file — no network in `npm test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findRepos, clearCache } = require('../src/repo-catalog');

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  delete process.env.REPO_CATALOG_FILE;
  clearCache();
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function writeDefinitions(obj) {
  const dir = tmp('repo-catalog-');
  const file = path.join(dir, 'repo-catalog.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  process.env.REPO_CATALOG_FILE = file;
  clearCache();
  return file;
}

const FIXTURE = [
  {
    id: 1,
    full_name: 'trained-assist/trained-assist-hh-skill',
    description: 'Recruiting domain skill: vacancy search and candidate screening for hh.ru',
    default_branch: 'main',
    archived: false,
    owner: { login: 'trained-assist' },
  },
  {
    id: 2,
    full_name: 'trained-assist/software-engineering-playbooks',
    description: 'Playbooks, engineering MCP tools and the execution-plan compiler',
    default_branch: 'main',
    archived: false,
    owner: { login: 'trained-assist' },
  },
  {
    id: 3,
    full_name: 'trained-assist/legacy-recruiting-scripts',
    description: 'Legacy recruiting scripts',
    default_branch: 'master',
    archived: true,
    owner: { login: 'trained-assist' },
  },
  {
    id: 4,
    full_name: 'kobzevvv/flexi-exhibition-deal-bot',
    description: 'Telegram bot for exhibition deal pipeline',
    default_branch: 'main',
    archived: false,
    owner: { login: 'kobzevvv' },
  },
];

const ghFetch = async () => FIXTURE;

function find(input, deps = {}) {
  return findRepos({ refresh: true, ...input }, { ghFetch, ...deps });
}

test('exact repository name returns that repo first with an exact reason', async () => {
  const res = await find({ query: 'trained-assist-hh-skill' });
  assert.equal(res.no_match, false);
  assert.equal(res.repos[0].full_name, 'trained-assist/trained-assist-hh-skill');
  assert.deepEqual(res.repos[0].match_reasons, [{ field: 'name', kind: 'exact' }]);
  assert.equal(res.repos[0].score, 100);
  assert.ok(res.repos[0].source_refs.some(r => r.startsWith('github:repo/1@')));
  assert.ok(res.freshness.observed_at);
  assert.equal(typeof res.freshness.catalog_size, 'number');
});

test('former name (rename alias from definitions) finds the renamed repo', async () => {
  writeDefinitions({
    aliases: { 'trained-assist/software-engineering-playbooks': ['trained-assist-engineering'] },
  });
  const res = await find({ query: 'trained-assist-engineering' });
  assert.equal(res.no_match, false);
  const hit = res.repos[0];
  assert.equal(hit.full_name, 'trained-assist/software-engineering-playbooks');
  assert.ok(hit.match_reasons.some(r => r.field === 'alias' && r.kind === 'exact'));
  assert.ok(hit.source_refs.includes('definitions:docs/repo-catalog.json'));
});

test('Russian purpose query matches English description via term bridge', async () => {
  const res = await find({ query: 'инструменты рекрутера' });
  assert.equal(res.no_match, false);
  const names = res.repos.map(r => r.full_name);
  assert.ok(names.includes('trained-assist/trained-assist-hh-skill'), `expected hh-skill in ${names.join(', ')}`);
  const hh = res.repos.find(r => r.full_name === 'trained-assist/trained-assist-hh-skill');
  const descReason = hh.match_reasons.find(r => r.field === 'description');
  assert.ok(descReason, 'description reason present');
  assert.ok(descReason.matched.some(t => ['recruiting', 'recruiter', 'hh'].includes(t)));
});

test('unknown query returns an honest no_match with an empty list', async () => {
  const res = await find({ query: 'квантовый телепортёр' });
  assert.equal(res.no_match, true);
  assert.deepEqual(res.repos, []);
  assert.equal(res.next_cursor, null);
  assert.ok(res.freshness.catalog_size > 0, 'catalog was still described');
});

test('archived repos are filtered out but reported, not silently dropped', async () => {
  const filtered = await find({ query: 'legacy recruiting' });
  assert.ok(!filtered.repos.some(r => r.full_name === 'trained-assist/legacy-recruiting-scripts'));
  assert.ok(filtered.excluded.some(e => e.full_name === 'trained-assist/legacy-recruiting-scripts' && e.reason === 'archived'));

  const included = await find({ query: 'legacy recruiting', include_archived: true });
  assert.ok(included.repos.some(r => r.full_name === 'trained-assist/legacy-recruiting-scripts' && r.archived === true));
});

test('pagination: limit + cursor walk the ranked list without repeats', async () => {
  const all = await find({ query: 'trained assist', limit: 50 });
  assert.ok(all.repos.length >= 2, `expected several matches, got ${all.repos.length}`);

  const first = await find({ query: 'trained assist', limit: 1 });
  assert.equal(first.repos.length, 1);
  assert.equal(first.next_cursor, '1');

  const second = await find({ query: 'trained assist', limit: 1, cursor: first.next_cursor });
  assert.equal(second.repos.length, 1);
  assert.notEqual(second.repos[0].full_name, first.repos[0].full_name);
  assert.ok(first.freshness.total_matches > 1);
});

test('invalid inputs are rejected with explicit codes, not empty results', async () => {
  await assert.rejects(() => find({ query: '   ' }), e => e.code === 'INVALID_QUERY');
  await assert.rejects(() => find({ query: 'x', cursor: 'abc' }), e => e.code === 'INVALID_CURSOR');
  await assert.rejects(() => find({ query: 'x', scope: 'team:foo' }), e => e.code === 'INVALID_SCOPE');
});

test('GitHub auth failure propagates instead of masquerading as no_match', async () => {
  const { GitHubApiError } = require('../src/github/client');
  const failing = async () => { throw new GitHubApiError('GitHub API 401: Bad credentials', 401, '/user/repos'); };
  await assert.rejects(
    () => find({ query: 'anything' }, { ghFetch: failing }),
    e => e.name === 'GitHubApiError' && e.status === 401,
  );
});

test('broken definitions file → partial freshness, results still served', async () => {
  const dir = tmp('repo-catalog-broken-');
  const file = path.join(dir, 'repo-catalog.json');
  fs.writeFileSync(file, '{not json');
  process.env.REPO_CATALOG_FILE = file;
  clearCache();

  const res = await find({ query: 'hh-skill' });
  assert.equal(res.no_match, false);
  assert.equal(res.freshness.completeness, 'partial');
  assert.ok(res.limitations.some(l => l.includes('definitions')));
  const defsSource = res.freshness.sources.find(s => s.name === 'definitions');
  assert.equal(defsSource.status, 'error');
  assert.ok(defsSource.error);
});

test('purpose override is marked derived when the definitions say so', async () => {
  writeDefinitions({
    purposes: {
      'trained-assist/trained-assist-hh-skill': { text: 'Recruiting automation for agentic hiring', derived: true },
    },
  });
  const res = await find({ query: 'trained-assist-hh-skill' });
  const hit = res.repos[0];
  assert.equal(hit.purpose.source, 'definitions');
  assert.equal(hit.purpose.derived, true);
  assert.equal(hit.purpose.text, 'Recruiting automation for agentic hiring');

  const plain = await find({ query: 'flexi-exhibition-deal-bot' });
  assert.equal(plain.repos[0].purpose.source, 'github');
  assert.equal(plain.repos[0].purpose.derived, false);
});

test('catalog requests a stable order so pagination is reproducible', async () => {
  const paths = [];
  const rec = async (p) => { paths.push(p); return FIXTURE; };
  await find({ query: 'hh-skill' }, { ghFetch: rec });
  assert.equal(paths.length, 1, 'one page for a short fixture list');
  assert.match(paths[0], /\/user\/repos\?/);
  assert.match(paths[0], /type=all/);
  assert.match(paths[0], /sort=full_name/);

  paths.length = 0;
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    id: 1000 + i,
    full_name: `o/repo-${i}`,
    description: 'filler',
    default_branch: 'main',
    archived: false,
    owner: { login: 'o' },
  }));
  const full = async (p) => { paths.push(p); return p.includes('&page=1') ? fullPage : FIXTURE; };
  await find({ query: 'repo-1', scope: 'org:trained-assist' }, { ghFetch: full });
  assert.match(paths[0], /\/orgs\/trained-assist\/repos\?type=all/);
  assert.equal(paths.length, 2, 'a second page is requested only when the first one is full');

  paths.length = 0;
  const alwaysFull = async () => { paths.push('page'); return fullPage; };
  const capped = await find({ query: 'repo-1', scope: 'org:trained-assist' }, { ghFetch: alwaysFull });
  assert.equal(paths.length, 3, 'catalog fetch is capped at MAX_PAGES');
  assert.equal(capped.freshness.completeness, 'full');
  assert.ok(capped.limitations.some(l => l.includes('усечён')), 'truncation is reported, not hidden');
});

test('registry end-to-end: tools/call path returns the same contract', async () => {
  const { callTool } = require('../src/mcp-skills/registry');
  const savedToken = process.env.GH_TOKEN;
  const savedFetch = globalThis.fetch;
  const savedDefs = process.env.REPO_CATALOG_FILE;
  process.env.GH_TOKEN = 'test-token';
  delete process.env.REPO_CATALOG_FILE;
  clearCache();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(FIXTURE),
    json: async () => FIXTURE,
  });
  try {
    const res = await callTool('engineering_repo_find', { query: 'плейбуки', refresh: true });
    assert.equal(res.no_match, false);
    assert.ok(res.repos.length >= 1);
    assert.ok(Array.isArray(res.repos[0].match_reasons) && res.repos[0].match_reasons.length > 0);
    assert.ok(res.freshness.observed_at);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    if (savedDefs === undefined) delete process.env.REPO_CATALOG_FILE; else process.env.REPO_CATALOG_FILE = savedDefs;
    clearCache();
  }
});
