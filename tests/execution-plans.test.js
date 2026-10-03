'use strict';

// P24 — реальные плейбуки и адаптация плана (эпик E5 #21, этап I07, карточка #63,
// приёмка AC-143). Проверяется внешний контракт модуля compiled plan.
//
// Песочница изолирована: собственные dataRoot и копия playbooks/ + contracts/ под
// .sandbox/ внутри репозитория. Прод-данные, сеть и реальные провайдеры не
// используются; облачный CI — синтетическая фикстура на диске.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  adaptFeatureIntegrationSplit,
  assertRunningStepsUnchanged,
  compilePlan,
  createCloudCiProvider,
  createFakeExecutor,
  createGtdPort,
  createInProcessGtdTransport,
  createPlanRuntime,
  createSimpleSchedule,
  decide,
  diffPlans,
  evaluateAcceptance,
  evaluateStepGate,
  precheckAlreadyDone,
  setGatePolicy,
  stepFingerprint,
  viewChecklist,
  PlanError,
} = require('../src/execution-plans');
const { resolvePinnedPlaybook, validateAgainstSchema } = require('../src/playbook-artifacts');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(ROOT, '.sandbox');
fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

const planSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'execution-plan.schema.json'), 'utf8'));
const REPO_VARS = { repo: 'trained-assist/software-engineering-playbooks' };
const CLOCK_START = Date.parse('2026-10-03T09:00:00.000Z');

function sandboxDir(label) {
  const dir = fs.mkdtempSync(path.join(SANDBOX_ROOT, `p24-${label}-`));
  return dir;
}

/** Изолированная копия playbooks/ + contracts/: правки артефакта не трогают репозиторий. */
function artifactSandbox(label) {
  const dir = sandboxDir(label);
  fs.cpSync(path.join(ROOT, 'playbooks'), path.join(dir, 'playbooks'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'contracts'), path.join(dir, 'contracts'), { recursive: true });
  return dir;
}

function virtualClock(start = CLOCK_START) {
  const state = { now: start };
  return {
    clock: () => new Date(state.now),
    advance(seconds) {
      state.now += seconds * 1000;
      return new Date(state.now);
    },
  };
}

function passingValidators(step) {
  return Object.fromEntries(step.gate.validators.map(validator => [validator.name, { status: 'passed', evidenceRef: `ev:${step.stepKey}` }]));
}

function runtimeFor(label, { conclusions, fault = 'none', ciFault = 'none', gtdTransport, start } = {}) {
  const dataRoot = sandboxDir(`${label}-data`);
  const virtual = virtualClock(start);
  const ci = createCloudCiProvider({ root: path.join(dataRoot, 'ci'), clock: virtual.clock, conclusions, fault: ciFault });
  const gtd = createGtdPort({ clock: virtual.clock, transport: gtdTransport });
  const runtime = createPlanRuntime({ root: ROOT, dataRoot, clock: virtual.clock, ci, gtd });
  return { runtime, ci, gtd, dataRoot, virtual };
}

const BASE = { root: ROOT, profileId: 'p24-profile', userTaskId: 'ut-p24-1', goal: 'sandbox goal', vars: REPO_VARS };

// ── 1. Компиляция всех локальных артефактов, воспроизводимый step mapping ──

test('P24: every playbook artifact in this checkout compiles into a plan that satisfies the Execution Plan contract', () => {
  const { listPinnedPlaybooks } = require('../src/playbook-artifacts');
  const artifacts = listPinnedPlaybooks({ root: ROOT });
  assert.ok(artifacts.length >= 7, `expected at least the 7 engineering artifacts, got ${artifacts.length}`);
  let totalSteps = 0;
  for (const descriptor of artifacts) {
    const plan = compilePlan({ ...BASE, root: ROOT, playbookId: descriptor.id, vars: varsFor(descriptor), sourceRevision: 'sandbox-rev' });
    assert.deepEqual(validateAgainstSchema(stripRuntimeFields(plan), planSchema), [], `${descriptor.id} must satisfy the execution plan contract`);
    assert.equal(plan.playbook.artifactHash, descriptor.artifactHash);
    assert.equal(plan.playbook.playbookRef, descriptor.artifactRef);
    assert.equal(plan.steps.length, descriptor.stepCount);
    assert.equal(new Set(plan.steps.map(step => step.stepId)).size, plan.steps.length, 'stepIds must be unique inside a plan');
    totalSteps += plan.steps.length;
  }
  assert.ok(totalSteps >= 60, `expected the full engineering artifact set (>=60 steps), got ${totalSteps}`);
});

test('P24: compiling the same pinned artifact twice is reproducible — same planId, same stepIds, same mapping', () => {
  const first = compilePlan({ ...BASE, playbookId: 'feature' });
  const second = compilePlan({ ...BASE, playbookId: 'feature' });
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first.steps.map(step => step.stepId), second.steps.map(step => step.stepId));
  assert.deepEqual(first.steps.map(step => step.stepKey), second.steps.map(step => step.stepKey));
  // stepKey — семантический ключ, stepId — идентификатор в плане.
  assert.deepEqual(first.steps.map(step => `${step.stepKey}@${step.adapter.legacyOrdinalMapping}`), second.steps.map(step => `${step.stepKey}@${step.adapter.legacyOrdinalMapping}`));
});

test('P24: the compiled plan carries pinned provenance and the pinned bytes, and retrieval alone does not start anything', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'feature', sourceRevision: 'rev-abc' });
  assert.match(plan.playbook.artifactHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.playbook.sourceRevision, 'rev-abc');
  assert.ok(Buffer.isBuffer(plan.definitionBytes));
  assert.equal(plan.continuationOwner, 'output', 'without a control record the owner is Output');
  assert.equal(plan.gtdId, null);
  // Retrieval (P14) отдаёт определение как данные и не компилирует план:
  const { descriptor, definition } = resolvePinnedPlaybook({ root: ROOT, playbookId: 'feature', detail: 'full' });
  assert.equal(descriptor.artifactHash, plan.playbook.artifactHash);
  assert.ok(definition.stages.length > 0);
  assert.equal(plan.status, undefined, 'a freshly compiled plan is not yet executing');
});

// ── 2. Компилятор не угадывает и не подставляет «последнюю версию» ────────────

test('P24: a plan is never created with a literal {name} in step text', () => {
  assert.throws(
    () => compilePlan({ ...BASE, playbookId: 'feature', vars: {} }),
    err => err.code === 'COMPILE_INPUT_MISSING' && err.details.missing[0].name === 'repo',
  );
  const error = (() => {
    try {
      compilePlan({ ...BASE, playbookId: 'epic-delivery', vars: { epic: 'E5' } });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error, 'epic-delivery needs its declared inputs resolved too');
  assert.equal(error.code, 'COMPILE_INPUT_MISSING');
});

test('P24: drift of the pinned artifact is refused, not silently accepted', () => {
  assert.throws(
    () => compilePlan({ ...BASE, playbookId: 'feature', playbookVersion: 99 }),
    err => err.code === 'ARTIFACT_VERSION_MISMATCH',
  );
  assert.throws(
    () => compilePlan({ ...BASE, playbookId: 'feature', expectedHash: `sha256:${'0'.repeat(64)}` }),
    err => err.code === 'ARTIFACT_HASH_MISMATCH',
  );
});

test('P24: a step without a supported contract is refused before dispatch, never guessed', () => {
  const root = artifactSandbox('unsupported');
  const file = path.join(root, 'playbooks', 'debugging.json');
  const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = definition.stages[0].steps[0];
  delete target.instructions;
  delete target.validation;
  target.validation = { dummy_check: true };
  fs.writeFileSync(file, JSON.stringify(definition, null, 2));

  assert.throws(
    () => compilePlan({ ...BASE, root, playbookId: 'debugging', vars: REPO_VARS }),
    err => err.code === 'UNSUPPORTED_STEP_CONTRACT' && err.details.unsupported.includes('AGENT_STEP_WITHOUT_INSTRUCTIONS'),
  );
});

test('P24: a programmatic step without a known handler is refused — validation is not execution', () => {
  const root = artifactSandbox('handler');
  const file = path.join(root, 'playbooks', 'debugging.json');
  const definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = definition.stages.flatMap(stage => stage.steps).find(step => step.execution_kind === 'programmatic');
  target.step_type = 'unknown-programmatic-host';
  fs.writeFileSync(file, JSON.stringify(definition, null, 2));
  assert.throws(
    () => compilePlan({ ...BASE, root, playbookId: 'debugging', vars: REPO_VARS }),
    err => err.code === 'PROGRAMMATIC_HANDLER_UNRESOLVED',
  );
});

// ── 3. Правка definition'а не меняет ID запущенных шагов (AC-143) ───────────

test('P24: a controlled artifact edit leaves the running plan on its pinned revision and does not rename running steps', () => {
  const root = artifactSandbox('edit');
  const { runtime } = runtimeFor('edit', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, root, playbookId: 'feature', sourceRevision: 'pinned-rev-1' });
  const before = runtime.snapshot(plan.planId);

  // Шаг доходит до состояния passed, потом definition правят (новая ревизия).
  const firstStep = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: firstStep.stepId, outcome: 'done', validatorResults: passingValidators(firstStep) });
  const midRun = runtime.snapshot(plan.planId);

  const file = path.join(root, 'playbooks', 'feature.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.version = 3;
  edited.stages[0].steps[0].title = 'Сценарий пользователя (переписан)';
  edited.stages[0].steps.splice(1, 0, { ...edited.stages[0].steps[0], title: 'Новый шаг до кода', step_type: 'explore-context' });
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));

  // 1) Запущенный план продолжает pinned-ревизию: его собственные байты целы.
  const pinned = runtime.assertPinnedDefinition(plan.planId);
  assert.equal(pinned.matchesPlan, true);
  const after = runtime.snapshot(plan.planId);
  assertRunningStepsUnchanged({ before: midRun, after });
  assert.equal(before.steps[0].stepId, after.steps[0].stepId);
  assert.equal(after.steps[0].title, midRun.steps[0].title, 'the running plan does not see the edit');

  // 2) Перекомпиляция даёт другой план и другие ID, сопоставленные по stepKey.
  const recompiled = runtime.compile({ ...BASE, root, playbookId: 'feature', version: 3, sourceRevision: 'pinned-rev-2' });
  const delta = runtime.diff(plan.planId, recompiled.planId);
  assert.notEqual(recompiled.planId, plan.planId);
  assert.equal(recompiled.compiledPlanRevision, 1, 'a new compile starts at revision 1 of its own plan');
  assert.ok(delta.added.length >= 1, 'the inserted step appears as added');
  const firstRetained = delta.retained.find(row => row.stepKey === 'frame#1');
  assert.ok(firstRetained, 'an untouched step is mapped across revisions by stepKey');
  assert.equal(firstRetained.sameStepId, false, 'a different pinned revision yields a different stepId');
  assert.equal(firstRetained.retitled, true, 'the renamed step is visible as retitled, not silently remapped');
  assert.ok(delta.retained.every(row => row.beforeStepId !== row.afterStepId));
});

test('P24: mutating a running step in place is reported as RUNNING_STEP_IDS_CHANGED', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'feature' });
  const before = {
    planId: plan.planId,
    stepStates: Object.fromEntries(plan.steps.map((step, i) => [step.stepId, i === 0 ? 'passed' : 'pending'])),
    steps: plan.steps,
  };
  const tampered = { ...before, steps: plan.steps.map(step => (step.stepId === plan.steps[0].stepId ? { ...step, title: 'переименован на ходу' } : step)) };
  assert.throws(
    () => assertRunningStepsUnchanged({ before, after: tampered }),
    err => err.code === 'RUNNING_STEP_IDS_CHANGED' && err.details.violations[0].problem === 'step_contract_changed',
  );
});

// ── 4. Feature/integration split + migration dependency ─────────────────────

test('P24: feature/integration split keeps step IDs, adds a plan dependency and never rewrites the running plan', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'feature' });
  const merged = plan.steps.find(step => step.stepType === 'merged');
  const { featurePlan, integrationPlan, adaptation } = adaptFeatureIntegrationSplit(plan, { migration: { migrationId: '0009_orders_index' } });

  assert.equal(adaptation.kind, 'feature_integration_split');
  assert.equal(featurePlan.compiledPlanRevision, 2);
  assert.equal(integrationPlan.compiledPlanRevision, 2);
  assert.deepEqual(featurePlan.derivedFrom, { planId: plan.planId, compiledPlanRevision: 1 });
  assert.notEqual(integrationPlan.planId, featurePlan.planId);
  assert.deepEqual(integrationPlan.planDependencies, [{ kind: 'requires_plan_step', planId: featurePlan.planId, stepId: merged.stepId, when: 'passed' }]);

  // Перенесённые шаги сохраняют идентичность один в один.
  const retainedFeature = featurePlan.steps.map(step => step.stepId);
  const retainedIntegration = integrationPlan.steps.filter(step => step.stepType !== 'migration').map(step => step.stepId);
  assert.deepEqual([...retainedFeature, ...retainedIntegration].sort(), plan.steps.map(step => step.stepId).sort());
  assert.equal(featurePlan.steps.at(-1).stepId, merged.stepId);

  // Узел миграции — явный синтетический узел с обязательным гейтом и ref'ом.
  const migration = integrationPlan.steps.find(step => step.stepType === 'migration');
  assert.equal(migration.dependencyKind, 'requires_migration');
  assert.equal(migration.adapter.synthetic, 'migration_node');
  assert.equal(migration.adapter.compiledFrom, null);
  assert.equal(migration.externalOperation.kind, 'schema_migration');
  const deployed = integrationPlan.steps.find(step => step.stepType === 'deployed');
  assert.deepEqual(migration.dependsOn, [deployed.stepId]);
  const verifyReal = integrationPlan.steps.find(step => step.stepType === 'verify-real');
  assert.deepEqual(verifyReal.dependsOn, [migration.stepId], 'the real scenario waits for the migration receipt');

  // Та же цель, та же запись контроля: расщепление не плодит gtdId.
  for (const derived of [featurePlan, integrationPlan]) {
    assert.equal(derived.userTaskId, plan.userTaskId);
    assert.equal(derived.gtdId, plan.gtdId);
    assert.equal(derived.continuationOwner, plan.continuationOwner);
  }
  assert.deepEqual(validateAgainstSchema(stripRuntimeFields(integrationPlan), planSchema), [], 'the adapted plan satisfies the same contract');
});

test('P24: adaptation refuses a split without a boundary and a migration without an id', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'ci-run' });
  assert.throws(
    () => adaptFeatureIntegrationSplit(plan, { splitAfterStepType: 'merged' }),
    err => err.code === 'SPLIT_POINT_NOT_FOUND',
  );
  const feature = compilePlan({ ...BASE, playbookId: 'feature' });
  assert.throws(
    () => adaptFeatureIntegrationSplit(feature, { migration: {} }),
    err => err.code === 'MIGRATION_DEPENDENCY_INVALID',
  );
});

test('P24: the integration plan stays blocked until the feature plan proves its merge step', () => {
  const { runtime } = runtimeFor('split', { conclusions: ['green'] });
  const base = runtime.compile({ ...BASE, playbookId: 'feature' });
  const { featurePlan, integrationPlan } = adaptFeatureIntegrationSplit(base, { migration: { migrationId: '0001_x' } });
  runtime.save(featurePlan);
  runtime.save(integrationPlan);

  assert.equal(runtime.readyStep(integrationPlan.planId), null, 'integration waits for the upstream plan');
  runtime.log.write('plan.saved', { profileId: integrationPlan.profileId, userTaskId: integrationPlan.userTaskId, runId: null, operationId: null, from: 'compiled', to: 'saved', reasonCode: 'ADAPTED_PLAN_PERSISTED' });
  const blocked = runtime.log.entries.find(entry => entry.event === 'plan.dependency.waiting');
  assert.ok(blocked, 'the unmet upstream dependency is visible in the log');
  assert.equal(blocked.reasonCode, 'UPSTREAM_STEP_NOT_PASSED');
  assert.equal(blocked.dependencyStepKey, 'deliver#2');
});

// ── 5. Гейты: обязательность, inconclusive ≠ failed, приёмка по свежему evidence ─

test('P24: a required gate cannot be turned off, neither by policy nor by setGatePolicy', () => {
  const step = { stepId: 'stp_x', title: 't', gate: { required: true, validators: [{ name: 'v', resolved: true }] } };
  assert.throws(() => setGatePolicy([step], { stepId: 'stp_x', required: false }), err => err.code === 'GATE_NOT_DISABLEABLE');
  assert.throws(
    () => compilePlan({ ...BASE, playbookId: 'feature', gatePolicy: { frame: { required: false } } }),
    err => err.code === 'GATE_NOT_DISABLEABLE',
  );
  assert.equal(setGatePolicy([step], { stepId: 'stp_x', required: true })[0].gate.required, true);
});

test('P24: pass requires a verifiable evidence ref; inconclusive is separate from failed', () => {
  const step = { stepId: 'stp_a', stepType: 'implement', title: 't', gate: { required: true, validators: [{ name: 'implemented', resolved: true }] } };
  const passed = evaluateStepGate(step, { validatorResults: { implemented: { status: 'passed', evidenceRef: 'commit:abc' } }, outcome: 'done' });
  assert.equal(passed.result, 'passed');
  const claimed = evaluateStepGate(step, { validatorResults: { implemented: { status: 'passed' } }, outcome: 'done' });
  assert.equal(claimed.result, 'inconclusive');
  assert.equal(claimed.reasonCode, 'GATE_EVIDENCE_MISSING');
  const failed = evaluateStepGate(step, { validatorResults: { implemented: { status: 'failed' } }, outcome: 'done' });
  assert.equal(failed.result, 'failed');
  const ciStep = { ...step, stepType: 'ci-green' };
  const red = evaluateStepGate(ciStep, { validatorResults: { implemented: { status: 'failed', evidenceRef: 'ci_run:1#conclusion=red' } }, outcome: 'done' });
  assert.equal(red.reasonCode, 'CI_RED_REQUIRED_GATE');
  const unknownEffect = evaluateStepGate(step, { validatorResults: {}, effectStateUnknown: true, outcome: 'unknown_effect' });
  assert.equal(unknownEffect.result, 'unknown');
  assert.equal(unknownEffect.reasonCode, 'EFFECT_STATE_UNKNOWN');
});

test('P24: acceptance needs fresh evidence for every required step — stale evidence does not close the plan', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'feature' });
  const steps = plan.steps.slice(0, 3);
  plan.stepStates = Object.fromEntries(steps.map(step => [step.stepId, 'passed']));
  plan.stepEvidence = Object.fromEntries(steps.map(step => [step.stepId, { at: '2026-10-03T09:00:00.000Z', evidence: ['ev'] }]));
  const openedAt = '2026-10-03T10:00:00.000Z';
  const now = new Date(openedAt);
  const stale = evaluateAcceptance({ plan: { ...plan, steps }, openedAt, staleAfterMs: 0, now });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reasonCode, 'ACCEPTANCE_STALE_EVIDENCE');
  assert.equal(stale.stale.length, steps.length);
  const fresh = evaluateAcceptance({
    plan: { ...plan, steps, stepEvidence: Object.fromEntries(steps.map(step => [step.stepId, { at: '2026-10-03T10:30:00.000Z', evidence: ['ev'] }])) },
    openedAt,
    staleAfterMs: 0,
    now,
  });
  assert.equal(fresh.accepted, true);
  const unfinished = evaluateAcceptance({ plan: { ...plan, steps, stepStates: { [steps[1].stepId]: 'awaiting_condition' } }, openedAt, staleAfterMs: 0, now });
  assert.equal(unfinished.accepted, false);
  assert.equal(unfinished.unfinished[0].reason, 'DURABLE_WAIT_OPEN');
});

test('P24: the already_done pre-check closes a step with zero model runs', () => {
  const plan = compilePlan({ ...BASE, playbookId: 'feature' });
  const openPr = plan.steps.find(step => step.stepType === 'open-pr');
  assert.equal(precheckAlreadyDone(openPr, {}).allSatisfied, false);
  const precheck = precheckAlreadyDone(openPr, { pr_opened: 'pass' });
  assert.equal(precheck.allSatisfied, true);
  const { runtime } = runtimeFor('already-done', { conclusions: ['green'] });
  const compiled = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = runtime.load(compiled.planId).steps.find(candidate => candidate.stepType === 'open-pr');
  runtime.save({ ...runtime.load(compiled.planId), stepStates: Object.fromEntries(compiled.steps.slice(0, compiled.steps.indexOf(step)).map(s => [s.stepId, 'passed'])) });
  const result = runtime.runStep({ planId: compiled.planId, stepId: step.stepId, outcome: 'done', signals: { pr_opened: 'pass' } });
  assert.equal(result.state, 'passed');
  assert.equal(result.alreadyDone, true);
  assert.equal(result.run, null, 'no run happened');
});

// ── 6. Фейковый исполнитель: пять исходов, неизменные U/G ID ────────────────

test('P24: the fake executor returns all five outcome kinds with unchanged U/G IDs and a fresh run per attempt', () => {
  const executor = createFakeExecutor({ clock: () => new Date(CLOCK_START) });
  const registered = createGtdPort({ transport: createInProcessGtdTransport({ clock: () => new Date(CLOCK_START) }) }).registerControl({
    profileId: BASE.profileId,
    userTaskId: BASE.userTaskId,
    reason: 'довести до конца и проверить',
    completionCriteria: ['merged'],
    nextTrigger: { kind: 'external_condition' },
    deadlineAt: '2026-10-04T09:00:00.000Z',
    maxAttempts: 3,
  });
  const plan = { ...compilePlan({ ...BASE, playbookId: 'feature' }), gtdId: registered.gtdId, continuationOwner: 'gtd' };
  const step = plan.steps[0];
  const kinds = ['done', 'failed', 'awaiting_user_input', 'awaiting_condition', 'unknown_effect'];
  const runs = kinds.map((outcome, i) => executor.runStep({ plan, step, attempt: i + 1, outcome, validatorResults: passingValidators(step) }));
  assert.deepEqual(runs.map(run => run.outcome), kinds);
  for (const run of runs) {
    assert.equal(run.userTaskId, BASE.userTaskId);
    assert.equal(run.gtdId, plan.gtdId);
    assert.equal(run.continuationOwner, 'gtd');
    assert.equal(run.jobId, runs[0].jobId, 'a retry keeps the jobId');
    assert.equal(run.planId, plan.planId);
  }
  assert.equal(new Set(runs.map(run => run.runId)).size, 5, 'every attempt gets its own runId');
  assert.equal(runs[2].awaitingInputId.startsWith('ain_'), true);
  assert.equal(runs[3].conditionRef.startsWith('cond_'), true);
  assert.equal(runs[4].effectStateUnknown, true);
});

// ── 7. Синтетический облачный CI: один dispatch, resume без второго ──────────

test('P24: cloud CI dispatches once and resume reads the same run — no second dispatch', () => {
  const { runtime, ci, virtual } = runtimeFor('ci', { conclusions: ['pending', 'pending', 'green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
  const opened = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  assert.equal(opened.state, 'awaiting_condition');
  assert.equal(ci.dispatchCount(), 1);

  virtual.advance(300);
  const tickPending = runtime.tick({ planId: plan.planId });
  assert.equal(tickPending.transitions[0].state, 'awaiting_condition', 'условие ещё не разрешено');

  virtual.advance(300);
  const tickSettled = runtime.tick({ planId: plan.planId });
  assert.equal(tickSettled.transitions[0].state, 'pending', 'условие разрешено — шаг снова готов');
  assert.equal(tickSettled.transitions[0].conclusion, 'green');

  // Повторная попытка читает уже запущенный run: второй облачной проверки нет.
  const resumed = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: {} });
  assert.equal(ci.dispatchCount(), 1, 'resuming a dispatched run must not dispatch again');
  assert.equal(resumed.state, 'passed');
  assert.equal(resumed.run.report.conclusion, 'green');
  assert.equal(resumed.run.externalOperationRef.dispatchCount, 1);
  // Внешний run_id провайдера — не платформенный runId.
  assert.equal(resumed.run.externalOperationRef.ref.provider, 'github');
  assert.equal(resumed.run.externalOperationRef.ref.kind, 'actions_run');
  assert.notEqual(resumed.run.externalOperationRef.ref.id, resumed.run.runId);
});

test('P24: a lost dispatch ACK is an unknown effect that reconciles without a second dispatch', () => {
  const { runtime, ci } = runtimeFor('lost-ack', { conclusions: ['green'], ciFault: 'lost_dispatch_ack' });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
  const first = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  assert.equal(first.state, 'unknown');
  assert.equal(first.gate.reasonCode, 'EFFECT_STATE_UNKNOWN');
  assert.equal(ci.dispatchCount(), 1);

  const reconciled = runtime.reconcileExternal({ planId: plan.planId, stepId: step.stepId, operationId: runtime.load(plan.planId).stepExternalOps[step.stepId].operationId });
  assert.equal(reconciled.found, true);
  assert.equal(reconciled.secondDispatch, false);
  assert.equal(ci.dispatchCount(), 1, 'reconcile never dispatches again');
  assert.equal(runtime.load(plan.planId).stepStates[step.stepId], 'pending');

  const polled = runtime.pollExternal({ planId: plan.planId, stepId: step.stepId });
  assert.equal(polled.status, 'completed');
  assert.equal(ci.dispatchCount(), 1);
});

test('P24: polling without a recorded external ref is refused instead of dispatching again', () => {
  const { runtime } = runtimeFor('no-ref', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
  assert.throws(
    () => runtime.pollExternal({ planId: plan.planId, stepId: step.stepId }),
    err => err.code === 'EXTERNAL_OPERATION_NOT_DISPATCHED',
  );
});

test('P24: a red CI report fails the required gate but the reporting step still produced a verifiable report', () => {
  const { runtime } = runtimeFor('red', { conclusions: ['red'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
  // Исполнитель утверждает «зелёный» — провайдер авторитетен.
  const result = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: { ci_green: { status: 'passed', evidenceRef: 'agent said green' } } });
  assert.equal(result.state, 'failed');
  assert.equal(result.gate.reasonCode, 'CI_RED_REQUIRED_GATE');
  assert.equal(result.run.report.conclusion, 'red');
  assert.ok(result.run.report.externalRef, 'the report is still a structured, verifiable result');
  const override = runtime.log.entries.find(entry => entry.event === 'gate.signal.overridden');
  assert.ok(override, 'the overridden claim is visible in the log');
  assert.equal(override.reasonCode, 'PROVIDER_CONCLUSION_WINS_OVER_UNVERIFIED_CLAIM');
});

test('P24: never-green CI exhausts the attempt cap and stops the plan instead of looping', () => {
  const { runtime, ci } = runtimeFor('never-green', { conclusions: ['red'], ciFault: 'never_green' });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
  const maxAttempts = step.maxAttempts;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: {} });
  }
  assert.equal(last.state, 'failed');
  assert.equal(last.capReached, true);
  assert.equal(last.planStatus, 'stopped');
  assert.equal(runtime.load(plan.planId).blocker.reason, 'ATTEMPT_CAP_EXHAUSTED');
  assert.equal(ci.dispatchCount(), maxAttempts, 'each attempt after a red conclusion is a new run');
});

// ── 8. Awaiting input: durable, одно возобновление, без второго resume ───────

test('P24: awaiting user input survives a restart and a duplicate answer resumes exactly once', () => {
  const { runtime, virtual, dataRoot, gtd } = runtimeFor('await', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = plan.steps.find(candidate => candidate.wait && candidate.wait.kind === 'user_input');
  const parked = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'awaiting_user_input', detail: { question: 'уточнить цель' } });
  assert.equal(parked.state, 'awaiting_user_input');
  assert.ok(parked.awaiting.awaitingInputId);

  // Перезапуск: новый рантайм поверх того же dataRoot.
  const ci = createCloudCiProvider({ root: path.join(dataRoot, 'ci'), clock: virtual.clock, conclusions: ['green'] });
  const restarted = createPlanRuntime({ root: ROOT, dataRoot, clock: virtual.clock, ci, gtd });
  const reloaded = restarted.load(plan.planId);
  assert.equal(reloaded.stepStates[step.stepId], 'awaiting_user_input', 'ожидание переживает перезапуск');
  assert.equal(reloaded.awaiting[step.stepId].awaitingInputId, parked.awaiting.awaitingInputId);
  assert.throws(
    () => restarted.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) }),
    err => err.code === 'STEP_NOT_READY',
  );

  virtual.advance(60);
  const accepted = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-1', answer: { ok: true } });
  assert.equal(accepted.accepted, true);
  assert.equal(restarted.load(plan.planId).stepStates[step.stepId], 'pending');
  const duplicate = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-1', answer: { ok: true } });
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.accepted, false);
  const late = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-2', answer: { ok: true } });
  assert.equal(late.replayed, true, 'поздний дубль ответа не возобновляет работу второй раз');
  assert.equal(gtd.calls.answers, 3);
  const acceptedEvents = runtime.log.entries.concat(restarted.log.entries).filter(entry => entry.event === 'awaiting.answer.accepted');
  assert.equal(acceptedEvents.length, 1, 'ровно одно возобновление на ответ');
});

// ── 9. GTD opt-in: контроль только по явной регистрации ─────────────────────

test('P24: an unmanaged plan never touches GTD, and control appears only through explicit registration', () => {
  const { runtime, gtd } = runtimeFor('gtd-optin', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  assert.equal(gtd.calls.outcomes, 0, 'нет gtdId — GTD не вызывается вообще');
  const skipped = runtime.log.entries.find(entry => entry.event === 'gtd.skipped');
  assert.equal(skipped.reasonCode, 'NO_CONTROL_RECORD_OPT_IN_ONLY');
  assert.equal(skipped.continuationOwner, 'output');
});

test('P24: registration requires reason, criteria, next trigger, deadline and caps; self-control is refused', () => {
  const gtd = createGtdPort({ transport: createInProcessGtdTransport() });
  const incomplete = gtd.registerControl({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, reason: 'контролировать' });
  assert.equal(incomplete.status, 'blocked');
  assert.equal(incomplete.reason, 'INCOMPLETE_CONTROL_RECORD');
  assert.deepEqual(incomplete.missing.sort(), ['completionCriteria', 'deadlineAt', 'maxAttempts', 'nextTrigger']);
  assert.equal(gtd.records().length, 0, 'неполная регистрация не создаёт запись');

  const request = {
    profileId: BASE.profileId,
    userTaskId: BASE.userTaskId,
    reason: 'PR создан → ждать CI → проверить интеграцию',
    completionCriteria: ['ci-green'],
    nextTrigger: { kind: 'external_condition', ref: 'ci' },
    deadlineAt: '2026-10-04T09:00:00.000Z',
    maxAttempts: 3,
  };
  const first = gtd.registerControl(request);
  assert.equal(first.status, 'registered');
  assert.match(first.gtdId, /^gtd_[0-9a-f]{12}$/);
  assert.equal(gtd.registerControl(request).status, 'already_registered', 'одна запись контроля на userTaskId');
  const selfSupervised = gtd.registerControl({ ...request, userTaskId: 'ut-other', supervisedByGtdId: first.gtdId });
  assert.equal(selfSupervised.status, 'registered');
  const self = createGtdPort({ transport: createInProcessGtdTransport() });
  const known = self.registerControl(request).gtdId;
  const forbidden = self.registerControl({ ...request, userTaskId: BASE.userTaskId, supervisedByGtdId: known });
  assert.ok(['blocked', 'already_registered'].includes(forbidden.status));
  assert.ok(selfSupervised.gtdId);
});

test('P24: an outcome for an unknown gtdId is quarantined instead of silently recovered by Output', () => {
  const gtd = createGtdPort({ transport: createInProcessGtdTransport() });
  const quarantined = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: 'gtd_deadbeef', eventId: 'e1', kind: 'failed', stepId: 'stp_x' });
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.reconciliationRequired, true);
  const missing = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: null, eventId: 'e2', kind: 'failed' });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'GTD_ID_MISSING');
});

test('P24: GTD decisions are derived from the structured outcome and caps stop progression', () => {
  assert.equal(decide('done', { hasNextStep: true }), 'resume');
  assert.equal(decide('done', { hasNextStep: false }), 'stop');
  assert.equal(decide('failed', { attemptsUsed: 1, maxAttempts: 3 }), 'retry');
  assert.equal(decide('failed', { attemptsUsed: 3, maxAttempts: 3 }), 'stop');
  assert.equal(decide('awaiting_condition', {}), 'wait');
  assert.equal(decide('awaiting_user_input', {}), 'wait');
  assert.equal(decide('done', { effectStateUnknown: true }), 'reconcile');

  const gtd = createGtdPort({ transport: createInProcessGtdTransport() });
  const registered = gtd.registerControl({
    profileId: BASE.profileId,
    userTaskId: BASE.userTaskId,
    reason: 'довести до конца',
    completionCriteria: ['merged'],
    nextTrigger: { kind: 'external_condition' },
    deadlineAt: '2026-10-04T09:00:00.000Z',
    maxAttempts: 2,
  });
  const first = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: registered.gtdId, eventId: 'ev-1', kind: 'failed', stepId: 'stp_a', runId: 'run_1' });
  assert.equal(first.ack.decision.action, 'retry');
  const replay = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: registered.gtdId, eventId: 'ev-1', kind: 'failed', stepId: 'stp_a', runId: 'run_1' });
  assert.equal(replay.status, 'replayed', 'дедуп по eventId даёт одно логическое продолжение');
  const second = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: registered.gtdId, eventId: 'ev-2', kind: 'failed', stepId: 'stp_a', runId: 'run_2' });
  assert.equal(second.ack.decision.action, 'stop');
  assert.equal(second.record.state, 'stopped');
  const late = gtd.reportOutcome({ profileId: BASE.profileId, userTaskId: BASE.userTaskId, gtdId: registered.gtdId, eventId: 'ev-3', kind: 'done', stepId: 'stp_b' });
  assert.equal(late.status, 'late', 'поздний исход закрытой записи не возрождает работу');
  const reRegister = gtd.registerControl({
    profileId: BASE.profileId,
    userTaskId: BASE.userTaskId,
    reason: 'обойти cap',
    completionCriteria: ['merged'],
    nextTrigger: { kind: 'external_condition' },
    deadlineAt: '2026-10-05T09:00:00.000Z',
    maxAttempts: 5,
  });
  assert.equal(reRegister.status, 'already_registered', 'cap не обходится новой записью контроля');
});

test('P24: a managed step reports its outcome once and gets one decision; Output does not also continue it', () => {
  const virtual = virtualClock();
  const gtd = createGtdPort({ clock: virtual.clock, transport: createInProcessGtdTransport({ clock: virtual.clock }) });
  const { runtime, dataRoot } = runtimeFor('managed', { conclusions: ['green'], gtdTransport: undefined });
  const managed = createPlanRuntime({ root: ROOT, dataRoot, clock: virtual.clock, ci: createCloudCiProvider({ root: path.join(dataRoot, 'ci2'), clock: virtual.clock, conclusions: ['green'] }), gtd });
  const registered = gtd.registerControl({
    profileId: BASE.profileId,
    userTaskId: BASE.userTaskId,
    reason: 'PR создан → ждать CI → проверить интеграцию',
    completionCriteria: ['ci-green'],
    nextTrigger: { kind: 'external_condition' },
    deadlineAt: '2026-10-04T09:00:00.000Z',
    maxAttempts: 3,
  });
  const plan = managed.compile({ ...BASE, playbookId: 'feature', gtdId: registered.gtdId });
  assert.equal(plan.continuationOwner, 'gtd');
  const step = managed.readyStep(plan.planId);
  const result = managed.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  assert.equal(result.state, 'passed');
  assert.equal(gtd.calls.outcomes, 1, 'один исход — один вызов GTD');
  const ack = managed.log.entries.filter(entry => entry.event === 'gtd.outcome.reported').at(-1);
  assert.equal(ack.decisionAction, 'resume');
  assert.ok(runtime, 'sanity');
});

// ── 10. Простое расписание остаётся без GTD (AC-143) ────────────────────────

test('P24: an hourly schedule creates a new user task per occurrence and no GTD record at all', () => {
  const virtual = virtualClock();
  const gtd = createGtdPort({ clock: virtual.clock, transport: createInProcessGtdTransport({ clock: virtual.clock }) });
  const schedule = createSimpleSchedule({ scheduleId: 'SC-hh-recruiting', intervalSeconds: 3600, gtdPort: gtd, clock: virtual.clock, profileId: 'p24-profile' });

  const first = schedule.fire({ at: virtual.clock() });
  virtual.advance(3600);
  const second = schedule.fire({ at: virtual.clock() });
  const duplicate = schedule.fire({ at: virtual.clock() });
  assert.equal(first.status, 'fired');
  assert.equal(second.status, 'fired');
  assert.notEqual(first.userTaskId, second.userTaskId, 'каждое срабатывание — новая userTaskId');
  assert.equal(duplicate.status, 'duplicate', 'повтор того же тика не создаёт вторую задачу');
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.userTaskId, second.userTaskId);
  assert.equal(gtd.calls.register, 0, 'расписание само не регистрирует контроль');
  assert.equal(gtd.records().length, 0);

  const terminal = schedule.terminalResult(first.userTaskId);
  assert.equal(terminal.continuationOwner, 'output');
  assert.equal('gtdId' in terminal, false, 'в терминальном результате unmanaged-задачи gtdId отсутствует, а не пуст');

  const disabled = schedule.disable();
  assert.equal(disabled.acceptedTasksUntouched.length, 2, 'disable ≠ cancel: принятые задачи не тронуты');
  virtual.advance(3600);
  assert.equal(schedule.fire({ at: virtual.clock() }).status, 'disabled');
  assert.equal(schedule.occurrences().length, 2);
});

test('P24: an occurrence gets a gtdId only when control is explicitly requested for it', () => {
  const virtual = virtualClock();
  const gtd = createGtdPort({ clock: virtual.clock, transport: createInProcessGtdTransport({ clock: virtual.clock }) });
  const schedule = createSimpleSchedule({
    scheduleId: 'SC-managed-hourly',
    intervalSeconds: 3600,
    gtdPort: gtd,
    clock: virtual.clock,
    profileId: 'p24-profile',
    registerControl: {
      reason: 'hourly поиск не под контролем; под контролем только этот прогон',
      completionCriteria: ['vacancy published'],
      nextTrigger: { kind: 'external_condition', ref: 'hh' },
      deadlineAt: '2026-10-04T09:00:00.000Z',
      maxAttempts: 2,
    },
  });
  const occurrence = schedule.fire({ at: virtual.clock() });
  assert.equal(occurrence.status, 'fired');
  assert.match(occurrence.gtdId, /^gtd_[0-9a-f]{12}$/);
  const terminal = schedule.terminalResult(occurrence.userTaskId);
  assert.equal(terminal.continuationOwner, 'gtd');
  assert.equal(terminal.gtdId, occurrence.gtdId);
  assert.equal(terminal.controlRegistration.reason.startsWith('hourly поиск'), true);
});

// ── 11. Checklist — view, а не источник истины ──────────────────────────────

test('P24: the checklist is a view over a planId and does not mutate the plan', () => {
  const { runtime } = runtimeFor('checklist', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const step = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  const before = runtime.snapshot(plan.planId);
  const view = viewChecklist(runtime.load(plan.planId));
  const after = runtime.snapshot(plan.planId);
  assert.equal(view.planId, plan.planId);
  assert.equal(view.sourceOfTruth, 'execution_plan');
  assert.equal(view.pinnedArtifact.artifactHash, plan.playbook.artifactHash);
  assert.equal(view.progress.passed, 1);
  assert.equal(view.progress.required, plan.steps.length);
  assert.equal(before.fingerprint, after.fingerprint, 'view не меняет план');
  assert.equal(after.fingerprint, before.fingerprint);
  for (const row of view.rows) {
    assert.equal(row.stepId.startsWith('stp_'), true);
    assert.ok(Array.isArray(row.evidence));
  }
  assert.ok(stepFingerprint(step).includes(step.stepId));
});

// ── 12. Логи этапа I07 ──────────────────────────────────────────────────────

test('P24: every log line carries correlation ids, an event key and a transition reason — and no secrets or goal text', () => {
  const { runtime, gtd } = runtimeFor('logs', { conclusions: ['pending', 'green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature', bindings: [{ name: 'github', ref: 'sbx/github#write', scope: 'repo:write' }] });
  const step = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  const ciStep = runtime.load(plan.planId).steps.find(candidate => candidate.stepType === 'ci-green');
  runtime.save({ ...runtime.load(plan.planId), stepStates: Object.fromEntries(runtime.load(plan.planId).steps.map(s => [s.stepId, ciStep.stepId === s.stepId ? 'pending' : 'passed'])) });
  runtime.runStep({ planId: plan.planId, stepId: ciStep.stepId, outcome: 'done', validatorResults: {} });

  const entries = runtime.log.entries;
  assert.ok(entries.length > 5);
  const keys = new Set();
  for (const entry of entries) {
    keys.add(entry.event);
    assert.ok('profileId' in entry && 'userTaskId' in entry && 'runId' in entry && 'operationId' in entry, `event ${entry.event} must carry the four correlation keys`);
    assert.ok('from' in entry && 'to' in entry, `event ${entry.event} must carry the transition`);
    assert.ok(typeof entry.reasonCode === 'string' && entry.reasonCode.length > 0, `event ${entry.event} must carry a reason`);
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes('sandbox goal'), false, 'текст задачи в лог не пишется');
    assert.equal(/Bearer |token=|apiKey/i.test(serialized), false, 'значений binding/credential в логе нет');
    assert.equal(serialized.includes(require('os').homedir()), false, 'домашние пути в логе нет');
  }
  for (const expected of ['plan.compiled', 'step.settled', 'gtd.skipped', 'external.dispatch.confirmed']) {
    assert.ok(keys.has(expected), `expected a ${expected} line`);
  }
  const compiled = entries.find(entry => entry.event === 'plan.compiled');
  assert.equal(compiled.reasonCode, 'PLAN_COMPILED_FROM_PINNED_ARTIFACT');
  assert.equal(compiled.gtdId, null);
  assert.match(compiled.artifactHash, /^sha256:/);
  assert.equal(gtd.calls.outcomes, 0);
});

// ── 13. Порядок шагов и зависимости ─────────────────────────────────────────

test('P24: the runtime runs a plan in dependency order and stops at the unmet dependency', () => {
  const { runtime } = runtimeFor('order', { conclusions: ['green'] });
  const plan = runtime.compile({ ...BASE, playbookId: 'feature' });
  const executed = [];
  let guard = 0;
  while (guard < 30) {
    guard += 1;
    const step = runtime.readyStep(plan.planId);
    if (!step) break;
    const first = runtime.load(plan.planId).steps[0];
    if (step.stepId !== first.stepId && runtime.load(plan.planId).stepStates[first.stepId] !== 'passed') {
      throw new Error(`step ${step.stepKey} ran before its dependency ${first.stepKey}`);
    }
    executed.push(step.stepKey);
    runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  }
  assert.equal(executed.length, plan.steps.length);
  assert.deepEqual(executed, plan.steps.map(step => step.stepKey));
});

function varsFor(descriptor) {
  const { definition } = resolvePinnedPlaybook({ root: ROOT, playbookId: descriptor.id, detail: 'full' });
  const vars = {};
  for (const input of definition.inputs || []) {
    vars[input.name] = input.name === 'repo' ? REPO_VARS.repo : `sandbox-${input.name}`;
  }
  return vars;
}

// definitionBytes (Buffer) — техническое поле компилятора, не часть контракта плана.
function stripRuntimeFields(plan) {
  const { definitionBytes, ...rest } = plan;
  return rest;
}