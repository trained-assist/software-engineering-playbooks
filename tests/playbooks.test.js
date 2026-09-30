'use strict';

// Engineering playbooks (feature / debugging / new-software / skill-tool / epic-delivery): the committed
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

// Roles the runtime executor knows. reviewer + doctor is the independent cross-review
// (Codex, fallback OpenCode doctor — a different model family than the Claude builder).
const EXECUTOR_ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];

// The change-flow playbooks run the full sandbox-driven development loop.
// ci-setup / ci-run are short operational playbooks (configure / dispatch) — they
// have no sandbox, no implement and no archive, so the process invariants below
// apply to the change-flow set only. Schema validity, typed steps and the
// declared inputs are checked for EVERY playbook.
const CHANGE_FLOW = new Set(['debugging', 'feature', 'new-software']);
const ALL_PLAYBOOKS = ['ci-run', 'ci-setup', 'debugging', 'epic-delivery', 'feature', 'new-software', 'skill-tool'];

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

test('every expected playbook exists (the three change-flow ones plus ci-setup, ci-run, skill-tool and epic-delivery)', () => {
  assert.deepEqual(built.map(b => b.id).sort(), ALL_PLAYBOOKS);
});

for (const pb of built) {
  test(`${pb.id}: valid Playbook v1`, () => {
    assert.deepEqual(validate(pb, schema), []);
  });

  test(`${pb.id}: typed steps with a complete contract`, () => {
    const declared = new Set((pb.inputs || []).map(i => i.name));
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
      for (const [, name] of step.instructions.matchAll(/\{(\w+)\}/g)) {
        assert.ok(name === 'goal' || declared.has(name), `${step.title}: {${name}} is a declared input`);
      }
      if (step.executor_role != null) assert.ok(EXECUTOR_ROLES.includes(step.executor_role), `${step.title}: known executor_role`);
    }
  });

  test(`${pb.id}: {repo} in the steps is a declared input (trained-assist-agent#1725)`, () => {
    const repo = (pb.inputs || []).find(i => i.name === 'repo');
    // epic-delivery works across repositories: arch_repo + the epic instead of one {repo}.
    if (pb.id === 'epic-delivery') return assert.ok(!repo && !JSON.stringify(pb).includes('{repo}'));
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

test('epic-delivery: meta loop card → child plan → independent review → plan update, then acceptance', () => {
  const pb = built.find(b => b.id === 'epic-delivery');
  assert.deepEqual(types(pb), ['epic-preflight', 'next-card', 'child-plan', 'cross-review', 'architecture-update',
    'loop-or-finish', 'final-acceptance', 'archive']);
  const byType = Object.fromEntries(steps(pb).map(s => [s.step_type, s]));
  // Claude builds, a different model family reviews: reviewer + doctor, and it never edits code.
  assert.equal(byType['cross-review'].executor_role, 'reviewer');
  assert.equal(byType['cross-review'].minimum_model_level, 'doctor');
  assert.match(byType['cross-review'].instructions, /Codex/);
  assert.ok(steps(pb).filter(s => s.executor_role === 'reviewer' && s.minimum_model_level === 'doctor').length === 1,
    'only the cross-review runs as reviewer · doctor');
  // the child does the card's work; the meta plan starts it in the background and sleeps durably
  assert.match(byType['child-plan'].instructions, /playbook_run\(.*activate: true/);
  assert.match(byType['child-plan'].instructions, /task_item_wait\(until: \{task_done:/);
  // there is no repeat construct: the loop is a legal self-edit after the step's own item
  assert.match(byType['loop-or-finish'].instructions, /task_item_add/);
  assert.match(byType['loop-or-finish'].instructions, /id ЭТОГО пункта/);
  assert.ok(byType['architecture-update'].validation.pr_merged, 'plan update is merged, not just proposed');
  const inputs = Object.fromEntries(pb.inputs.map(i => [i.name, i]));
  assert.notEqual(inputs.epic.required, false, 'epic is required');
  for (const name of ['arch_repo', 'plan_doc', 'acceptance_doc', 'max_iterations']) assert.equal(inputs[name].required, false, name);
  assert.ok(pb.when_to_use && pb.requires.tools.includes('task_item_add'));
  assert.ok(pb.hooks.task_done && pb.hooks.task_failed);
});

test('schema: when_to_use / requires are declared (in sync with trained-assist-agent)', () => {
  assert.ok(schema.properties.when_to_use && schema.properties.requires);
  assert.deepEqual(schema.$defs.step.properties.executor_role.enum, [...EXECUTOR_ROLES, null]);
});

test('epic-delivery: loop steps are idempotent across re-runs (markers, adoption, partial insert, verdict binding)', () => {
  const pb = built.find(b => b.id === 'epic-delivery');
  const text = Object.fromEntries(steps(pb).map(s => [s.step_type, s.instructions]));
  // iteration counter: one immutable «Итерация N» comment per iteration, by marker
  assert.match(text['next-card'], /\[epic-iter <meta id>#N card <id>\]/);
  assert.match(text['loop-or-finish'], /\[epic-iter <meta id>#…\]/);
  // child plan: key = iteration + card, marker in the goal, adopt via task_list, check before waiting, 24 h deadline
  const child = text['child-plan'];
  assert.match(child, /Ключ идемпотентности — N \+ карточка/);
  assert.match(child, /goal: <первой строкой маркер \[epic-iter <meta id>#N card <id>\]/);
  assert.match(child, /task_list/);
  assert.ok(child.indexOf('task_get(<task id>)') < child.indexOf('task_item_wait('), 'terminal check precedes the wait');
  assert.match(child, /24 ч/);
  assert.match(child, /блокирующие замечания вердикта/);
  // review bound to iteration + child + merged sha, with the engine named; bounded with a continuation
  assert.match(text['cross-review'], /\[epic-review <meta id>#N child <child task id> sha/);
  assert.match(text['cross-review'], /Ревьюер: <движок\/модель/);
  assert.match(text['cross-review'], /НИКОГДА не ставь accept/);
  assert.match(text['cross-review'], /task_item_add\(after_item_id = id ЭТОГО пункта\)/);
  // plan update only from this iteration's verdict for this child, else the step fails
  assert.match(text['architecture-update'], /\[epic-review <meta id>#N child <тот же child task id>/);
  assert.match(text['architecture-update'], /task_item_exception/);
  assert.match(text['architecture-update'], /\[epic-plan <meta id>#N\]/);
  // loop: detect already-added items of N+1 and add only the missing ones
  assert.match(text['loop-or-finish'], /« — итерация N\+1»/);
  assert.match(text['loop-or-finish'], /ТОЛЬКО недостающие/);
  // final acceptance: section by section with a continuation
  assert.match(text['final-acceptance'], /\[epic-acceptance <meta id> section/);
  assert.match(text['final-acceptance'], /« — продолжение»/);
});
