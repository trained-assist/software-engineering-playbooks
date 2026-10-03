'use strict';

// Issue #111 — engineering_change_find / engineering_change_bind contract.
// Deterministic: a path router replaces GitHub (no network), the workspace
// store is a temp dir, and one test deliberately spawns a SECOND process to
// prove the binding survives a restart and stays with its owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { changeFind } = require('../src/change-find/find');
const { changeBind } = require('../src/change-find/bind');
const { parseTaskRef, parseKnownRefs, normTask } = require('../src/change-find/refs');
const store = require('../src/workspace/store');

const REPO = 'trained-assist/software-engineering-playbooks';
const ME = 'trained-assist-product-owner';
const OTHER = 'someone-else-profile';

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpRoot(prefix = 'eng-change-find-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
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
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...record,
    workspaceId: id,
  };
  fs.writeFileSync(path.join(dirs.workspaces, `${id}.json`), JSON.stringify(full, null, 2));
  return full;
}

function pr(n, extra = {}) {
  return {
    number: n,
    title: extra.title || `PR ${n}`,
    state: extra.state || 'open',
    draft: false,
    user: { login: 'kobzevvv' },
    html_url: `https://github.com/${REPO}/pull/${n}`,
    labels: (extra.labels || []).map((l) => ({ name: l })),
    created_at: extra.created_at || '2026-10-03T10:00:00Z',
    updated_at: extra.updated_at || '2026-10-03T12:00:00Z',
    merged_at: extra.merged_at || null,
    head: { ref: extra.head || 'eng/some-branch' },
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${n}` },
  };
}

function issue(n, extra = {}) {
  return {
    number: n,
    title: extra.title || `Issue ${n}`,
    state: extra.state || 'open',
    user: { login: 'kobzevvv' },
    html_url: `https://github.com/${REPO}/issues/${n}`,
    labels: (extra.labels || []).map((l) => ({ name: l })),
    created_at: extra.created_at || '2026-10-03T10:00:00Z',
    updated_at: extra.updated_at || '2026-10-03T12:00:00Z',
  };
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

const at = (suffix) => (p) => p.split('?')[0] === suffix;

const isThemeSearch = (p) => p.includes('/search/issues') && !p.includes('head:');
const isHeadSearch = (p) => p.includes('/search/issues') && p.includes('head:');
const searchResult = (items) => ({ total_count: items.length, items });

const exactOf = (r) => r.candidates.filter((c) => c.relation_type === 'exact');
const inferredOf = (r) => r.candidates.filter((c) => c.relation_type === 'inferred');

test('exact ref outranks a thematically similar PR, and nothing is auto-selected', async () => {
  const root = tmpRoot();
  const { ghFetch, calls } = makeGh([
    { match: at(`/repos/${REPO}/issues/115`), value: pr(115) },
    { match: at(`/repos/${REPO}/pulls/115`), value: pr(115, { head: 'eng/dialog-choice' }) },
    { match: (p) => isThemeSearch(p) && p.includes('type:pr'), value: searchResult([pr(99, { title: 'Похожая тема про выбор диалога' })]) },
    { match: (p) => isThemeSearch(p) && p.includes('type:issue'), value: searchResult([issue(98)]) },
  ]);

  const r = await changeFind({
    repo: REPO,
    task_ref: 'fix dialog choice #115',
  }, { ghFetch, principal: ME, workspaceRoot: root });

  assert.equal(r.ok, true);
  const exact = exactOf(r);
  const inferred = inferredOf(r);

  const stated = exact.find((c) => c.kind === 'pull' && c.ref.number === 115);
  assert.ok(stated, `PR #115 must be exact, got: ${JSON.stringify(r.candidates.map(c => c.identity))}`);
  assert.equal(stated.rank, 1, 'the stated ref is the first candidate');
  assert.ok(stated.evidence.some((e) => e.source === 'task_ref'), 'evidence names the source');

  const theme = inferred.find((c) => c.kind === 'pull' && c.ref.number === 99);
  assert.ok(theme, 'the similar PR is still reported, as inferred');
  assert.ok(theme.rank > exact.length, 'inferred candidates rank after every exact one');
  assert.ok(theme.score > 0 && theme.evidence.some((e) => e.source === 'github_search'));

  assert.equal(r.selection.auto_selected, false);
  assert.ok(!('selected' in r), 'no hidden pick field at all');
  assert.ok(r.sources.some((s) => s.name === 'workspace-store' && s.ok));
  assert.ok(calls.some((c) => c.includes('/search/issues')));
});

test('rows of another profile never become candidates', async () => {
  const root = tmpRoot();
  seedWorkspace(root, { rootTaskId: 'shared-label', branch: 'eng/other-branch', principal: OTHER });
  const foreign = await changeBind(
    { repo: REPO, task_ref: 'shared-label', refs: ['PR #77'] },
    { principal: OTHER, workspaceRoot: root },
  );
  assert.equal(foreign.binding.principal, OTHER);

  const { ghFetch } = makeGh([
    { match: (p) => isThemeSearch(p), value: searchResult([]) },
  ]);
  const r = await changeFind(
    { repo: REPO, task_ref: 'shared-label' },
    { ghFetch, principal: ME, workspaceRoot: root },
  );

  const identities = r.candidates.map((c) => c.identity);
  assert.ok(!identities.includes('PR #77'), `foreign binding leaked: ${identities.join(' | ')}`);
  assert.ok(!identities.some((i) => i.startsWith('workspace ')), `foreign workspace leaked: ${identities.join(' | ')}`);
  assert.ok(r.sources.find((s) => s.name === 'workspace-store').principal === ME);
});

test('bind → a NEW process reads the binding back, still scoped to its owner', async () => {
  const root = tmpRoot();
  const bound = await changeBind(
    { repo: REPO, task_ref: 'resume-after-crash', refs: ['PR #115'] },
    { principal: ME, workspaceRoot: root },
  );
  assert.equal(bound.ok, true);
  assert.equal(bound.persisted, true);
  assert.equal(bound.binding.principal, ME);
  assert.equal(bound.binding.repositoryId, REPO);
  assert.equal(bound.parsed.numbers[0].number, 115);

  // Same task, another profile → a different file, invisible to us.
  await changeBind(
    { repo: REPO, task_ref: 'resume-after-crash', refs: ['PR #77'] },
    { principal: OTHER, workspaceRoot: root },
  );

  const findModule = path.join(__dirname, '..', 'src', 'change-find', 'find.js');
  const script = `
    const { changeFind } = require(${JSON.stringify(findModule)});
    changeFind({ repo: ${JSON.stringify(REPO)}, task_ref: 'resume-after-crash' }, {
      principal: ${JSON.stringify(ME)},
      workspaceRoot: ${JSON.stringify(root)},
      ghFetch: async (p) => {
        const s = decodeURIComponent(String(p));
        if (s.includes('/search/issues')) return { total_count: 0, items: [] };
        const e = new Error('GitHub API 404: ' + s); e.status = 404; throw e;
      },
    }).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, USER_ID: ME } });
  const r = JSON.parse(out);

  assert.equal(r.ok, true, JSON.stringify(r.error || null));
  const binding = r.candidates.find((c) => c.kind === 'binding');
  assert.ok(binding, `binding not found in a fresh process: ${JSON.stringify(r.candidates.map(c => c.identity))}`);
  assert.equal(binding.relation_type, 'exact');
  const pull = r.candidates.find((c) => c.kind === 'pull' && c.ref.number === 115);
  assert.ok(pull, 'the bound PR is reported');
  assert.equal(pull.relation_type, 'exact');
  assert.ok(pull.evidence.some((e) => e.source === 'saved_binding'));
  assert.ok(!r.candidates.some((c) => c.ref && c.ref.number === 77), 'another profile\'s binding is not readable');
});

test('bind refuses to write without an owner', async () => {
  const root = tmpRoot();
  await assert.rejects(
    () => changeBind({ repo: REPO, task_ref: 'x', refs: ['PR #1'] }, { principal: '', workspaceRoot: root }),
    (e) => e.code === 'PRINCIPAL_MISSING',
  );
});

test('a superseded PR is linked to its successor, which becomes an exact candidate', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([
    { match: at(`/repos/${REPO}/issues/50`), value: pr(50, { labels: ['superseded'], state: 'closed' }) },
    { match: at(`/repos/${REPO}/pulls/50`), value: pr(50, { labels: ['superseded'], state: 'closed' }) },
    { match: at(`/repos/${REPO}/issues/50/comments`), value: [{ body: 'Superseded by #51 — попробуй этот' }] },
    { match: at(`/repos/${REPO}/pulls/51`), value: pr(51, { head: 'eng/retry' }) },
    { match: (p) => isThemeSearch(p), value: searchResult([]) },
  ]);

  const r = await changeFind(
    { repo: REPO, task_ref: 'supersede case', known_refs: ['PR #50'] },
    { ghFetch, principal: ME, workspaceRoot: root },
  );

  const old = r.candidates.find((c) => c.kind === 'pull' && c.ref.number === 50);
  assert.ok(old, 'the superseded PR stays visible');
  assert.equal(old.superseded, true);
  assert.deepEqual(old.superseded_by, { kind: 'pull', number: 51, url: `https://github.com/${REPO}/pull/51` });

  const next = r.candidates.find((c) => c.kind === 'pull' && c.ref.number === 51);
  assert.ok(next, 'the successor is returned');
  assert.equal(next.relation_type, 'exact');
  assert.ok(next.evidence.some((e) => e.source === 'supersede_marker'));
  assert.ok(r.sources.some((s) => s.name === 'github_supersede' && s.ok));
});

test('two exact PRs with no supersede link surface a conflict instead of a pick', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([
    { match: at(`/repos/${REPO}/issues/10`), value: pr(10) },
    { match: at(`/repos/${REPO}/pulls/10`), value: pr(10) },
    { match: at(`/repos/${REPO}/issues/11`), value: pr(11) },
    { match: at(`/repos/${REPO}/pulls/11`), value: pr(11) },
    { match: (p) => isThemeSearch(p), value: searchResult([]) },
  ]);

  const r = await changeFind(
    { repo: REPO, task_ref: 'ambiguous', known_refs: ['PR #10', 'PR #11'] },
    { ghFetch, principal: ME, workspaceRoot: root },
  );

  const conflict = r.conflicts.find((c) => c.code === 'MULTIPLE_EXACT_PULLS');
  assert.ok(conflict, `expected a conflict, got ${JSON.stringify(r.conflicts)}`);
  assert.deepEqual(conflict.refs.sort(), ['PR #10', 'PR #11']);
  assert.equal(r.selection.auto_selected, false);
});

test('a branch recorded for the task pulls its PR in as exact', async () => {
  const root = tmpRoot();
  seedWorkspace(root, { rootTaskId: 'ship-it', branch: 'eng/me-ship-it', status: 'code_ready' });
  const { ghFetch } = makeGh([
    { match: (p) => isHeadSearch(p), value: searchResult([pr(7, { head: 'eng/me-ship-it' })]) },
    { match: (p) => isThemeSearch(p) && p.includes('type:pr'), value: searchResult([pr(99, { head: 'eng/unrelated' })]) },
    { match: (p) => isThemeSearch(p) && p.includes('type:issue'), value: searchResult([]) },
  ]);

  const r = await changeFind({ repo: REPO, task_ref: 'ship-it' }, { ghFetch, principal: ME, workspaceRoot: root });

  const fromBranch = r.candidates.find((c) => c.kind === 'pull' && c.ref.number === 7);
  assert.ok(fromBranch, `expected PR #7 from the recorded branch: ${JSON.stringify(r.candidates.map(c => c.identity))}`);
  assert.equal(fromBranch.relation_type, 'exact');
  assert.ok(fromBranch.evidence.some((e) => e.source === 'branch_match'));

  const workspace = r.candidates.find((c) => c.kind === 'workspace');
  assert.ok(workspace && workspace.relation_type === 'exact');
  assert.ok(workspace.evidence.some((e) => e.source === 'workspace_record'));

  const theme = r.candidates.find((c) => c.kind === 'pull' && c.ref.number === 99);
  assert.ok(theme && theme.relation_type === 'inferred');
});

test('time_range drops older candidates and reports how many', async () => {
  const root = tmpRoot();
  seedWorkspace(root, { rootTaskId: 'old-task', updatedAt: '2026-09-01T00:00:00.000Z' });
  const { ghFetch } = makeGh([{ match: (p) => isThemeSearch(p), value: searchResult([]) }]);

  const r = await changeFind(
    { repo: REPO, task_ref: 'old-task', time_range: { since: '2026-10-01' } },
    { ghFetch, principal: ME, workspaceRoot: root },
  );

  assert.ok(!r.candidates.some((c) => c.identity.startsWith('workspace ')), 'the September record is out of range');
  assert.ok(r.freshness.dropped_by_time_range >= 1);
  assert.equal(r.freshness.time_range.since, '2026-10-01T00:00:00.000Z');
});

test('authorization failure is reported as auth, not as "nothing found"', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([{ match: () => true, error: { status: 401, message: 'Bad credentials' } }]);

  const r = await changeFind({ repo: REPO, task_ref: 'anything at all' }, { ghFetch, principal: ME, workspaceRoot: root });

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'GITHUB_AUTH');
  const search = r.sources.find((s) => s.name === 'github_search');
  assert.ok(search && search.ok === false, 'the failing source is visible, not hidden behind an empty answer');
});

test('a ref from another repository is an explicit conflict, never a candidate', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([{ match: at(`/repos/${REPO}/issues/9`), value: pr(9) }]);

  const r = await changeFind(
    { repo: REPO, task_ref: 'see https://github.com/other/repo/pull/9' },
    { ghFetch, principal: ME, workspaceRoot: root },
  );

  assert.ok(!r.candidates.some((c) => c.ref && c.ref.number === 9));
  assert.ok(r.unresolved_refs.some((u) => u.code === 'REF_OUT_OF_SCOPE'));
  assert.ok(r.conflicts.some((c) => c.code === 'REF_OUT_OF_SCOPE'));
});

test('task labels containing hex runs are not mistaken for commits', () => {
  const parsed = parseTaskRef('plan-c4c5b145-r1');
  assert.equal(parsed.commits.length, 0, 'a task label must not become a sha lookup');
  assert.equal(parsed.slug, 'plan-c4c5b145-r1');
  assert.equal(parseKnownRefs(['c4c5b145']).commits.length, 1, 'an explicit ref string IS a sha');
  assert.equal(normTask('  Fix   DIALOG  '), 'fix dialog');
});

test('missing task_ref and query is a hard error, not an empty answer', async () => {
  const root = tmpRoot();
  const { ghFetch } = makeGh([]);
  await assert.rejects(
    () => changeFind({ repo: REPO }, { ghFetch, principal: ME, workspaceRoot: root }),
    (e) => e.code === 'INVALID_TASK_REF',
  );
});
