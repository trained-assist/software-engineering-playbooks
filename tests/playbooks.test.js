'use strict';

// Structural contract for the engineering playbooks (feature / debugging /
// new-software). The authoritative schema lives in trained-assist-agent
// (contracts/playbook.schema.json); this test pins the rules that the agent
// schema cannot see: step types come from the library with a matching contract,
// waits are programmatic, and every probe a step checks is declared by an
// earlier declare-plan step. No dependencies — node:test only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYBOOKS_DIR = path.join(ROOT, 'playbooks');
const LIBRARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'step-library.json'), 'utf8')).step_types;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];
const LEVELS = ['bachelor', 'master', 'doctor'];
const BUDGETS = ['small', 'medium', 'large'];
const STEP_KEYS = new Set(['title', 'step_type', 'instructions', 'execution_kind', 'executor_role',
  'minimum_model_level', 'context_budget', 'validation', 'delay_after_sec', 'wait', 'max_attempts',
  'execution_timeout_seconds', 'on_complete', 'on_fail']);

const EXPECTED = ['debugging', 'feature', 'new-software'];

function load(id) {
  return JSON.parse(fs.readFileSync(path.join(PLAYBOOKS_DIR, `${id}.json`), 'utf8'));
}

function steps(pb) {
  return pb.stages.flatMap(s => s.steps.map(step => ({ stage: s.id, ...step })));
}

test('playbooks/ holds exactly the engineering playbooks (every *.json is loaded as a playbook by the agent)', () => {
  const ids = fs.readdirSync(PLAYBOOKS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(ids, EXPECTED);
});

for (const id of EXPECTED) {
  test(`${id}: top-level contract`, () => {
    const pb = load(id);
    assert.equal(pb.id, id);
    assert.ok(Number.isInteger(pb.version) && pb.version >= 1);
    assert.equal(pb.scope, 'system');
    assert.ok(pb.title && pb.goal_template && pb.user_value_template);
    assert.ok(pb.stages.length >= 1);
    const stageIds = pb.stages.map(s => s.id);
    assert.equal(new Set(stageIds).size, stageIds.length, 'stage ids unique');
    for (const s of stageIds) assert.match(s, ID_RE);
    assert.ok(pb.hooks.task_done.length && pb.hooks.task_failed.length, 'owner is notified on done and on stop');
  });

  test(`${id}: every step is typed from the library and matches its contract`, () => {
    for (const step of steps(load(id))) {
      const where = `${id} / ${step.title}`;
      for (const key of Object.keys(step)) if (key !== 'stage') assert.ok(STEP_KEYS.has(key), `${where}: unknown key ${key}`);
      assert.ok(step.step_type && LIBRARY[step.step_type], `${where}: step_type "${step.step_type}" not in library`);
      const lib = LIBRARY[step.step_type];
      assert.equal(step.execution_kind, lib.execution_kind, `${where}: kind`);
      assert.equal('wait' in step, lib.waits, `${where}: waits`);
      assert.ok(step.validation && Object.keys(step.validation).length, `${where}: validation`);
      if (step.execution_kind === 'agent') {
        assert.equal(step.executor_role, lib.executor_role, `${where}: role`);
        assert.ok(ROLES.includes(step.executor_role));
        assert.ok(LEVELS.includes(step.minimum_model_level), `${where}: level`);
        assert.ok(BUDGETS.includes(step.context_budget), `${where}: budget`);
        assert.ok(step.instructions && step.instructions.length > 80, `${where}: agent step needs real instructions`);
        assert.ok(!step.execution_timeout_seconds || step.execution_timeout_seconds <= 2400, `${where}: 40-min cap`);
      }
      if (step.wait) {
        assert.equal(step.execution_kind, 'programmatic', `${where}: only programmatic steps can wait`);
        assert.ok(step.wait.poll_sec >= 300, `${where}: poll below the 5-min executor tick is meaningless`);
        assert.ok(step.wait.timeout_sec > step.wait.poll_sec, `${where}: timeout > poll`);
      }
    }
  });

  test(`${id}: every probe a step checks is declared earlier by declare-plan / reproduce`, () => {
    const declared = new Set();
    for (const step of steps(load(id))) {
      const v = step.validation;
      if (Array.isArray(v.probes_declared)) v.probes_declared.forEach(p => declared.add(p));
      // reproduce declares error_captured in its instructions
      if (step.step_type === 'reproduce') declared.add('error_captured');
      if (typeof v.probe === 'string') {
        assert.ok(declared.has(v.probe), `${id} / ${step.title}: probe "${v.probe}" checked before it is declared`);
      }
    }
  });

  test(`${id}: delivery goes PR → CI → merge → deploy → live check → archive`, () => {
    const types = steps(load(id)).map(s => s.step_type);
    const order = ['open-pr', 'wait-ci', 'wait-merge', 'wait-deploy', 'verify-live', 'archive'];
    const idx = order.map(t => types.indexOf(t));
    assert.ok(idx.every(i => i >= 0), `${id}: missing delivery step`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, `${id}: delivery out of order`);
    assert.equal(types[types.length - 1], 'archive');
  });
}

test('sandbox-first: code is written only after the feedback loop exists', () => {
  for (const id of ['feature', 'new-software']) {
    const types = steps(load(id)).map(s => s.step_type);
    assert.ok(types.indexOf('sandbox') >= 0 && types.indexOf('sandbox') < types.indexOf('implement'), `${id}: sandbox before implement`);
  }
  const dbg = steps(load('debugging')).map(s => s.step_type);
  assert.ok(dbg.indexOf('reproduce') < dbg.indexOf('implement'), 'debugging: reproduce before fix');
});

test('library has no unused step types', () => {
  const used = new Set(EXPECTED.flatMap(id => steps(load(id)).map(s => s.step_type)));
  for (const t of Object.keys(LIBRARY)) assert.ok(used.has(t), `library type ${t} unused`);
});
