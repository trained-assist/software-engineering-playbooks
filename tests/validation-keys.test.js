'use strict';

// The validation-key reachability report must be replayable and trustworthy, not a
// one-shot script: these tests run it on fixtures (deterministic, no sibling checkout)
// and pin both the analysis and the exit codes.
//
// Why the report exists at all: a step's `validation` keys are compiled into the plan's
// acceptance criteria and the agent can only evaluate keys in `createDefaultRegistry()`.
// An unknown key is `inconclusive('no-validator')` — it never blocks. That is how a step
// reported «✅ Шаг готов» with nothing behind it (case 9a6854e4, #106 R1).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-validation-keys.js');
const FIX = path.join(__dirname, 'fixtures', 'validation-keys');
const PLAYBOOKS = path.join(FIX, 'playbooks');
const KEYS = path.join(FIX, 'keys.json');
const AGENT = path.join(FIX, 'agent');

const {
  analyze, loadKeys, extractAgentKeys, diffKeys, formatReport,
} = require('../scripts/check-validation-keys.js');

function run(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '' };
  }
}

test('analyze: separates reachable, unclassified and advisory steps', () => {
  const a = analyze({ playbooksDir: PLAYBOOKS, keysFile: KEYS });
  assert.equal(a.registrySize, 3);
  assert.equal(a.total, 6);
  assert.equal(a.agentSteps, 5); // the programmatic `merged` step is not an agent step
  assert.equal(a.unclassified, 1); // `unreachable` only — advisory is its own bucket
  assert.equal(a.advisory, 1);
  assert.deepStrictEqual(a.unreachableKeys, ['another_semantic', 'semantic_thing']);
  assert.deepStrictEqual(a.unclassifiedTypes, ['unreachable']);
  assert.deepStrictEqual(a.advisoryTypes, ['advisory']);
});

test('analyze: a fixture where every key is reachable reports no gaps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-ok-'));
  fs.copyFileSync(path.join(PLAYBOOKS, 'beta.json'), path.join(dir, 'beta.json'));
  const a = analyze({ playbooksDir: dir, keysFile: KEYS });
  assert.equal(a.unclassified, 0);
  assert.equal(a.advisory, 0);
  assert.deepStrictEqual(a.unreachableKeys, []);
  assert.match(formatReport(a), /every declared key is reachable/);
});

test('default run never fails, even with gaps', () => {
  const r = run(['--playbooks', PLAYBOOKS, '--keys', KEYS]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /REPORT ONLY/);
});

test('--strict fails on UNCLASSIFIED gaps (advisory ones are the intended end-state)', () => {
  const r = run(['--playbooks', PLAYBOOKS, '--keys', KEYS, '--strict']);
  assert.equal(r.code, 1);
});

test('--strict passes when the only gap is explicitly advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-adv-'));
  fs.writeFileSync(path.join(dir, 'only-advisory.json'), JSON.stringify({
    id: 'only-advisory', version: 1, scope: 'system', title: 'x',
    stages: [{ id: 's', title: 's', steps: [{ step_type: 't', execution_kind: 'agent', advisory: true, validation: { semantic: true } }] }],
  }));
  assert.equal(run(['--playbooks', dir, '--keys', KEYS]).code, 0);
  assert.equal(run(['--playbooks', dir, '--keys', KEYS, '--strict']).code, 0);
});

test('--json is machine-readable and stable', () => {
  const r = run(['--playbooks', PLAYBOOKS, '--keys', KEYS, '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.unclassified, 1);
  assert.equal(j.advisory, 1);
  assert.deepStrictEqual(j.unreachableKeys, ['another_semantic', 'semantic_thing']);
  assert.equal(j.steps, undefined, 'the per-step dump stays out of the JSON');
});

test('extractAgentKeys reads the real registry shape; diffKeys reports both directions', () => {
  const agentKeys = extractAgentKeys(AGENT);
  assert.deepStrictEqual([...agentKeys].sort(), ['command_exit_zero', 'file_exists', 'new_agent_key']);
  const drift = diffKeys(loadKeys(KEYS), agentKeys);
  assert.deepStrictEqual(drift.missingInContract, ['new_agent_key']);
  assert.deepStrictEqual(drift.staleInContract, ['pr_opened']);
});

test('--against-agent warns by default and fails only under --strict', () => {
  const warn = run(['--playbooks', PLAYBOOKS, '--keys', KEYS, '--against-agent', AGENT]);
  assert.equal(warn.code, 0);
  assert.match(warn.stdout, /drifted from the agent registry/);
  assert.match(warn.stdout, /new_agent_key/);
  const strict = run(['--playbooks', PLAYBOOKS, '--keys', KEYS, '--against-agent', AGENT, '--strict']);
  assert.equal(strict.code, 1);
});

test('the shipped contract matches the real playbooks without crashing (smoke)', () => {
  // Guards against the report itself drifting from the real repo: this runs on the
  // committed playbooks + contract, whatever their current numbers are.
  const a = analyze({});
  assert.ok(a.registrySize > 0 && a.agentSteps > 0);
  assert.match(formatReport(a), /runtime keys/);
});
