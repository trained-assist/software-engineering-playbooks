'use strict';

const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

let handleQueue;
let handleWebhook;
before(async () => {
  ({ handleQueue, handleWebhook } = await import('../services/github-event-relay/src/index.mjs'));
});

const SECRET = 'unit-test-webhook-secret-that-is-at-least-32-chars';
const payload = {
  action: 'completed',
  installation: { id: 456, app_id: 123 },
  repository: { id: 789, full_name: 'owner/name' },
  check_run: {
    id: 101, name: 'test', head_sha: 'abc123', status: 'completed', conclusion: 'failure',
    html_url: 'https://github.com/owner/name/runs/101',
    pull_requests: [{ number: 17 }],
  },
};

function signedRequest(body = JSON.stringify(payload), { event = 'check_run', signatureSecret = SECRET } = {}) {
  const signature = createHmac('sha256', signatureSecret).update(body).digest('hex');
  return new Request('https://relay.example/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'x-github-delivery': '12345678-1234-1234-1234-123456789abc',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
  });
}

test('webhook verifies raw body, normalizes only needed fields, and enqueues before 202', async () => {
  let queued;
  const response = await handleWebhook(signedRequest(), {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_EVENTS: { send: async message => { queued = message; } },
  }, () => new Date('2026-10-20T10:00:00.000Z'));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, event_id: 'github:12345678-1234-1234-1234-123456789abc' });
  assert.deepEqual(queued, {
    schema_version: 1,
    event_id: 'github:12345678-1234-1234-1234-123456789abc',
    source: 'github', app_id: 123, installation_id: 456,
    repository_id: 789, repository_full_name: 'owner/name',
    event_type: 'check_run', action: 'completed', received_at: '2026-10-20T10:00:00.000Z',
    subject: {
      head_sha: 'abc123', check_run_id: 101, check_suite_id: null, name: 'test',
      status: 'completed', conclusion: 'failure', pull_request_numbers: [17],
      html_url: 'https://github.com/owner/name/runs/101',
    },
  });
  assert.equal(JSON.stringify(queued).includes('webhook-secret'), false);
});

test('webhook rejects invalid signature and never queues the payload', async () => {
  let sends = 0;
  const response = await handleWebhook(signedRequest(JSON.stringify(payload), { signatureSecret: 'wrong-secret-with-enough-length-000' }), {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_EVENTS: { send: async () => { sends += 1; } },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_signature' });
  assert.equal(sends, 0);
});

test('unsupported webhook events are acknowledged and ignored after signature verification', async () => {
  let sends = 0;
  const body = JSON.stringify({ repository: payload.repository });
  const response = await handleWebhook(signedRequest(body, { event: 'issues' }), {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_EVENTS: { send: async () => { sends += 1; } },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, ignored: true, reason: 'unsupported_event' });
  assert.equal(sends, 0);
});

test('queue consumer broadcasts to repository channels and retries a failed channel delivery', async () => {
  const calls = [];
  const makeMessage = body => ({
    body,
    ack() { calls.push(['ack', body.event_id]); },
    retry(options) { calls.push(['retry', body.event_id, options]); },
  });
  const ok = { event_id: 'github:ok', repository_full_name: 'owner/name' };
  const retry = { event_id: 'github:retry', repository_full_name: 'owner/retry' };
  const messages = [makeMessage(ok), makeMessage(retry)];
  const requests = [];
  await handleQueue({ messages }, {
    GITHUB_EVENT_CHANNELS: {
      idFromName: name => name,
      get: id => ({ fetch: async (url, init) => {
        requests.push([id, url, init]);
        return { ok: id === 'owner/name' };
      } }),
    },
  });

  assert.ok(calls.some(call => call[0] === 'ack' && call[1] === 'github:ok'));
  assert.ok(calls.some(call => call[0] === 'retry' && call[1] === 'github:retry' && call[2].delaySeconds === 30));
  const published = requests.find(request => request[0] === 'owner/name');
  assert.equal(published[1], 'https://channel/publish');
  assert.deepEqual(JSON.parse(published[2].body), ok);
});
