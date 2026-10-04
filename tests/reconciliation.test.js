'use strict';

// Reconciliation receipt (#135): the two facts — "the code is delivered" and "the canonical
// baseline says so" — must be readable, and neither may stand in for the other.
//
// Replayability first: every fixture has an expected outcome, so a rule change that silently
// reclassifies a fixture fails here instead of in somebody else's receipt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validate } = require('../src/reconciliation/receipt');
const { compareSchema, schemaDrift } = require('../scripts/check-reconciliation');

const root = path.join(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures', 'reconciliation');
const receipt = (name) => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
const codesOf = (r) => validate(r).violations.map(v => v.code).sort();

test('code merged and baseline applied in the same PR is an honest receipt', () => {
  const res = validate(receipt('honest-merged-docs-in-pr.json'));
  assert.deepEqual(res.violations, []);
  assert.equal(res.ok, true);
  assert.equal(res.facts.code_delivery, 'merged');
  assert.equal(res.facts.baseline, 'applied');
  assert.equal(res.facts.delta_total, 2);
});

test('code merged while the baseline is still pending is a valid receipt — the whole point of the split', () => {
  const res = validate(receipt('honest-merged-docs-pending.json'));
  assert.deepEqual(res.violations, []);
  assert.equal(res.facts.code_delivery, 'merged');
  assert.equal(res.facts.baseline, 'pending');
  assert.equal(res.facts.missing_requirements, 1);
});

test('a baseline claimed applied without a commit is reported, not accepted', () => {
  assert.ok(codesOf(receipt('dishonest-baseline-without-commit.json')).includes('BASELINE_APPLIED_WITHOUT_COMMIT'));
});

test('a delta applied to a path the baseline never touched is not "applied"', () => {
  assert.ok(codesOf(receipt('dishonest-delta-outside-baseline.json')).includes('DELTA_APPLIED_OUTSIDE_BASELINE'));
});

test('a baseline cannot be applied while an accepted requirement is still missing', () => {
  assert.ok(codesOf(receipt('dishonest-missing-requirement.json')).includes('BASELINE_APPLIED_WITH_MISSING_REQUIREMENTS'));
});

test('a recorded conflict is never reported as applied', () => {
  assert.ok(codesOf(receipt('dishonest-conflict-as-applied.json')).includes('CONFLICT_REPORTED_AS_APPLIED'));
});

test('a behaviour change may not live only in architecture', () => {
  assert.ok(codesOf(receipt('dishonest-behaviour-in-architecture.json')).includes('BEHAVIOUR_CHANGE_ONLY_IN_ARCHITECTURE'));
});

test('a removed rule needs superseded_by or removal_evidence', () => {
  assert.ok(codesOf(receipt('dishonest-removed-without-proof.json')).includes('REMOVED_WITHOUT_PROOF'));
  const proved = receipt('dishonest-removed-without-proof.json');
  proved.delta[1].superseded_by = 'docs/ARCHITECTURE.md#archive';
  assert.ok(!codesOf(proved).includes('REMOVED_WITHOUT_PROOF'));
});

test('a delta without evidence is not proof of anything', () => {
  assert.ok(codesOf(receipt('dishonest-no-evidence.json')).includes('DELTA_WITHOUT_EVIDENCE'));
});

test('deployed cannot be claimed while delivery is unknown', () => {
  assert.ok(codesOf(receipt('dishonest-deployed-unknown.json')).includes('DEPLOYED_WITHOUT_DELIVERY'));
});

test('a deferral that nothing tracks is a deferral dressed as done', () => {
  assert.ok(codesOf(receipt('dishonest-deferred-untracked.json')).includes('DEFERRED_AS_DONE'));
  const tracked = receipt('dishonest-deferred-untracked.json');
  // The followup must name THIS requirement: a followup about something else does not
  // record this deferral, and the receipt must keep saying so.
  tracked.followups = [{ ref: 'issue#47', why: 'archive в отдельном PR: R-135-3' }];
  assert.ok(!codesOf(tracked).includes('DEFERRED_AS_DONE'));
  const unrelated = receipt('dishonest-deferred-untracked.json');
  unrelated.followups = [{ ref: 'issue#47', why: 'archive в отдельном PR' }];
  assert.ok(codesOf(unrelated).includes('DEFERRED_AS_DONE'), 'a followup about another requirement must not clear this deferral');
});

test('sync_kind=in_pr is checked against the delivered commit, not trusted', () => {
  assert.ok(codesOf(receipt('dishonest-docs-not-in-code-pr.json')).includes('BASELINE_NOT_IN_CODE_PR'));
});

test('a receipt without a pinned requirements revision cannot be re-checked later', () => {
  assert.ok(codesOf(receipt('dishonest-unpinned-requirements.json')).includes('RECEIPT_UNPINNED'));
});

test('a replay of one step against a newer requirements revision is reported', () => {
  const current = receipt('honest-merged-docs-in-pr.json');
  const prior = receipt('honest-merged-docs-in-pr.json');
  assert.equal(validate(current, { priorReceipts: [prior] }).ok, true, 'an identical replay of the same revision is fine');

  prior.requirements.revision = '@3';
  assert.ok(validate(current, { priorReceipts: [prior] }).violations.map(v => v.code).includes('REPLAY_CHANGED_REQUIREMENTS'));
});

test('one requirement appears once in the delta', () => {
  const r = receipt('honest-merged-docs-in-pr.json');
  r.delta[1].requirement_id = 'R-135-1';
  assert.ok(codesOf(r).includes('DUPLICATE_REQUIREMENT_IN_DELTA'));
});

test('an unfinished receipt names what is missing instead of throwing', () => {
  const res = validate({ receipt_version: 1, plan: { plan_id: 'p', step_id: 's' } });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some(v => v.code === 'RECEIPT_INCOMPLETE'));
  assert.match(res.summary, /incomplete/);
});

test('the shipped schema and the module agree on every enumerated state', () => {
  const report = compareSchema();
  assert.deepEqual(schemaDrift(report, require('../src/reconciliation/receipt')), []);
  assert.deepEqual(report.required, ['receipt_version', 'plan', 'requirements', 'code_delivery', 'baseline', 'delta']);
});

test('every fixture is classified exactly as the replay table says', () => {
  const expected = {
    'honest-merged-docs-in-pr.json': [],
    'honest-merged-docs-pending.json': [],
    'dishonest-baseline-without-commit.json': ['BASELINE_APPLIED_WITHOUT_COMMIT'],
    'dishonest-delta-outside-baseline.json': ['DELTA_APPLIED_OUTSIDE_BASELINE'],
    'dishonest-missing-requirement.json': ['BASELINE_APPLIED_WITH_MISSING_REQUIREMENTS'],
    'dishonest-conflict-as-applied.json': ['CONFLICT_REPORTED_AS_APPLIED'],
    'dishonest-behaviour-in-architecture.json': ['BEHAVIOUR_CHANGE_ONLY_IN_ARCHITECTURE'],
    'dishonest-removed-without-proof.json': ['REMOVED_WITHOUT_PROOF'],
    'dishonest-no-evidence.json': ['DELTA_WITHOUT_EVIDENCE'],
    // delivery unknown + sync_kind=in_pr is two separate lies: the docs cannot be shown to
    // have ridden a commit that was never recorded, and "deployed" has nothing under it.
    'dishonest-deployed-unknown.json': ['BASELINE_SYNC_UNVERIFIABLE', 'DEPLOYED_WITHOUT_DELIVERY'],
    'dishonest-deferred-untracked.json': ['DEFERRED_AS_DONE'],
    'dishonest-docs-not-in-code-pr.json': ['BASELINE_NOT_IN_CODE_PR'],
    'dishonest-unpinned-requirements.json': ['RECEIPT_UNPINNED'],
  };
  for (const [name, codes] of Object.entries(expected)) {
    assert.deepEqual(codesOf(receipt(name)), [...codes].sort(), name);
  }
  assert.deepEqual(Object.keys(expected).sort(), fs.readdirSync(fixturesDir).sort(), 'a fixture without an expectation is a fixture nobody replays');
});

test('the CLI reports an honest receipt, flags a dishonest one, and --strict only fails on it', () => {
  const script = path.join(root, 'scripts', 'check-reconciliation.js');
  const honest = execFileSync(process.execPath, [script, path.join(fixturesDir, 'honest-merged-docs-in-pr.json'), '--against-schema'], { encoding: 'utf8' });
  assert.match(honest, /verdict: ok/);
  assert.match(honest, /schema and module agree/);

  const dishonest = execFileSync(process.execPath, [script, path.join(fixturesDir, 'dishonest-conflict-as-applied.json')], { encoding: 'utf8' });
  assert.match(dishonest, /NOT HONEST/);
  assert.match(dishonest, /CONFLICT_REPORTED_AS_APPLIED/);

  // Report-first (owner decision 2026-10-03): default never fails; --strict does.
  const defaultExit = execFileSync(process.execPath, [script, path.join(fixturesDir, 'dishonest-conflict-as-applied.json')], { encoding: 'utf8' });
  assert.match(defaultExit, /NOT HONEST/);
  let failed = false;
  try {
    execFileSync(process.execPath, [script, path.join(fixturesDir, 'dishonest-conflict-as-applied.json'), '--strict'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    failed = err.status === 1;
  }
  assert.equal(failed, true, '--strict must exit 1 on a dishonest receipt');
});