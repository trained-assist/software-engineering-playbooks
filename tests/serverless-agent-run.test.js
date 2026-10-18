'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { agentRunStart, agentRunWait } = require('../src/serverless-agent/run');
const { handleRequest } = require('../src/mcp-checklists');

const runId = `run_${'a'.repeat(64)}_${'b'.repeat(24)}`;
const config = { baseUrl: 'https://runner.example', token: 'private-token' };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('MCP tools are opt-in and start passes a stable idempotency key without exposing the API token', async () => {
  const listed = await handleRequest({ id: 1, method: 'tools/list' }, { runnerConfig: config });
  assert.deepEqual(listed.result.tools.map(tool => tool.name).slice(-2), ['agent_run_start', 'agent_run_wait']);
  let calls = 0;
  const fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://runner.example/v1/developer/runs');
    assert.equal(options.headers['idempotency-key'], 'task-1');
    assert.equal(options.headers.authorization, 'Bearer private-token');
    assert.deepEqual(JSON.parse(options.body), { prompt: 'Do the task', model: { mode: 'managed' } });
    return json(202, { runId, deduplicated: calls > 1 });
  };
  const first = await agentRunStart({ task: 'Do the task', idempotency_key: 'task-1' }, { ...config, fetch });
  const second = await agentRunStart({ task: 'Do the task', idempotency_key: 'task-1' }, { ...config, fetch });
  assert.equal(first.run_id, runId);
  assert.equal(second.run_id, runId);
  assert.equal(second.deduplicated, true);
  assert.doesNotMatch(JSON.stringify(first), /private-token/);
});

test('start supports a registered BYOK connection ID and treats an unknown admission as retryable with the same key', async () => {
  const bodies = [];
  const accepted = await agentRunStart({ task: 'Build', idempotency_key: 'task-2', connection_id: 'openai-1', timeout_seconds: 600 }, {
    ...config, fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return json(202, { runId }); },
  });
  assert.equal(accepted.run_id, runId);
  assert.deepEqual(bodies[0], { prompt: 'Build', model: { mode: 'byok', connectionId: 'openai-1' }, limits: { timeoutSeconds: 600 } });
  const unknown = await agentRunStart({ task: 'Build', idempotency_key: 'task-2' }, { ...config, fetch: async () => { throw Error('lost response'); } });
  assert.equal(unknown.error, 'ADMISSION_UNKNOWN');
  assert.match(unknown.summary, /idempotency_key/);
});

test('wait returns the final answer, failure, history artifact and expiring download link', async () => {
  let time = 0;
  const requests = [];
  const result = await agentRunWait({ run_id: runId, timeout_seconds: 20, interval_seconds: 2 }, {
    ...config, now: () => time, sleep: async ms => { time += ms; },
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('/result')) return json(200, { text: 'Done', artifacts: [{ path: 'agent-history.json', name: 'agent-history.json', mime: 'application/json', size: 123, downloadUrl: 'https://runner.example/v1/developer/downloads/signed', expiresAt: '2026-10-16T00:00:00Z' }], artifactExpiresAt: '2026-10-16T00:00:00Z' });
      return json(200, { state: requests.length === 1 ? 'running' : 'succeeded' });
    },
  });
  assert.equal(result.outcome, 'success');
  assert.equal(result.summary, 'Done');
  assert.equal(result.elapsed_seconds, 2);
  assert.equal(result.artifacts[0].path, 'agent-history.json');
  assert.match(result.artifacts[0].download_url, /^https:\/\//);
  assert.equal(result.artifacts_expire_at, '2026-10-16T00:00:00Z');
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  const failed = await agentRunWait({ run_id: runId }, { ...config, fetch: async url => url.endsWith('/result')
    ? json(200, { failure: { safeSummary: 'Execution failed' } }) : json(200, { state: 'failed' }) });
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.summary, 'Execution failed');
});

test('timeout and transient failures keep the run resumable', async () => {
  let time = 0;
  let polls = 0;
  const timed = await agentRunWait({ run_id: runId, timeout_seconds: 3, interval_seconds: 2 }, {
    ...config, now: () => time, sleep: async ms => { time += ms; },
    fetch: async () => { polls += 1; if (polls === 1) throw Error('network'); if (polls === 2) return json(503, { error: { code: 'TEMPORARY' } }); return json(200, { state: 'running' }); },
  });
  assert.equal(timed.state, 'timed_out');
  assert.equal(timed.run_id, runId);
  const resumed = await agentRunWait({ run_id: timed.run_id }, { ...config, fetch: async url => url.endsWith('/result') ? json(200, { text: 'Recovered' }) : json(200, { state: 'succeeded' }) });
  assert.equal(resumed.summary, 'Recovered');
});

test('MCP cancellation stops local waiting without sending a remote cancel request', async () => {
  const pending = new Map();
  const urls = [];
  const fetch = async url => { urls.push(url); return json(200, { state: 'running' }); };
  const controller = new AbortController();
  const waiting = agentRunWait({ run_id: runId }, { ...config, fetch, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await waiting;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.outcome, 'pending');
  assert.equal(urls.every(url => !url.endsWith('/cancel')), true);

  const call = handleRequest({ id: 41, method: 'tools/call', params: { name: 'agent_run_wait', arguments: { run_id: runId } } }, {
    pending, runnerConfig: config,
    waitRun: async (_args, deps) => new Promise(resolve => deps.signal.addEventListener('abort', () => resolve({ ok: true, state: 'cancelled', outcome: 'pending', run_id: runId }), { once: true })),
  });
  await new Promise(resolve => setImmediate(resolve));
  await handleRequest({ method: 'notifications/cancelled', params: { requestId: 41 } }, { pending });
  assert.equal(JSON.parse((await call).result.content[0].text).state, 'cancelled');
  assert.equal(pending.size, 0);
});

test('auth errors and invalid IDs are explicit', async () => {
  assert.equal((await agentRunWait({ run_id: 'bad' }, config)).state, 'invalid_request');
  const denied = await agentRunWait({ run_id: runId }, { ...config, fetch: async () => json(401, { error: { code: 'UNAUTHENTICATED' } }) });
  assert.equal(denied.error, 'HTTP_401');
  assert.equal(denied.run_id, runId);
});
