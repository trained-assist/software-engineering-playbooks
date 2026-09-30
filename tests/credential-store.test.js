'use strict';
// trained-assist-agent#1939 (C4 rollout шаг 1): the GitHub token
// (agent-tokens/<USER_ID>/github) is read through credential-store in both
// tool files that own it (60-github.js, 61-dev.js).
//
// Contract (epic #1789 P0 C4, #1819):
//   - legacy plaintext files pass through transparently (zeroCreds JSON too);
//   - an encrypted (v2 base64 envelope) file is decrypted;
//   - a base64 stub is NEVER returned as the token;
//   - a missing CRED_ENCRYPTION_KEY degrades to plaintext WITH a warning —
//     never a hard failure.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-cred-'));
process.env.AGENT_TOKENS_DIR = root;
process.env.USER_ID = 'eng-user';
delete process.env.GH_TOKEN;      // the file must be the only source here
delete process.env.GITHUB_TOKEN;
delete process.env.CRED_ENCRYPTION_KEY;

const store = require('../src/credential-store');
const github = require('../src/mcp-skills/tools/60-github');
const dev = require('../src/mcp-skills/tools/61-dev');

const MASTER_KEY = 'c'.repeat(64); // valid 64-hex → 32-byte AES-256 key
const tokenFile = path.join(root, 'eng-user', 'github');

function reset(t) {
  const saved = process.env.CRED_ENCRYPTION_KEY;
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();
  t.after(() => {
    if (saved === undefined) delete process.env.CRED_ENCRYPTION_KEY;
    else process.env.CRED_ENCRYPTION_KEY = saved;
    store._resetMasterKey();
  });
}

function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('legacy plaintext token reads through (60-github and 61-dev)', (t) => {
  reset(t);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'ghp_legacy_plain', 'utf8');

  assert.equal(github.getToken(), 'ghp_legacy_plain');
  assert.equal(dev.getToken(), 'ghp_legacy_plain');
  assert.equal(github.hasToken(), true, 'hasToken resolves through tokensRoot too');
  assert.equal(github.isReady(), true);
  assert.equal(dev.isReady(), true);
});

test('zeroCreds JSON {"value": …} still unwraps through the store', (t) => {
  reset(t);
  fs.writeFileSync(tokenFile, JSON.stringify({ value: 'ghp_from_json' }), 'utf8');

  assert.equal(github.getToken(), 'ghp_from_json');
  assert.equal(dev.getToken(), 'ghp_from_json');
});

test('missing CRED_ENCRYPTION_KEY → plaintext write with a warning, never a failure', (t) => {
  reset(t);
  fs.rmSync(tokenFile, { force: true });

  const { warnings } = captureWarn(() => store.writeCredentialFile(tokenFile, 'ghp_plaintext_write'));

  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'ghp_plaintext_write');
  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  assert.equal(github.getToken(), 'ghp_plaintext_write');
});

test('double read: with a key the token is encrypted at rest and still reads back', (t) => {
  reset(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();

  captureWarn(() => store.writeCredentialFile(tokenFile, 'ghp_encrypted'));

  const raw = fs.readFileSync(tokenFile, 'utf8');
  assert.notEqual(raw, 'ghp_encrypted', 'at rest the file must not hold the token');
  assert.ok(store.isEncrypted(raw), 'at rest the file must be a v2 envelope');

  assert.equal(store.readCredentialFile(tokenFile), 'ghp_encrypted');
  assert.equal(github.getToken(), 'ghp_encrypted', '60-github reads it back');
  assert.equal(dev.getToken(), 'ghp_encrypted', '61-dev reads it back');
});

test('a base64 stub is never returned as the token', (t) => {
  reset(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();
  captureWarn(() => store.writeCredentialFile(tokenFile, 'ghp_stub'));

  const blob = fs.readFileSync(tokenFile, 'utf8');
  assert.ok(store.isEncrypted(blob), 'precondition: the file on disk is a base64 stub');

  // Key withdrawn: neither tool may hand the stub to the GitHub API.
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  assert.throws(() => store.readCredentialFile(tokenFile),
    /CRED_ENCRYPTION_KEY/, 'store-level: loud, no base64 garbage');
  const { warnings } = captureWarn(() => {
    assert.throws(() => github.getToken(), /GitHub токен не задан/, '60-github degrades to "no token"');
    assert.throws(() => dev.getToken(), /GitHub токен не подключён/, '61-dev degrades to "no token"');
  });
  assert.ok(warnings.some(w => /cannot read the token file/.test(w)),
    `expected a loud warning, got: ${warnings.join(' | ')}`);
});

test('no token file at all → the "not configured" error, nothing created', (t) => {
  reset(t);
  fs.rmSync(tokenFile, { force: true });

  assert.throws(() => github.getToken(), /GitHub токен не задан/);
  assert.equal(github.hasToken(), false);
  assert.ok(!fs.existsSync(tokenFile), 'reading must not create a token file');
});
