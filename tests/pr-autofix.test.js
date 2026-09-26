'use strict';

// Slice 1 (issue #15): pr-autofix registration store + state machine. Local
// state only — upsert idempotency, per-profile isolation, the disable
// transition, and the invariant that only capability records are persisted
// (never credentials).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerAutofix,
  statusAutofix,
  disableAutofix,
  registrationFile,
  RECORD_FIELDS,
  PrAutofixError,
} = require('../src/pr-autofix');
const { callTool } = require('../src/mcp-skills/registry');

const cleanup = [];
const savedEnv = {};
for (const key of ['USER_ID', 'ENGINEERING_PR_AUTOFIX_ROOT']) savedEnv[key] = process.env[key];

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function sample(overrides = {}) {
  return {
    repo: 'trained-assist/demo',
    base_branch: 'main',
    features: { fix: true, cleanup: true, batch: false },
    autofix_ref: 'v1',
    capabilities: { github: 'read+write PRs', openrouter: 'inference' },
    ...overrides,
  };
}

test('register is an idempotent upsert; updated_at bumps, created_at is stable', () => {
  const root = tmp('pr-autofix-');
  const first = registerAutofix({ profileId: 'alice', root, registration: sample() });
  assert.equal(first.created, true);
  assert.equal(first.registration.status, 'registered');
  assert.equal(first.registration.base_branch, 'main');
  assert.deepEqual(first.registration.features, { fix: true, cleanup: true, batch: false });
  assert.deepEqual(first.registration.capabilities, { github: 'read+write PRs', openrouter: 'inference' });

  const created = first.registration.created_at;
  const second = registerAutofix({ profileId: 'alice', root, registration: sample({ base_branch: 'develop' }) });
  assert.equal(second.created, false);
  assert.equal(second.registration.repo, 'trained-assist/demo');
  assert.equal(second.registration.base_branch, 'develop');
  assert.equal(second.registration.created_at, created);
  assert.ok(Date.parse(second.registration.updated_at) > Date.parse(created), 'updated_at should bump');

  const listed = statusAutofix({ profileId: 'alice', root });
  assert.equal(listed.count, 1);
});

test('register never lets the caller set lifecycle status (no auto-enable)', () => {
  const root = tmp('pr-autofix-');
  const result = registerAutofix({ profileId: 'alice', root, registration: sample({ status: 'active' }) });
  assert.equal(result.registration.status, 'registered');
});

test('registrations are isolated per profile and per root', () => {
  const root = tmp('pr-autofix-');
  registerAutofix({ profileId: 'alice', root, registration: sample() });
  assert.equal(statusAutofix({ profileId: 'bob', root }).count, 0);
  assert.equal(fs.existsSync(registrationFile({ profileId: 'alice', root })), true);
  assert.equal(fs.existsSync(registrationFile({ profileId: 'bob', root })), false);
  const otherRoot = tmp('pr-autofix-');
  assert.equal(statusAutofix({ profileId: 'alice', root: otherRoot }).count, 0);
});

test('disable transitions state and is reflected in status; repeated disable is idempotent', () => {
  const root = tmp('pr-autofix-');
  registerAutofix({ profileId: 'alice', root, registration: sample() });

  const disabled = disableAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.registration.status, 'disabled');

  const status = statusAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  assert.equal(status.count, 1);
  assert.equal(status.registrations[0].status, 'disabled');

  const again = disableAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  assert.equal(again.changed, false);
  assert.equal(again.registration.status, 'disabled');
  assert.equal(statusAutofix({ profileId: 'alice', root }).count, 1);

  assert.throws(
    () => disableAutofix({ profileId: 'alice', root, repo: 'trained-assist/unknown' }),
    (e) => e instanceof PrAutofixError && e.code === 'NOT_FOUND',
  );
});

test('a disabled registration stays disabled across re-register (no auto re-enable)', () => {
  const root = tmp('pr-autofix-');
  registerAutofix({ profileId: 'alice', root, registration: sample() });
  disableAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  const reregistered = registerAutofix({ profileId: 'alice', root, registration: sample({ autofix_ref: 'v2' }) });
  assert.equal(reregistered.registration.status, 'disabled');
  assert.equal(reregistered.registration.autofix_ref, 'v2');
});

test('registration rejects raw credential material and persists nothing', () => {
  const root = tmp('pr-autofix-');
  const secret = `ghp_${'A'.repeat(30)}`;
  assert.throws(
    () => registerAutofix({ profileId: 'alice', root, registration: sample({ capabilities: { github: secret } }) }),
    (e) => e instanceof PrAutofixError && e.code === 'CREDENTIAL_REJECTED',
  );
  assert.throws(
    () => registerAutofix({ profileId: 'alice', root, registration: sample({ autofix_ref: `Authorization: Bearer ${'x'.repeat(30)}` }) }),
    (e) => e instanceof PrAutofixError && e.code === 'CREDENTIAL_REJECTED',
  );
  assert.equal(statusAutofix({ profileId: 'alice', root }).count, 0);
  assert.equal(fs.existsSync(registrationFile({ profileId: 'alice', root })), false);
});

test('persisted registration holds capability records only — no secret fields or values', () => {
  const root = tmp('pr-autofix-');
  registerAutofix({ profileId: 'alice', root, registration: sample() });
  const raw = fs.readFileSync(registrationFile({ profileId: 'alice', root }), 'utf8');
  const data = JSON.parse(raw);
  const record = data.registrations[0];

  for (const field of Object.keys(record)) {
    assert.ok(RECORD_FIELDS.includes(field), `unexpected persisted field ${field}`);
  }
  for (const field of ['token', 'secret', 'password', 'credential', 'credential_refs', 'api_key', 'private_key']) {
    assert.ok(!(field in record), `registration must not persist ${field}`);
  }
  assert.equal(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/.test(raw), false);
  assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw), false);
  assert.equal(/\bsk-[A-Za-z0-9]{20,}\b/.test(raw), false);
});

test('engineering_pr_autofix_* tools use USER_ID identity and the host-configured root', async () => {
  process.env.USER_ID = 'alice';
  process.env.ENGINEERING_PR_AUTOFIX_ROOT = tmp('pr-autofix-');

  const registered = await callTool('engineering_pr_autofix_register', {
    repo: 'trained-assist/demo',
    features: { fix: true },
    principal: 'attacker',
  });
  assert.equal(registered.profileId, 'alice');
  assert.equal(registered.registration.status, 'registered');

  const status = await callTool('engineering_pr_autofix_status', { repo: 'trained-assist/demo' });
  assert.equal(status.profileId, 'alice');
  assert.equal(status.count, 1);

  const disabled = await callTool('engineering_pr_autofix_disable', { repo: 'trained-assist/demo' });
  assert.equal(disabled.registration.status, 'disabled');

  process.env.USER_ID = 'bob';
  const isolated = await callTool('engineering_pr_autofix_status', {});
  assert.equal(isolated.count, 0);
});

test('engineering_pr_autofix_status without USER_ID fails clearly', async () => {
  delete process.env.USER_ID;
  process.env.ENGINEERING_PR_AUTOFIX_ROOT = tmp('pr-autofix-');
  await assert.rejects(
    () => callTool('engineering_pr_autofix_status', {}),
    (e) => e instanceof PrAutofixError && e.code === 'INVALID_PROFILE',
  );
});
