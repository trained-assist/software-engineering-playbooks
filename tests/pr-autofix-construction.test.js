'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { constructionTasks, sha256, Z01 } = require('../src/pr-autofix/construction');
const tableBytes = Buffer.from('{"repos":[]}');
const tasks = [{ repo: 'fixture/repo', kind: 'ci_missing', title: 'missing CI', detail: 'Add CI', refs: ['AC-20', 'AC-21'] }];
const reviewed = { approved: true, source: Z01, table_sha256: sha256(tableBytes), tasks: tasks.map(task => ({ repo: task.repo, kind: task.kind, owner: task.repo, task })) };
test('dry-run performs no API calls, apply refuses missing, stale and incomplete review before writes', async () => {
  const github = { ghFetch: () => { throw Error('API must not run'); } };
  assert.equal((await constructionTasks({ tableBytes, tasks, github })).applied, false);
  for (const review of [null, { ...reviewed, table_sha256: 'stale' }, { ...reviewed, tasks: [] }, { ...reviewed, approved: false }]) {
    await assert.rejects(() => constructionTasks({ tableBytes, tasks, github, apply: true, reviewed: review }), { code: 'REVIEW_REQUIRED' });
  }
});
test('approved apply creates owner-bound issues once and retries without duplicates', async () => {
  const issues = []; let posts = 0;
  const github = { ghFetch: async (method, endpoint, body) => {
    if (method === 'GET') return { ok: true, data: issues };
    posts++; const issue = { ...body, html_url: 'https://example.test/issue/1' }; issues.push(issue);
    return { ok: true, data: issue };
  } };
  const args = { tableBytes, tasks, reviewed, apply: true, github };
  const a = await constructionTasks(args), b = await constructionTasks(args);
  assert.equal(a.receipts[0].created, true); assert.equal(b.receipts[0].created, false);
  assert.equal(posts, 1); assert.match(issues[0].body, /Owner: fixture\/repo/);
  assert.ok(issues[0].body.includes(Z01));
});
test('failed issue lookup never falls through to creation', async () => {
  await assert.rejects(() => constructionTasks({ tableBytes, tasks, reviewed, apply: true,
    github: { ghFetch: async method => { assert.equal(method, 'GET'); return { ok: false }; } },
  }), { code: 'ISSUE_READ_FAILED' });
});
