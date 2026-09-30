'use strict';

// Contract tests for src/github/compress-log.js (vendored compressLog from
// pr-autofix@0e36f2e): token budget, error preservation, noise stripping and
// "small logs come back whole". Uses the shared pr-status fixture so the log
// shape matches what pr_status actually compresses.

const test = require('node:test');
const assert = require('node:assert/strict');

const { compressLog, estTokens, LOG_TOKEN_BUDGET, LOG_ERROR_RE } = require('../src/github/compress-log');
const fixture = require('./fixtures/github/pr-status');

const RAW = fixture.JOB_LOG_22;

test('estTokens is a ~4-chars-per-token estimate', () => {
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('abcdefgh'), 2);
  assert.equal(estTokens(''), 0);
});

test('compressLog fits the requested budget and keeps the error', () => {
  const out = compressLog(RAW, 400);
  assert.ok(estTokens(out) <= 400, `~${estTokens(out)} tokens <= 400`);
  assert.ok(out.length < RAW.length / 4, `compressed ${out.length} << raw ${RAW.length}`);
  assert.match(out, /AssertionError/);
  assert.match(out, /FAIL tests\/regression\.test\.js/);
  assert.match(out, /ERROR: Process completed with exit code 1\./);
});

test('compressLog default budget matches the vendored pr-autofix value', () => {
  assert.equal(LOG_TOKEN_BUDGET, 2500);
  const out = compressLog(RAW);
  assert.ok(estTokens(out) <= LOG_TOKEN_BUDGET);
});

test('compressLog strips runner noise: ISO timestamps, ANSI colours, group bodies', () => {
  const noisy = [
    '##[group]Run npm test',
    '\x1b[31minstalling deps\x1b[0m',
    '##[endgroup]',
    '\x1b[31m2026-09-29T04:00:00Z error: boom\x1b[0m',
    '2026-09-29T04:00:01Z INFO  [runner] ok',
    '',
    'Post job cleanup',
  ].join('\n');
  const out = compressLog(noisy, 400);
  assert.ok(!out.includes('\x1b'), 'ANSI stripped');
  assert.ok(!/\d{4}-\d\d-\d\dT[\d:.]+Z/.test(out), 'timestamps stripped');
  assert.ok(!out.includes('installing deps'), 'group body dropped');
  assert.match(out, /▶ Run npm test/, 'step header kept');
  assert.match(out, /error: boom/);
});

test('a log already inside the budget comes back whole (no … placeholder)', () => {
  const out = compressLog('##[group]Run build\nERROR: build failed\n##[endgroup]', 400);
  assert.equal(out, '▶ Run build');
  assert.ok(!out.includes('  …'));
});

test('error regex is the vendored one (spot-check patterns)', () => {
  assert.ok(LOG_ERROR_RE.test('FAIL: something'));
  assert.ok(LOG_ERROR_RE.test('exit code 1'));
  assert.ok(!LOG_ERROR_RE.test('all good'));
});
