'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChecks, validateInput, waitForCi } = require('../src/github/ci-wait');

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'Error',
    headers: { get: name => headers[name.toLowerCase()] || null },
    json: async () => body,
  };
}

test('wait limits default to three minutes and fifteen minutes; cannot exceed API-safe bounds', () => {
  assert.equal(validateInput({ repo: 'owner/repo', sha: 'abc' }), null);
  assert.match(validateInput({ repo: 'owner/repo', sha: 'abc', interval_seconds: 60 }), /не чаще одного запроса в три минуты/u);
  assert.match(validateInput({ repo: 'owner/repo', sha: 'abc', timeout_minutes: 91 }), /от 1 до 90/u);
  assert.match(validateInput({ repo: 'owner/repo', timeout_minutes: 15 }), /Передай run_id, sha или pr_number/u);
});

test('check matching can wait only for the named checks and reports terminal failures', () => {
  const result = classifyChecks([
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'in_progress', conclusion: null },
    { name: 'unrelated', status: 'in_progress', conclusion: null },
  ], ['unit']);
  assert.equal(result.finished, true);
  assert.equal(result.outcome, 'success');
  const failed = classifyChecks([
    { name: 'unit', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(failed.finished, true);
  assert.equal(failed.outcome, 'failure');
  const skipped = classifyChecks([{ name: 'docs', status: 'completed', conclusion: 'skipped' }]);
  assert.equal(skipped.finished, true);
  assert.equal(skipped.outcome, 'completed_with_non_success');
});

test('GitHub checks completion wakes the wait with a concise success report using anonymous public fetch', async () => {
  let calls = 0;
  const result = await waitForCi({ repo: 'owner/repo', sha: 'abc123' }, {
    token: null,
    fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.github.com/repos/owner/repo/commits/abc123/check-runs?per_page=100&page=1');
      assert.equal(init.headers.Authorization, undefined);
      return response({ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://github.test/check/1' }] });
    },
    now: () => 1_000,
  });
  assert.equal(calls, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.outcome, 'success');
  assert.match(result.summary, /успешно/u);
  assert.equal(result.polls, 1);
});

test('pagination prevents a 100-check first page from being mistaken for the full result', async () => {
  const urls = [];
  let time = 0;
  const result = await waitForCi({ repo: 'owner/repo', sha: 'many-checks', timeout_minutes: 1 }, {
    token: null,
    now: () => time,
    sleep: async ms => { time += ms; },
    fetch: async url => {
      urls.push(url);
      const page = new URL(url).searchParams.get('page');
      return page === '1'
        ? response({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' })) })
        : response({ total_count: 101, check_runs: [{ name: 'late-check', status: 'in_progress', conclusion: null }] });
    },
  });
  assert.equal(urls.length, 2);
  assert.equal(result.state, 'timed_out');
  assert.equal(result.finished, false);
  assert.equal(result.total_checks, 101);
  assert.equal(result.fetched_check_count, 101);
  assert.deepEqual(result.pending_checks.map(check => check.name), ['late-check']);
});

test('PR wait resolves the current head SHA and returns red checks as a terminal report', async () => {
  const urls = [];
  const result = await waitForCi({ repo: 'owner/repo', pr_number: 7 }, {
    token: 'test-token',
    fetch: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      if (url.endsWith('/pulls/7')) return response({ head: { sha: 'head-sha' }, html_url: 'https://github.test/owner/repo/pull/7' });
      return response({ check_runs: [{ name: 'unit', status: 'completed', conclusion: 'failure' }] });
    },
    now: () => 2_000,
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repos/owner/repo/pulls/7',
    'https://api.github.com/repos/owner/repo/commits/head-sha/check-runs?per_page=100&page=1',
  ]);
  assert.equal(result.state, 'completed');
  assert.equal(result.outcome, 'failure');
  assert.equal(result.pr_url, 'https://github.test/owner/repo/pull/7');
  assert.deepEqual(result.failed_checks, [{ name: 'unit', status: 'completed', conclusion: 'failure', count: 1, url: null }]);
});

test('completed Actions runs include failed job names while retaining the run verdict', async () => {
  const urls = [];
  const result = await waitForCi({ repo: 'owner/repo', run_id: 42 }, {
    token: 'test-token',
    fetch: async url => {
      urls.push(url);
      if (url.endsWith('/actions/runs/42')) return response({ id: 42, status: 'completed', conclusion: 'failure', html_url: 'https://github.test/run/42' });
      return response({ jobs: [
        { name: 'unit', conclusion: 'success' },
        { name: 'integration', conclusion: 'failure', html_url: 'https://github.test/job/8' },
      ] });
    },
  });
  assert.equal(result.outcome, 'failure');
  assert.deepEqual(result.failed_jobs, [{ name: 'integration', conclusion: 'failure', url: 'https://github.test/job/8' }]);
  assert.equal(urls.length, 2);
});

test('wait wakes with timeout and last observed check state', async () => {
  let time = 0;
  let calls = 0;
  const result = await waitForCi({ repo: 'owner/repo', run_id: 42, interval_seconds: 180, timeout_minutes: 1 }, {
    token: 'test-token',
    now: () => time,
    sleep: async ms => { assert.equal(ms, 60_000); time += ms; },
    fetch: async () => {
      calls += 1;
      return response({ id: 42, status: 'in_progress', conclusion: null, html_url: 'https://github.test/run/42' });
    },
  });
  assert.equal(result.state, 'timed_out');
  assert.equal(result.outcome, 'pending');
  assert.equal(result.run.run_id, 42);
  assert.equal(result.elapsed_seconds, 60);
  assert.equal(result.polls, 1);
  assert.equal(calls, 2); // run snapshot plus in-progress job check
  assert.match(result.summary, /ещё не завершились/u);
});

test('GitHub rate limits return immediately with reset guidance', async () => {
  const result = await waitForCi({ repo: 'owner/repo', run_id: 42 }, {
    token: null,
    fetch: async () => response({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-reset': '12345' } }),
  });
  assert.equal(result.state, 'error');
  assert.equal(result.http_status, 403);
  assert.equal(result.rate_limit_reset, '12345');
  assert.match(result.error, /лимит GitHub/u);
});

test('an interrupted wait stops cleanly so the agent can retry with changed conditions', async () => {
  const controller = new AbortController();
  const waiting = waitForCi({ repo: 'owner/repo', run_id: 42 }, {
    token: 'test-token',
    fetch: async () => response({ id: 42, status: 'in_progress', conclusion: null }),
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await waiting;
  assert.equal(result.state, 'cancelled');
  assert.match(result.summary, /с новыми условиями/u);
});
