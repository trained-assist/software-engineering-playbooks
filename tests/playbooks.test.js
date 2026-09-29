'use strict';

// Engineering playbooks (feature / debugging / new-software / skill-tool): the committed
// Playbook v1 output is in sync with its sources, valid against the vendored
// contract, and keeps the process invariants the playbooks are built on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildAll } = require('../scripts/build-playbooks');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'playbook.schema.json'), 'utf8'));

// Deterministic validators the agent can poll during a durable wait
// (trained-assist-agent src/playbook-validators.js createDefaultRegistry).
const DETERMINISTIC_KEYS = ['ci_green', 'ci_and_staging_green', 'ci_run_green', 'merged', 'pr_merged', 'merged_and_deployed',
  'pr_opened', 'file_exists', 'command_exit_zero', 'credential_present', 'http_ok', 'task_done'];

// The change-flow playbooks run the full sandbox-driven development loop.
// ci-setup / ci-run are short operational playbooks (configure / dispatch) — they
// have no sandbox, no implement and no archive, so the process invariants below
// apply to the change-flow set only. Schema validity, typed steps and the
// declared inputs are checked for EVERY playbook.
const CHANGE_FLOW = new Set(['debugging', 'feature', 'new-software']);
const ALL_PLAYBOOKS = ['ci-run', 'ci-setup', 'debugging', 'feature', 'new-software', 'skill-tool'];

// Minimal JSON-Schema (draft-07 subset used by playbook.schema.json) — no deps in CI.
function validate(value, sch, at = '$', errors = []) {
  if (sch.$ref) return validate(value, sch.$ref.split('/').slice(1).reduce((o, k) => o[k], schema), at, errors);
  const types = sch.type ? [].concat(sch.type) : null;
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types && !types.some(t => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) {
    errors.push(`${at}: type ${typeOf(value)} not in ${types}`);
    return errors;
  }
  if (sch.enum && !sch.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (sch.minLength != null && value.length < sch.minLength) errors.push(`${at}: too short`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) errors.push(`${at}: pattern ${sch.pattern}`);
  }
  if (typeof value === 'number') {
    if (sch.minimum != null && value < sch.minimum) errors.push(`${at}: < ${sch.minimum}`);
    if (sch.maximum != null && value > sch.maximum) errors.push(`${at}: > ${sch.maximum}`);
  }
  if (Array.isArray(value)) {
    if (sch.minItems != null && value.length < sch.minItems) errors.push(`${at}: fewer than ${sch.minItems} items`);
    if (sch.items) value.forEach((v, i) => validate(v, sch.items, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of sch.required || []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    if (sch.minProperties != null && Object.keys(value).length < sch.minProperties) errors.push(`${at}: empty object`);
    for (const [key, v] of Object.entries(value)) {
      if (sch.properties && sch.properties[key]) validate(v, sch.properties[key], `${at}.${key}`, errors);
      else if (sch.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }
  return errors;
}

const { library, built, files } = buildAll();
const steps = pb => pb.stages.flatMap(s => s.steps);
const types = pb => steps(pb).map(s => s.step_type);

test('committed playbooks and docs are in sync with sources (npm run build:playbooks)', () => {
  for (const [file, content] of Object.entries(files)) {
    assert.ok(fs.existsSync(file), `missing build output ${path.relative(ROOT, file)}`);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `stale ${path.relative(ROOT, file)} — run npm run build:playbooks`);
  }
});

test('every expected playbook exists (the three change-flow ones plus ci-setup, ci-run and skill-tool)', () => {
  assert.deepEqual(built.map(b => b.id).sort(), ALL_PLAYBOOKS);
});

for (const pb of built) {
  test(`${pb.id}: valid Playbook v1`, () => {
    assert.deepEqual(validate(pb, schema), []);
  });

  test(`${pb.id}: typed steps with a complete contract`, () => {
    for (const step of steps(pb)) {
      assert.ok(library.types[step.step_type], `${step.title}: step_type from the library`);
      if (step.execution_kind === 'agent') {
        for (const key of ['executor_role', 'minimum_model_level', 'context_budget']) assert.ok(step[key], `${step.title}: ${key}`);
        assert.match(step.instructions, /Чек-лист/, `${step.title}: sub-step checklist rendered`);
      }
      if (step.wait) {
        assert.equal(step.execution_kind, 'programmatic', `${step.title}: wait only on programmatic steps`);
        for (const key of Object.keys(step.validation)) assert.ok(DETERMINISTIC_KEYS.includes(key), `${step.title}: ${key} is pollable`);
      }
      assert.doesNotMatch(step.instructions, /\{(?!repo\}|goal\})\w+\}/, `${step.title}: no unknown {placeholder}`);
    }
  });

  test(`${pb.id}: {repo} in the steps is a declared input (trained-assist-agent#1725)`, () => {
    const repo = (pb.inputs || []).find(i => i.name === 'repo');
    assert.ok(repo, 'repo input declared');
    assert.equal(repo.derive, 'github_repo');
    // feature/debugging/skill-tool always work in an existing repository; new-software may create it.
    assert.equal(repo.required !== false, pb.id !== 'new-software');
  });
}

for (const pb of built.filter(b => CHANGE_FLOW.has(b.id))) {
  test(`${pb.id}: process invariants`, () => {
    const t = types(pb);
    const before = (a, b) => assert.ok(t.indexOf(a) >= 0 && t.indexOf(a) < t.indexOf(b), `${a} before ${b}`);
    // sandbox-driven: the executable loop exists before the code that satisfies it
    before(pb.id === 'debugging' ? 'reproduce' : 'sandbox', 'implement');
    before(t.includes('define-use-case') ? 'define-use-case' : 'bug-context', 'plan-declaration');
    before('plan-declaration', 'implement');
    before('implement', 'open-pr');
    before('open-pr', 'ci-green');
    before('ci-green', 'merged');
    assert.equal(t[t.length - 1], 'archive', 'every playbook ends with archive');
    assert.ok(t.includes('verify-real') || t.includes('confirm-fixed'), 'done only after checking the real environment');
    assert.ok(pb.hooks && pb.hooks.task_done && pb.hooks.task_failed, 'owner is notified on done/failed');
    assert.deepEqual(validate(pb.hooks, schema.$defs.hooks), []);
  });
}

test('debugging: confirms in production by waiting for the error to come back', () => {
  const pb = built.find(b => b.id === 'debugging');
  const confirm = steps(pb).find(s => s.step_type === 'confirm-fixed');
  assert.match(confirm.instructions, /task_item_wait/);
  assert.match(confirm.instructions, /journalctl/);
  assert.ok(types(pb).indexOf('confirm-fixed') > types(pb).indexOf('deployed'));
});

test('new-software: infrastructure discovery precedes the solution choice', () => {
  const t = types(built.find(b => b.id === 'new-software'));
  assert.ok(t.indexOf('infra-discovery') < t.indexOf('solution-options'));
  assert.ok(t.indexOf('solution-options') < t.indexOf('sandbox'));
  assert.ok(t.includes('go-live') && t.includes('repo-bootstrap'));
});

test('library: every type is used or deliberately available, ladders referenced exist', () => {
  for (const [id, type] of Object.entries(library.types)) {
    assert.ok(type.substeps.length > 0, `${id}: has sub-steps`);
    assert.ok(type.done_when, `${id}: has a definition of done`);
    if (type.ladder) assert.ok(library.ladders[type.ladder], `${id}: ladder ${type.ladder} exists`);
    assert.ok(Object.keys(type.validation).length > 0, `${id}: has validation`);
  }
});
