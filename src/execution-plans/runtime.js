'use strict';

// Рантайм compiled plan: состояние шагов, durable ожидания, внешние операции,
// отчётность GTD и приёмка (P24, этап I07).
//
// Это НЕ GTD Manager и не планировщик control plane. Ровно та же форма
// managed-шага, что в P23 (control-plane PR #22): prepare → execute →
// report-outcome → park. Прогрессию плана ведёт GTD, когда задача зарегистрирована
// на контроль; без регистрации владелец продолжения — Output, и GTD не вызывается
// вообще (это проверяется счётчиками порта, а не на словах).
//
// Состояние живёт на диске под изолированным dataRoot, поэтому:
//   * перезапуск не теряет parked-ожидания (SANDBOX I07: «Awaiting user input
//     переживает restart»);
//   * «активный план продолжает pinned revision» проверяется пересчётом sha256
//     сохранённой копии definition'а, а не памятью;
//   * ровно одно возобновление на ответ пользователя и один dispatch на шаг.
//
// Логи: тот же JSONL-формат, что в P14 (createEventLog из
// src/playbook-artifacts/events.js) — второй формат логов не заводим.

const fs = require('fs');
const path = require('path');

const { createEventLog } = require('../playbook-artifacts/events');
const { PlanError } = require('./errors');
const { createFakeExecutor } = require('./executor');
const { createGtdPort } = require('./gtd-port');
const { compilePlan, hashBytes } = require('./compiler');
const { evaluateAcceptance, evaluateStepGate, precheckAlreadyDone } = require('./gates');
const { assertRunningStepsUnchanged, diffPlans, findStep, stepFingerprint } = require('./step-identity');

const PLANS_DIR = 'plans';
const DEFINITION_FILE = 'definition.json';
const PLAN_FILE = 'plan.json';
const LOG_FILE = 'events.jsonl';

const STEP_TERMINAL = new Set(['passed']);
const STEP_WAITING = new Set(['awaiting_user_input', 'awaiting_condition']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param {object} options
 * @param {string} options.root      корень checkout'а с playbooks/ и contracts/
 * @param {string} options.dataRoot  изолированное хранилище песочницы (обязателен)
 * @param {() => Date} [options.clock] виртуальные часы
 * @param {object} [options.ci]       синтетический cloud CI provider
 * @param {object} [options.gtd]      порт GTD Manager (P23) или null
 * @param {object} [options.executor] фейковый исполнитель шагов
 */
function createPlanRuntime({ root, dataRoot, clock = () => new Date(), ci = null, gtd = null, executor = null, logFile } = {}) {
  if (!dataRoot) throw new Error('plan runtime requires an isolated dataRoot (never a production data root)');
  const store = path.join(dataRoot, PLANS_DIR);
  const log = createEventLog({ file: logFile || path.join(dataRoot, LOG_FILE), now: clock });
  const exec = executor || createFakeExecutor({ clock });
  const gtdPort = gtd === null ? createGtdPort({ clock }) : gtd;
  const plans = new Map();

  function planFile(planId) {
    return path.join(store, planId, PLAN_FILE);
  }
  function definitionFile(planId) {
    return path.join(store, planId, DEFINITION_FILE);
  }

  function save(plan) {
    // definitionBytes — Buffer: в JSON плана он не нужен, пин проверяется по
    // сохранённой копии файла и по definitionBytesHash.
    const { definitionBytes, ...persistable } = plan;
    writeJson(planFile(plan.planId), persistable);
    plans.set(plan.planId, plan);
    return plan;
  }

  function load(planId) {
    if (plans.has(planId)) return plans.get(planId);
    const plan = readJson(planFile(planId));
    if (!plan) throw new PlanError('PLAN_NOT_COMPILED', `no compiled plan ${planId} in ${PLANS_DIR}/`, { planId });
    plans.set(planId, plan);
    return plan;
  }

  /** Пин определения проверяется по сохранённым байтам, а не по памяти. */
  function assertPinnedDefinition(planId) {
    const plan = load(planId);
    const bytes = fs.existsSync(definitionFile(planId)) ? fs.readFileSync(definitionFile(planId)) : null;
    if (!bytes) {
      log.write('plan.pin.missing', { planId, profileId: plan.profileId, userTaskId: plan.userTaskId, runId: null, operationId: null, from: 'pinned', to: 'failed', reasonCode: 'PLAN_DEFINITION_MISSING' });
      throw new PlanError('PLAN_DEFINITION_CHANGED', `plan ${planId} has no stored pinned definition`, { planId });
    }
    const hash = hashBytes(bytes);
    if (hash !== plan.definitionBytesHash) {
      log.write('plan.pin.mismatch', { planId, profileId: plan.profileId, userTaskId: plan.userTaskId, runId: null, operationId: null, expectedHash: plan.definitionBytesHash, actualHash: hash, from: 'pinned', to: 'failed', reasonCode: 'PLAN_DEFINITION_CHANGED' });
      throw new PlanError('PLAN_DEFINITION_CHANGED', `stored pinned definition of ${planId} hashes ${hash}, plan says ${plan.definitionBytesHash}`, { planId, expectedHash: plan.definitionBytesHash, actualHash: hash });
    }
    return { planId, pinnedHash: hash, matchesPlan: true };
  }

  function correlationFor(plan, extra = {}) {
    return { profileId: plan.profileId, userTaskId: plan.userTaskId, runId: null, operationId: null, planId: plan.planId, ...extra };
  }

  /** Компиляция + запись на диск. Ни шаг, ни агент, ни GTD при этом не трогаются. */
  function compile(options) {
    const plan = compilePlan({ ...options, clock });
    plan.status = 'compiled';
    plan.stepAttempts = {};
    plan.stepEvidence = {};
    plan.stepExternalOps = {};
    plan.awaiting = {};
    plan.conditions = {};
    plan.planDependencies = plan.planDependencies || [];
    plan.openedAt = clock().toISOString();
    save(plan);
    // Копия pinned-definition'а пишется как есть (bytes → bytes), иначе проверка
    // «активный план продолжает pinned revision» сравнивала бы JSON с JSON.
    fs.mkdirSync(path.dirname(definitionFile(plan.planId)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(definitionFile(plan.planId), plan.definitionBytes, { mode: 0o600 });
    assertPinnedDefinition(plan.planId);
    log.write('plan.compiled', {
      ...correlationFor(plan, { operationId: plan.playbook.compiledOperationId }),
      playbookRef: plan.playbook.playbookRef,
      playbookVersion: plan.playbook.playbookVersion,
      artifactHash: plan.playbook.artifactHash,
      compiledPlanRevision: plan.compiledPlanRevision,
      stepCount: plan.steps.length,
      gtdId: plan.gtdId,
      continuationOwner: plan.continuationOwner,
      from: 'definition',
      to: 'compiled',
      reasonCode: 'PLAN_COMPILED_FROM_PINNED_ARTIFACT',
    });
    return plan;
  }

  /** Первы�� шаг, который можно запустить: нет unmet-зависимостей внутри плана. */
  function readyStep(planId) {
    const plan = load(planId);
    if (plan.status === 'stopped' || plan.status === 'completed' || plan.status === 'cancelled') return null;
    for (const dependency of plan.planDependencies || []) {
      if (dependency.kind === 'requires_plan_step') {
        const upstream = readJson(planFile(dependency.planId));
        if (!upstream) {
          log.write('plan.dependency.missing', { ...correlationFor(plan), dependencyPlanId: dependency.planId, from: 'waiting_dependency', to: 'blocked', reasonCode: 'PLAN_NOT_COMPILED' });
          return null;
        }
        if (upstream.stepStates[dependency.stepId] !== 'passed') {
          log.write('plan.dependency.waiting', {
            ...correlationFor(plan),
            dependencyPlanId: dependency.planId,
            dependencyStepId: dependency.stepId,
            dependencyStepKey: (upstream.steps || []).find(step => step.stepId === dependency.stepId)?.stepKey || null,
            upstreamState: upstream.stepStates[dependency.stepId],
            from: 'waiting_dependency',
            to: 'waiting_dependency',
            reasonCode: 'UPSTREAM_STEP_NOT_PASSED',
          });
          return null;
        }
      }
    }
    const done = new Set(Object.entries(plan.stepStates).filter(([, state]) => state === 'passed').map(([stepId]) => stepId));
    return (
      plan.steps.find(step => {
        if (STEP_TERMINAL.has(plan.stepStates[step.stepId])) return false;
        if (plan.stepStates[step.stepId] === 'running') return false;
        return step.dependsOn.every(dependency => done.has(dependency));
      }) || null
    );
  }

  function dispatchExternal(plan, step, runOperationId) {
    if (!step.externalOperation || step.externalOperation.kind !== 'actions_run' || !ci) return { skipped: true, reason: 'NO_EXTERNAL_PROVIDER' };
    const attempt = plan.stepAttempts[step.stepId] || 0;
    const dispatched = ci.dispatch({ operationId: runOperationId, planId: plan.planId, stepId: step.stepId, branch: `plan/${plan.planId.slice(5, 13)}` });
    log.write(dispatched.status === 'unknown' ? 'external.dispatch.unknown' : dispatched.status === 'replayed' ? 'external.dispatch.replayed' : 'external.dispatch.confirmed', {
      ...correlationFor(plan, { operationId: runOperationId, runId: null }),
      stepId: step.stepId,
      stepKey: step.stepKey,
      externalRef: dispatched.run ? dispatched.run.externalRef.id : null,
      externalProvider: 'github',
      externalKind: 'actions_run',
      dispatchCount: dispatched.dispatchCount,
      attempt,
      from: 'pending',
      to: dispatched.status === 'unknown' ? 'unknown' : 'dispatched',
      reasonCode: dispatched.status === 'unknown' ? 'DISPATCH_ACK_LOST' : dispatched.status === 'replayed' ? 'DISPATCH_ALREADY_EXISTS' : 'DISPATCH_CONFIRMED',
    });
    return dispatched;
  }

  /** Reconcile по operationId после потерянного ACK: найти уже созданный run. */
  function reconcileExternal({ planId, stepId, operationId }) {
    const plan = load(planId);
    if (!ci) throw new PlanError('EXTERNAL_OPERATION_NOT_DISPATCHED', 'no cloud CI provider is configured for this runtime');
    const found = ci.reconcile({ operationId });
    if (!found.found) {
      log.write('external.reconcile.missing', { ...correlationFor(plan, { operationId }), stepId, from: 'unknown', to: 'unknown', reasonCode: 'EXTERNAL_RUN_NOT_FOUND' });
      return found;
    }
    // Найденный run_id — внешний идентификатор; платформенный runId не подменяется им.
    plan.stepExternalOps[stepId] = {
      operationId,
      externalRef: found.run.externalRef,
      dispatchCount: ci.dispatchCount(),
      reconciledAt: clock().toISOString(),
      conclusion: found.run.conclusion,
    };
    if (plan.stepStates[stepId] === 'unknown') plan.stepStates[stepId] = 'pending';
    save(plan);
    log.write('external.reconcile.found', {
      ...correlationFor(plan, { operationId }),
      stepId,
      externalRef: found.run.externalRef.id,
      dispatchCount: ci.dispatchCount(),
      from: 'unknown',
      to: 'pending',
      reasonCode: 'RECONCILED_EXTERNAL_RUN_NO_SECOND_DISPATCH',
    });
    return { ...found, secondDispatch: false, dispatchCount: ci.dispatchCount() };
  }

  /** Опрос внешнего run'а: poll, а не повторный dispatch. */
  function pollExternal({ planId, stepId }) {
    const plan = load(planId);
    const record = plan.stepExternalOps[stepId];
    if (!record || !record.externalRef) {
      throw new PlanError('EXTERNAL_OPERATION_NOT_DISPATCHED', `step ${stepId} has no recorded external operation ref; dispatching again would create a second run`, { planId, stepId });
    }
    const polled = ci.poll({ externalRef: record.externalRef, stepId });
    log.write('external.poll', {
      ...correlationFor(plan, { operationId: record.operationId }),
      stepId,
      externalRef: record.externalRef.id,
      status: polled.status,
      conclusion: polled.conclusion || null,
      dispatchCount: ci.dispatchCount(),
      from: 'awaiting_condition',
      to: polled.status === 'pending' ? 'awaiting_condition' : 'condition_settled',
      reasonCode: polled.status === 'pending' ? 'EXTERNAL_RUN_PENDING' : `EXTERNAL_RUN_${String(polled.conclusion || 'completed').toUpperCase()}`,
    });
    return polled;
  }

  /**
   * Одна попытка шага. Сквозной порядок: pre-check already_done → внешний
   * dispatch → исполнитель → гейт → состояние шага → отчёт GTD (если gtdId есть).
   */
  function runStep({ planId, stepId, outcome, validatorResults, report = null, detail = null, signals = {} }) {
    const plan = load(planId);
    const step = findStep(plan, stepId);
    if (STEP_TERMINAL.has(plan.stepStates[stepId])) {
      throw new PlanError('STEP_ALREADY_TERMINAL', `step ${stepId} of ${planId} already passed`, { planId, stepId });
    }
    if (STEP_WAITING.has(plan.stepStates[stepId]) && outcome !== 'awaiting_user_input' && outcome !== 'awaiting_condition') {
      // Ожидание снимается только событием (tick/answer), а не новой попыткой.
      log.write('step.refused', { ...correlationFor(plan), stepId, stepKey: step.stepKey, from: plan.stepStates[stepId], to: 'refused', reasonCode: 'DURABLE_WAIT_OPEN' });
      throw new PlanError('STEP_NOT_READY', `step ${stepId} is parked in ${plan.stepStates[stepId]}; resume it through the event, not with a new attempt`, { planId, stepId, state: plan.stepStates[stepId] });
    }

    // already_done: все проверки прошли → шаг закрыт без единого модельного рана.
    const precheck = precheckAlreadyDone(step, signals);
    if (precheck.applicable && precheck.allSatisfied) {
      plan.stepStates[stepId] = 'passed';
      plan.stepEvidence[stepId] = { at: clock().toISOString(), evidence: [`already_done:${precheck.unmet.length === 0 ? 'all' : ''}`], reasonCode: 'ALREADY_DONE_PRECHECK_NO_MODEL_RUN' };
      save(plan);
      log.write('step.already_done', { ...correlationFor(plan), stepId, stepKey: step.stepKey, from: 'pending', to: 'passed', reasonCode: 'ALREADY_DONE_PRECHECK_NO_MODEL_RUN', modelRuns: 0 });
      return { stepId, stepKey: step.stepKey, state: 'passed', gate: { result: 'passed', satisfied: true, reasonCode: 'ALREADY_DONE' }, run: null, alreadyDone: true };
    }

    const attempt = (plan.stepAttempts[stepId] || 0) + 1;
    plan.stepAttempts[stepId] = attempt;
    plan.status = plan.status === 'compiled' ? 'active' : plan.status;

    let effectiveOutcome = outcome;
    let effectiveValidators = { ...(validatorResults || {}) };
    let effectiveReport = report;
    let externalDispatch = { skipped: true, reason: 'NO_EXTERNAL_OPERATION' };
    let effectiveExternalRef = null;
    const recordedExternal = plan.stepExternalOps[stepId] && plan.stepExternalOps[stepId].externalRef ? plan.stepExternalOps[stepId].externalRef : null;
    // Незавершённый run переиспользуется (resume без второго dispatch); завершённый
    // зелёный — тоже (перечитать его результат можно, запускать заново незачем);
    // завершённый красный — это уже прошлый прогон: работу переделывают, значит
    // нужен новый run, а не второй poll того же.
    const recordedPending = recordedExternal && !plan.stepExternalOps[stepId].conclusion;
    const recordedRed = recordedExternal && plan.stepExternalOps[stepId].conclusion === 'red';
    const externalRunIndex = plan.stepExternalRuns && plan.stepExternalRuns[stepId] ? plan.stepExternalRuns[stepId] : 0;
    const externalOperationId = step.externalOperation ? `${plan.planId}:${step.stepId}#run${recordedPending || !recordedExternal ? externalRunIndex : externalRunIndex + 1}` : null;

    if (step.externalOperation && step.externalOperation.kind === 'actions_run' && !STEP_WAITING.has(effectiveOutcome)) {
      if (recordedPending || (recordedExternal && !recordedRed)) {
        // Повторная попытка того же шага ЧИТАЕТ уже запущенный run. Второй
        // dispatch здесь означал бы две облачные проверки одной ветки.
        externalDispatch = { status: 'replayed', dispatchCount: ci ? ci.dispatchCount() : 0, run: { externalRef: recordedExternal } };
        effectiveExternalRef = recordedExternal;
        log.write('external.dispatch.skipped', { ...correlationFor(plan, { operationId: plan.stepExternalOps[stepId].operationId }), stepId, externalRef: recordedExternal.id, dispatchCount: externalDispatch.dispatchCount, from: 'pending', to: 'reused', reasonCode: 'EXTERNAL_RUN_ALREADY_DISPATCHED' });
      } else {
        externalDispatch = dispatchExternal(plan, step, externalOperationId);
        if (externalDispatch.status === 'unknown') {
          // Эффект мог произойти: результат шага — unknown, а не «повторить».
          effectiveOutcome = 'unknown_effect';
          plan.stepExternalOps[stepId] = { operationId: externalOperationId, externalRef: externalDispatch.run.externalRef, dispatchCount: externalDispatch.dispatchCount, dispatchedAt: clock().toISOString(), conclusion: null };
        } else if (externalDispatch.status !== 'skipped') {
          plan.stepExternalRuns = { ...(plan.stepExternalRuns || {}), [stepId]: externalRunIndex + 1 };
          plan.stepExternalOps[stepId] = { operationId: externalOperationId, externalRef: externalDispatch.run.externalRef, dispatchCount: externalDispatch.dispatchCount, dispatchedAt: clock().toISOString(), conclusion: null };
          effectiveExternalRef = externalDispatch.run.externalRef;
        }
      }
    }

    // CI-вывод подставляется в валидатор гейта, если исполнитель его не принёс:
    // «красный CI» — структурный отчёт, а required gate при этом не пройден.
    if (step.stepType === 'ci-green' && ci && effectiveExternalRef) {
      const polled = ci.poll({ externalRef: effectiveExternalRef, stepId });
      log.write('external.poll', {
        ...correlationFor(plan, { operationId: plan.stepExternalOps[stepId] ? plan.stepExternalOps[stepId].operationId : null }),
        stepId,
        externalRef: effectiveExternalRef.id,
        status: polled.status,
        conclusion: polled.conclusion || null,
        dispatchCount: ci.dispatchCount(),
        from: 'running',
        to: polled.status === 'pending' ? 'awaiting_condition' : 'condition_settled',
        reasonCode: polled.status === 'pending' ? 'EXTERNAL_RUN_PENDING' : `EXTERNAL_RUN_${String(polled.conclusion || 'completed').toUpperCase()}`,
      });
      // Провайдер авторитетен: «инструмент сказал ок» не перебивает проверяемый
      // conclusion внешнего run'а (PR-16 в терминах гейта).
      const claimedByExecutor = effectiveValidators.ci_green ? effectiveValidators.ci_green.status : null;
      if (claimedByExecutor && ((polled.status === 'completed' && claimedByExecutor === 'passed' && polled.conclusion !== 'green') || (claimedByExecutor === 'passed' && polled.status === 'pending'))) {
        log.write('gate.signal.overridden', { ...correlationFor(plan, { operationId: plan.stepExternalOps[stepId].operationId }), stepId, claimedStatus: claimedByExecutor, providerStatus: polled.status, providerConclusion: polled.conclusion || null, from: 'executor_claim', to: 'provider', reasonCode: 'PROVIDER_CONCLUSION_WINS_OVER_UNVERIFIED_CLAIM' });
      }
      if (polled.status === 'pending') {
        effectiveOutcome = 'awaiting_condition';
        // Условие не разрешено — сигнал валидатора, принесённый заранее, недействителен.
        delete effectiveValidators.ci_green;
        plan.stepExternalOps[stepId] = { ...plan.stepExternalOps[stepId], conclusion: null };
        plan.conditions[stepId] = { conditionRef: null, externalRef: effectiveExternalRef, openedAt: clock().toISOString(), conclusion: null };
      } else {
        effectiveValidators.ci_green = {
          status: polled.conclusion === 'green' ? 'passed' : 'failed',
          evidenceRef: `ci_run:${polled.run.externalRef.id}#conclusion=${polled.conclusion}`,
        };
        effectiveReport = { ...(effectiveReport || {}), conclusion: polled.conclusion, externalRef: polled.run.externalRef };
        // Прогон завершён: следующая попытка шага — это новый run, а не второй
        // poll того же. Иначе «красный → починил → снова зелёный» невозможно.
        plan.stepExternalOps[stepId] = { ...plan.stepExternalOps[stepId], conclusion: polled.conclusion };
      }
    }

    const run = exec.runStep({ plan, step, attempt, outcome: effectiveOutcome, validatorResults: effectiveValidators, report: effectiveReport, detail });
    if (externalDispatch.status !== 'skipped' && externalDispatch.run) {
      run.externalOperationRef = { ...run.externalOperationRef, ref: externalDispatch.run.externalRef, dispatchCount: externalDispatch.dispatchCount };
    }
    if (effectiveOutcome === 'awaiting_condition' && run.conditionRef && plan.stepExternalOps[stepId]) {
      plan.conditions[stepId] = { conditionRef: run.conditionRef, externalRef: plan.stepExternalOps[stepId].externalRef, openedAt: clock().toISOString(), conclusion: null };
    }
    if (effectiveOutcome === 'awaiting_user_input') {
      // Живой процесс паркуется: движка нет, токены не жгутся, ожидание durable.
      plan.awaiting[stepId] = { awaitingInputId: run.awaitingInputId, openedAt: run.at, question: detail || null, answeredAt: null, answerEventId: null, resumedRunId: null };
    }

    const gate = STEP_WAITING.has(effectiveOutcome) || effectiveOutcome === 'unknown_effect'
      ? // Явное ожидание или неизвестный внешний эффект сильнее любых принесённых
        // сигналов: шаг не «прошёл», он ждёт события.
        { result: 'not_evaluated', satisfied: false, reasonCode: run.transition.reasonCode, evidence: [], missingValidators: step.gate.validators.map(v => v.name) }
      : evaluateStepGate(step, { validatorResults: run.validatorResults, effectStateUnknown: run.effectStateUnknown, outcome: effectiveOutcome });

    let state;
    if (effectiveOutcome === 'awaiting_user_input' || effectiveOutcome === 'awaiting_condition') state = effectiveOutcome;
    else if (effectiveOutcome === 'unknown_effect') state = 'unknown';
    else if (effectiveOutcome === 'failed') state = 'failed';
    else if (gate.result === 'passed') state = 'passed';
    else if (gate.result === 'inconclusive') state = 'inconclusive';
    else state = 'failed';

    plan.stepStates[stepId] = state;
    plan.stepEvidence[stepId] = { at: run.at, evidence: gate.evidence, reasonCode: gate.reasonCode, attempt, modelRuns: 1 };

    const capReached = state !== 'passed' && !STEP_WAITING.has(state) && state !== 'unknown' ? attempt >= step.maxAttempts : false;
    const unknownEffect = state === 'unknown';
    if (capReached && !unknownEffect) {
      plan.status = 'stopped';
      plan.blocker = { reason: 'ATTEMPT_CAP_EXHAUSTED', stepId, stepKey: step.stepKey, attempts: attempt, maxAttempts: step.maxAttempts, at: run.at };
      log.write('plan.stopped', { ...correlationFor(plan, { runId: run.runId, operationId: run.externalOperationId }), stepId, stepKey: step.stepKey, attempts: attempt, maxAttempts: step.maxAttempts, from: 'active', to: 'stopped', reasonCode: 'ATTEMPT_CAP_EXHAUSTED', hint: 'progress is stopped; a new control record is not created to bypass the cap' });
    }

    save(plan);
    log.write('step.settled', {
      ...correlationFor(plan, { runId: run.runId, operationId: run.externalOperationId || run.awaitingInputId || run.conditionRef }),
      stepId,
      stepKey: step.stepKey,
      stepType: step.stepType,
      attempt,
      state,
      gateResult: gate.result,
      gateReasonCode: gate.reasonCode,
      outcome: effectiveOutcome,
      externalRef: run.externalOperationRef ? run.externalOperationRef.ref?.id || null : null,
      dispatchCount: externalDispatch.dispatchCount ?? null,
      gtdId: plan.gtdId,
      from: 'running',
      to: state,
      reasonCode: gate.reasonCode,
    });

    reportToGtd(plan, { run, step, state, gate, attempt });

    return {
      stepId,
      stepKey: step.stepKey,
      state,
      gate,
      planStatus: plan.status,
      capReached,
      alreadyDone: false,
      externalOperationRef: run.externalOperationRef,
      dispatchCount: externalDispatch.dispatchCount ?? null,
      run,
      awaiting: plan.awaiting[stepId] || null,
      condition: plan.conditions[stepId] || null,
    };
  }

  /**
   * Отчёт исхода GTD. Для управляемой работы — ровно один вызов с одним решением;
   * для неуправляемой — ни одного (проверяется счётчиками порта).
   */
  function reportToGtd(plan, { run, step, state, gate, attempt }) {
    if (!plan.gtdId) {
      log.write('gtd.skipped', { ...correlationFor(plan, { runId: run.runId }), stepId: step.stepId, gtdId: null, continuationOwner: 'output', from: 'step', to: 'output_owned', reasonCode: 'NO_CONTROL_RECORD_OPT_IN_ONLY' });
      return null;
    }
    const kind = state === 'passed' ? 'done' : STEP_WAITING.has(state) ? state : state === 'unknown' ? 'unknown_effect' : 'failed';
    const outcome = gtdPort.reportOutcome({
      profileId: plan.profileId,
      userTaskId: plan.userTaskId,
      gtdId: plan.gtdId,
      eventId: `${run.runId}:${state}`,
      kind,
      planId: plan.planId,
      stepId: step.stepId,
      runId: run.runId,
      effectStateUnknown: state === 'unknown',
    });
    log.write('gtd.outcome.reported', {
      ...correlationFor(plan, { runId: run.runId, operationId: run.runId }),
      stepId: step.stepId,
      gtdId: plan.gtdId,
      eventId: `${run.runId}:${state}`,
      attempt,
      outcomeStatus: outcome.status,
      decisionAction: outcome.ack ? outcome.ack.decision.action : null,
      from: 'step',
      to: outcome.status,
      reasonCode: outcome.status === 'quarantined' ? outcome.reason : outcome.status === 'accepted' ? 'GTD_ACK_ONE_DECISION' : outcome.status.toUpperCase(),
    });
    return outcome;
  }

  /**
   * Тик виртуальных часов: внешнее условие разрешилось, ответ пользователя
   * пришёл, дедлайн ожидания истёк, cap исчерпан. Никакого реального сна.
   */
  function tick({ planId, at = clock(), answer } = {}) {
    const plan = load(planId);
    const transitions = [];
    for (const step of plan.steps) {
      const state = plan.stepStates[step.stepId];
      if (state === 'awaiting_user_input') {
        transitions.push({ stepId: step.stepId, state, kind: 'awaiting_user_input', awaitingInputId: plan.awaiting[step.stepId].awaitingInputId, needsAnswer: true });
        continue;
      }
      if (state === 'awaiting_condition') {
        const record = plan.conditions[step.stepId];
        const polled = ci && record && record.externalRef ? ci.poll({ externalRef: record.externalRef, stepId: step.stepId }) : { status: 'pending' };
        if (polled.status === 'completed') {
          plan.stepStates[step.stepId] = 'pending';
          plan.stepExternalOps[step.stepId] = { ...(plan.stepExternalOps[step.stepId] || {}), conclusion: polled.conclusion };
          plan.conditions[step.stepId] = { ...record, satisfiedAt: at.toISOString(), conclusion: polled.conclusion };
          transitions.push({ stepId: step.stepId, state: 'pending', kind: 'condition_satisfied', conclusion: polled.conclusion, externalRef: record.externalRef.id });
        } else {
          transitions.push({ stepId: step.stepId, state, kind: 'awaiting_condition', externalRef: record && record.externalRef ? record.externalRef.id : null });
        }
        continue;
      }
      if ((state === 'failed' || state === 'inconclusive') && (plan.stepAttempts[step.stepId] || 0) >= step.maxAttempts) {
        transitions.push({ stepId: step.stepId, state, kind: 'attempt_cap_exhausted', attempts: plan.stepAttempts[step.stepId], maxAttempts: step.maxAttempts });
      }
    }
    save(plan);
    if (transitions.length > 0) {
      log.write('plan.tick', {
        ...correlationFor(plan),
        at: at.toISOString(),
        transitions: transitions.map(t => `${t.stepId}:${t.kind}`),
        dispatchCount: ci ? ci.dispatchCount() : null,
        from: 'waiting',
        to: 'waiting',
        reasonCode: 'VIRTUAL_CLOCK_TICK_NO_SLEEP',
      });
    }
    return { planId, at: at.toISOString(), transitions };
  }

  /**
   * Ответ пользователя на durable Awaiting input. Duplicate/поздний ответ
   * возобновляет работу ровно один раз; restart между ожиданием и ответом
   * ничего не теряет, потому что запись лежит на диске.
   */
  function answer({ planId, awaitingInputId, answerEventId, answer: payload, at = clock() }) {
    const plan = load(planId);
    const step = plan.steps.find(candidate => plan.awaiting[candidate.stepId] && plan.awaiting[candidate.stepId].awaitingInputId === awaitingInputId);
    if (!step) {
      throw new PlanError('AWAITING_INPUT_NOT_OPEN', `no open awaiting-input record ${awaitingInputId} in plan ${planId}`, { planId, awaitingInputId });
    }
    const record = plan.awaiting[step.stepId];
    const accepted = gtdPort.recordAnswer({ awaitingInputId, answerEventId, gtdId: plan.gtdId });
    if (accepted.status === 'replayed') {
      log.write('awaiting.answer.replayed', { ...correlationFor(plan, { operationId: awaitingInputId }), stepId: step.stepId, awaitingInputId, answerEventId, from: 'awaiting_user_input', to: 'awaiting_user_input', reasonCode: 'DUPLICATE_ANSWER_NO_SECOND_RESUME', resumedRunId: record.resumedRunId });
      return { accepted: false, replayed: true, planId, stepId: step.stepId, awaitingInputId, resumedRunId: record.resumedRunId };
    }
    record.answeredAt = at.toISOString();
    record.answerEventId = answerEventId;
    record.answer = payload ? { received: true } : { received: false };
    plan.stepStates[step.stepId] = 'pending';
    plan.awaiting[step.stepId] = record;
    save(plan);
    log.write('awaiting.answer.accepted', { ...correlationFor(plan, { operationId: awaitingInputId }), stepId: step.stepId, awaitingInputId, answerEventId, from: 'awaiting_user_input', to: 'pending', reasonCode: 'ANSWER_ACCEPTED_ONE_RESUME' });
    return { accepted: true, replayed: false, planId, stepId: step.stepId, awaitingInputId, gtdAck: accepted.ack || null };
  }

  function openAcceptance({ planId, at = clock() } = {}) {
    const plan = load(planId);
    plan.acceptance = { openedAt: at.toISOString(), decidedAt: null, result: null };
    save(plan);
    log.write('acceptance.opened', { ...correlationFor(plan), from: 'active', to: 'acceptance_open', reasonCode: 'FRESH_EVIDENCE_REQUIRED_FROM_NOW' });
    return plan.acceptance;
  }

  function accept({ planId, at = clock(), staleAfterMs = 0 }) {
    const plan = load(planId);
    if (!plan.acceptance) openAcceptance({ planId, at });
    const decision = evaluateAcceptance({ plan, openedAt: plan.acceptance.openedAt, staleAfterMs, now: at });
    plan.acceptance.decidedAt = at.toISOString();
    plan.acceptance.result = decision;
    plan.status = decision.accepted ? 'completed' : plan.status;
    save(plan);
    log.write('acceptance.decided', {
      ...correlationFor(plan),
      accepted: decision.accepted,
      reasonCode: decision.reasonCode,
      requiredSteps: decision.requiredSteps,
      missing: decision.missing.map(item => item.stepKey),
      stale: decision.stale.map(item => item.stepKey),
      unfinished: decision.unfinished.map(item => item.stepKey),
      from: 'acceptance_open',
      to: decision.accepted ? 'completed' : 'active',
      reasonCode: decision.accepted ? 'ACCEPTANCE_SATISFIED' : decision.reasonCode,
    });
    return decision;
  }

  function cancel({ planId, reason, at = clock() } = {}) {
    const plan = load(planId);
    plan.status = 'cancelled';
    plan.cancelledAt = at.toISOString();
    plan.cancelReason = reason || null;
    save(plan);
    log.write('plan.cancelled', { ...correlationFor(plan), reason: reason || null, from: plan.status, to: 'cancelled', reasonCode: 'CANCELLED_BY_CALLER' });
    return plan;
  }

  function snapshot(planId) {
    const plan = load(planId);
    return {
      planId: plan.planId,
      compiledPlanRevision: plan.compiledPlanRevision,
      gtdId: plan.gtdId,
      continuationOwner: plan.continuationOwner,
      status: plan.status,
      steps: plan.steps,
      stepStates: { ...plan.stepStates },
      stepEvidence: plan.stepEvidence || {},
      fingerprint: plan.steps.map(step => `${step.stepId}:${stepFingerprint(step)}`).join('\n'),
    };
  }

  function assertRunningStepsStable(planId) {
    const plan = load(planId);
    assertRunningStepsUnchanged({ before: snapshot(planId), after: { ...plan, planId: plan.planId } });
    return { planId, stable: true, pinned: assertPinnedDefinition(planId) };
  }

  return {
    root,
    dataRoot,
    log,
    gtdPort,
    ci,
    executor: exec,
    compile,
    load,
    save,
    assertPinnedDefinition,
    assertRunningStepsStable,
    readyStep,
    runStep,
    tick,
    answer,
    openAcceptance,
    accept,
    cancel,
    reconcileExternal,
    pollExternal,
    snapshot,
    list: () => (fs.existsSync(store) ? fs.readdirSync(store).filter(dir => fs.existsSync(planFile(dir))) : []),
    diff: (beforeId, afterId) => diffPlans(load(beforeId), load(afterId)),
  };
}

module.exports = { DEFINITION_FILE, LOG_FILE, PLANS_DIR, PLAN_FILE, STEP_TERMINAL, STEP_WAITING, createPlanRuntime };