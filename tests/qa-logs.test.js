'use strict';

// Slice 3 (issue #11): qa_log_* registry round-trip, per-profile isolation,
// entry schema, and the "no raw credentials" guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerLog, lookupLogs, listLogs, QaLogError, registryFile } = require('../src/qa-logs');
const { callTool } = require('../src/mcp-skills/registry');

const cleanup = [];
const savedEnv = {};
for (const key of ['USER_ID', 'ENGINEERING_QA_LOGS_ROOT']) savedEnv[key] = process.env[key];

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

function sampleEntry(overrides = {}) {
  return {
    name: 'autofix worker stderr',
    location: '/var/log/autofix/worker.err',
    ttl: 3600,
    fields: ['level', 'request_id'],
    how_to_read: 'tail -f /var/log/autofix/worker.err',
    owner: 'ci',
    source: 'agent',
    ...overrides,
  };
}

test('qa_log register -> lookup -> list round-trips and validates the schema', () => {
  const root = tmp('qa-logs-');
  const registered = registerLog({ profile: 'alice', root, entry: sampleEntry() });
  assert.equal(registered.profile, 'alice');
  assert.equal(registered.updated, false);
  const log = registered.log;
  for (const field of ['id', 'name', 'location', 'ttl', 'fields', 'how_to_read', 'owner', 'source', 'added_at']) {
    assert.ok(field in log, `missing ${field}`);
  }
  assert.ok(!Number.isNaN(Date.parse(log.added_at)));

  assert.equal(lookupLogs({ profile: 'alice', root, query: 'autofix' }).count, 1);
  assert.equal(lookupLogs({ profile: 'alice', root, query: 'request_id' }).count, 1);
  assert.equal(lookupLogs({ profile: 'alice', root, query: '/var/log/autofix' }).count, 1);
  assert.equal(lookupLogs({ profile: 'alice', root, query: 'no-such-thing' }).count, 0);

  const listed = listLogs({ profile: 'alice', root });
  assert.equal(listed.count, 1);
  assert.equal(listed.logs[0].id, log.id);
});

test('re-registering the same name+location updates instead of duplicating', () => {
  const root = tmp('qa-logs-');
  const first = registerLog({ profile: 'alice', root, entry: sampleEntry() });
  const second = registerLog({ profile: 'alice', root, entry: sampleEntry({ owner: 'platform' }) });
  assert.equal(second.updated, true);
  assert.equal(second.log.id, first.log.id);
  assert.equal(second.log.owner, 'platform');
  assert.equal(listLogs({ profile: 'alice', root }).count, 1);
});

test('qa logs are isolated per profile and per root', () => {
  const root = tmp('qa-logs-');
  registerLog({ profile: 'alice', root, entry: sampleEntry() });
  assert.equal(listLogs({ profile: 'bob', root }).count, 0);
  assert.equal(fs.existsSync(registryFile({ profile: 'alice', root })), true);
  assert.equal(fs.existsSync(registryFile({ profile: 'bob', root })), false);
  const otherRoot = tmp('qa-logs-');
  assert.equal(listLogs({ profile: 'alice', root: otherRoot }).count, 0);
});

test('qa_log_register rejects raw credential material', () => {
  const root = tmp('qa-logs-');
  assert.throws(
    () => registerLog({ profile: 'alice', root, entry: sampleEntry({ how_to_read: `export TOKEN=ghp_${'A'.repeat(30)}` }) }),
    (e) => e instanceof QaLogError && e.code === 'CREDENTIAL_REJECTED',
  );
  assert.throws(
    () => registerLog({ profile: 'alice', root, entry: sampleEntry({ location: 'Authorization: Bearer ' + 'x'.repeat(30) }) }),
    (e) => e instanceof QaLogError && e.code === 'CREDENTIAL_REJECTED',
  );
  assert.equal(listLogs({ profile: 'alice', root }).count, 0);
});

test('qa_log_* tools read identity from USER_ID and the host-configured root', async () => {
  process.env.USER_ID = 'alice';
  process.env.ENGINEERING_QA_LOGS_ROOT = tmp('qa-logs-');

  await callTool('qa_log_register', sampleEntry());
  const found = await callTool('qa_log_lookup', { query: 'worker' });
  assert.equal(found.profile, 'alice');
  assert.equal(found.count, 1);

  const all = await callTool('qa_log_list', {});
  assert.equal(all.count, 1);

  process.env.USER_ID = 'bob';
  const isolated = await callTool('qa_log_list', {});
  assert.equal(isolated.count, 0);
});
