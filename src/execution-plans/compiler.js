'use strict';

// Компиляция pinned definition → Execution Plan (P24, AC-143 «native playbook
// retrieval не подменяет execution plan» и «edit не меняет running step IDs»).
//
// Вход — ровно тот pinned-артефакт, который P14 отдаёт как данные
// (`resolvePinnedPlaybook`): playbooks/<id>.json конкретного checkout'а + его
// sha256. Выход — конкретный экземпляр: planId, pinned ревизия, шаги со
// стабильными stepId, гейты, ожидания, внешние операции, дедлайны.
//
// Чего компилятор НЕ делает (границы §2, §3):
//   - не запускает ни шага, ни агента, ни GTD; это plan-компиляция;
//   - не берёт «последнюю известную версию»: версия и хеш обязаны совпасть,
//     иначе ARTIFACT_VERSION_MISMATCH / ARTIFACT_HASH_MISMATCH;
//   - не достраивает догадками: шаг без instructions или programmatic-шаг без
//     известного handler'а возвращаются как UNSUPPORTED_STEP_CONTRACT /
//     PROGRAMMATIC_HANDLER_UNRESOLVED до диспатча, а не «на всякий случай»
//     (находка P1 в REVIEW-WITH-REAL-PLAYBOOKS §9);
//   - не создаёт план с литералом `{name}` в тексте шага (COMPILE_INPUT_MISSING).
//
// Пин definition'а: компилятор кладёт байты артефакта в return (definitionBytes),
// а рантайм сохраняет их рядом с планом — тогда «активный план продолжает
// pinned revision» проверяется пересчётом хеша, а не доверием к памяти.

const crypto = require('crypto');
const fs = require('fs');

const { resolvePinnedPlaybook } = require('../playbook-artifacts/artifact');
const { PlanError } = require('./errors');
const { LEGACY_STAGE_ORDINAL, makeStepIdFactory, stepKeyOf } = require('./step-identity');

const SCHEMA_VERSION = 1;

// Известные programmatic-handler'ы. Шаг с execution_kind=programmatic — это
// «работа, которую делает host», а не «проверка»: валидатор проверяет результат,
// исполнитель выполняет. Неизвестный handler — отказ до диспатча, а не вызов LLM.
const PROGRAMMATIC_HANDLERS = {
  merged: 'github.pull_request_state',
};

// Внешние операции, результат которых шаг обязан зафиксировать как
// externalOperationRef до ожидания (REVIEW-WITH-REAL-PLAYBOOKS §3, §4).
const EXTERNAL_OPERATIONS = {
  'open-pr': { kind: 'pull_request', provider: 'github', required: true },
  'ci-green': { kind: 'actions_run', provider: 'github', required: true },
  merged: { kind: 'pull_request_state', provider: 'github', required: true },
  deployed: { kind: 'deploy_probe', provider: 'deployment', required: true },
  'verify-real': { kind: 'real_scenario_probe', provider: 'target', required: true },
};

// Ожидание в тексте шага — machine-readable признак, а не разбор prose.
// Отсутствие маркера не повод угадывать; наоборот, маркер без durable
// awaitingInputId — это не «подождём», а ошибка компиляции.
const AWAITING_USER_MARKER = /awaiting_user:\s*true/;
const PLACEHOLDER = /\{([a-z_][a-z0-9_]*)\}/gi;

function hashBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function planIdFor({ profileId, userTaskId, playbookId, artifactHash, compiledPlanRevision = 1, discriminator = '' }) {
  const digest = crypto
    .createHash('sha256')
    .update([profileId, userTaskId, playbookId, artifactHash, compiledPlanRevision, discriminator].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `plan_${digest}`;
}

function stepTypeOf(step) {
  return step.step_type || null;
}

/**
 * Виды ожидания. Различаются намеренно (REVIEW-WITH-REAL-PLAYBOOKS §12a):
 *   user_input — ждём человека: нужен durable awaitingInputId и checkpoint;
 *   condition  — ждём внешнее условие (CI, merge): нужен conditionRef,
 *                рантайм паркует попытку и освобождает слот;
 *   timer      — намеренное наблюдение: GTD-таймер, не живой процесс.
 */
function resolveWait(step) {
  const hasUserMarker = AWAITING_USER_MARKER.test(step.instructions || '');
  if (hasUserMarker) {
    if (step.wait) {
      throw new PlanError('UNSUPPORTED_STEP_CONTRACT', `step "${step.title}" declares both an awaiting_user marker and a programmatic wait; the runtime cannot honour both contracts`, { title: step.title });
    }
    return { kind: 'user_input', requiresAwaitingInputId: true, deadlineKind: 'wait_deadline', timeoutSec: null, requiresDurableRecord: true };
  }
  if (step.wait) {
    return {
      kind: 'condition',
      requiresAwaitingInputId: false,
      deadlineKind: 'wait_deadline',
      pollEverySec: step.wait.poll_every_sec,
      timeoutSec: step.wait.timeout_sec,
      conditionValidator: Object.keys(step.validation || {})[0] || null,
      requiresDurableRecord: true,
    };
  }
  if (typeof step.delay_after_sec === 'number') {
    return { kind: 'timer', requiresAwaitingInputId: false, deadlineKind: 'wait_deadline', delayAfterSec: step.delay_after_sec, requiresDurableRecord: false };
  }
  return null;
}

function resolveGate(step, policy = {}) {
  if (policy.required === false) {
    // Обязательный гейт нельзя выключить ни политикой компиляции, ни адаптацией.
    throw new PlanError('GATE_NOT_DISABLEABLE', `required gate of step "${step.title}" cannot be turned off; record a scoped exception with actor/reason/evidence instead`, { title: step.title, stepType: stepTypeOf(step) });
  }
  const validators = Object.keys(step.validation || {}).map(name => ({
    name,
    // Named validator разрешается ДО диспатча (P1 §9): неизвестное имя — это
    // unsupported capability, а не «проверка пройдёт потому что проверилась».
    resolved: Boolean(policy.resolvedValidators && policy.resolvedValidators[name]),
  }));
  const alreadyDone = Object.keys(step.already_done || {}).map(name => ({ name, resolved: Boolean(policy.resolvedValidators && policy.resolvedValidators[name]) }));
  return {
    required: policy.required === undefined ? true : policy.required,
    validators,
    alreadyDone,
    enforcement: step.execution_kind === 'programmatic' ? 'enforced' : 'advisory_with_required_gate',
  };
}

/** Проверка входов: план не создаётся с литералом `{name}` в тексте шага. */
function resolveInputs({ definition, vars = {}, inputDefaults = {} }) {
  const declared = definition.inputs || [];
  const resolved = declared.map(input => {
    const name = input.name;
    const value = vars[name] !== undefined ? vars[name] : inputDefaults[name];
    const source = vars[name] !== undefined ? 'vars' : inputDefaults[name] !== undefined ? 'compile_default' : null;
    if (source === null) {
      return { name, required: input.required !== false, derive: input.derive || null, provided: false, source: null };
    }
    return { name, required: input.required !== false, derive: input.derive || null, provided: true, source, valueType: typeof value };
  });
  return resolved;
}

function collectPlaceholders(definition) {
  const found = new Set();
  for (const stage of definition.stages || []) {
    for (const step of stage.steps || []) {
      const text = step.instructions || '';
      let match;
      PLACEHOLDER.lastIndex = 0;
      while ((match = PLACEHOLDER.exec(text)) !== null) found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * @param {object} options
 * @param {string} options.root           корень checkout'а с playbooks/ и contracts/
 * @param {string} options.playbookId
 * @param {number} [options.playbookVersion] обязано совпасть с артефактом
 * @param {string} [options.expectedHash]  sha256 байтов, из которых собирается план
 * @param {string} options.profileId
 * @param {string} options.userTaskId
 * @param {string|null} [options.gtdId]     запись контроля; null = продолжение принадлежит Output
 * @param {object} [options.vars]           значения inputs/placeholders
 * @param {Array}  [options.bindings]       [{name, ref, scope}] — без значений
 * @param {object} [options.gatePolicy]     {required, resolvedValidators}
 * @param {object} [options.derivedFrom]    {planId, compiledPlanRevision} для адаптации
 * @param {Array}  [options.adaptation]     список изменений адаптации
 */
function compilePlan({
  root,
  playbookId,
  playbookVersion,
  expectedHash,
  profileId,
  userTaskId,
  gtdId = null,
  goal = '',
  vars = {},
  inputDefaults = {},
  bindings = [],
  gatePolicy = {},
  sourceRevision = null,
  planId,
  compiledPlanRevision = 1,
  derivedFrom = null,
  adaptation = null,
  continuationOwner,
  clock = () => new Date(),
  operationId = null,
} = {}) {
  if (!profileId) throw new PlanError('COMPILE_INPUT_MISSING', 'profileId is required: a plan is always compiled for an identified principal');
  if (!userTaskId) throw new PlanError('COMPILE_INPUT_MISSING', 'userTaskId is required: a plan never replaces the user task it serves');

  const { descriptor, definition } = resolvePinnedPlaybook({ root, playbookId, playbookVersion, expectedHash, detail: 'full', sourceRevision });
  const artifactPath = require('path').join(require('../playbook-artifacts/artifact').resolveRoot(root), descriptor.artifactRef);
  const definitionBytes = fs.readFileSync(artifactPath);

  const inputs = resolveInputs({ definition, vars, inputDefaults });
  const resolvedNames = new Set(inputs.map(input => input.name));
  const placeholders = collectPlaceholders(definition);

  // Плейсхолдер без объявленного input'а — тоже ошибка компиляции, но если
  // вызывающий ЯВНО передал значение (vars), это не догадка, а решение
  // компилятора, и оно попадает в план отдельной записью.
  for (const name of placeholders) {
    if (resolvedNames.has(name)) continue;
    if (vars[name] !== undefined || inputDefaults[name] !== undefined) {
      inputs.push({ name, required: false, derive: null, provided: true, source: vars[name] !== undefined ? 'vars_undeclared' : 'compile_default_undeclared', valueType: typeof (vars[name] !== undefined ? vars[name] : inputDefaults[name]) });
      resolvedNames.add(name);
    }
  }

  const missing = inputs.filter(input => !input.provided);
  if (missing.length > 0) {
    throw new PlanError('COMPILE_INPUT_MISSING', `plan is never created with a literal placeholder in step text; unresolved inputs: ${missing.map(input => input.name).join(', ')}`, {
      playbookId: descriptor.id,
      missing: missing.map(input => ({ name: input.name, required: input.required, derive: input.derive })),
    });
  }

  const unresolvedPlaceholders = placeholders.filter(name => !resolvedNames.has(name));
  if (unresolvedPlaceholders.length > 0) {
    throw new PlanError('COMPILE_UNRESOLVED_PLACEHOLDER', `step text references values that are not declared inputs: ${unresolvedPlaceholders.join(', ')}`, {
      playbookId: descriptor.id,
      unresolvedPlaceholders,
    });
  }

  const makeStepId = makeStepIdFactory({ playbookId: descriptor.id, artifactHash: descriptor.artifactHash });
  const steps = [];
  const stages = [];
  const seenStepIds = new Map();
  let ordinal = 0;

  for (const stage of definition.stages || []) {
    const stageStepIds = [];
    const policy = gatePolicy[stage.id] || {};
    for (const [stageIndex, step] of (stage.steps || []).entries()) {
      // Legacy-ключ — стадия + ПОРЯДКОВЫЙ НОМЕР ВНУТРИ стадии: добавление шага в
      // конец стадии не переименовывает шаги следующих стадий, а вставка в
      // середину видна в diffPlans как переименование, а не как «тот же шаг».
      const { stepKey, source } = stepKeyOf({ stageId: stage.id, step, ordinal: stageIndex });
      const stepId = makeStepId(stepKey);
      if (seenStepIds.has(stepId)) {
        throw new PlanError('STEP_ID_COLLISION', `step "${stage.id}/${step.title}" compiled to the same stepId as "${seenStepIds.get(stepId)}"`, { playbookId: descriptor.id, stepId, stepKey });
      }
      seenStepIds.set(stepId, `${stage.id}/${step.title}`);

      const stepType = stepTypeOf(step);
      const executionKind = step.execution_kind;
      const unsupported = [];

      if (executionKind === 'agent' && !step.instructions) {
        unsupported.push('AGENT_STEP_WITHOUT_INSTRUCTIONS');
      }
      if (executionKind === 'programmatic' && !PROGRAMMATIC_HANDLERS[stepType]) {
        unsupported.push('PROGRAMMATIC_HANDLER_UNRESOLVED');
      }
      if (unsupported.length > 0) {
        throw new PlanError(
          unsupported.includes('PROGRAMMATIC_HANDLER_UNRESOLVED') ? 'PROGRAMMATIC_HANDLER_UNRESOLVED' : 'UNSUPPORTED_STEP_CONTRACT',
          `step "${stage.id}/${step.title}" (${stepType || 'no step_type'}) has no supported contract (${unsupported.join(', ')}); resolve it before dispatch instead of guessing`,
          { playbookId: descriptor.id, stageId: stage.id, stepKey, stepType, unsupported },
        );
      }

      const previous = steps.length > 0 ? steps[steps.length - 1].stepId : null;
      const externalOperation = stepType ? EXTERNAL_OPERATIONS[stepType] || null : null;
      const wait = resolveWait(step);

      const compiledStep = {
        stepId,
        stepKey,
        stageId: stage.id,
        ordinal,
        title: step.title,
        stepType,
        executionKind,
        executorRole: step.executor_role ?? null,
        minimumModelLevel: step.minimum_model_level ?? null,
        contextBudget: step.context_budget ?? null,
        instructionsRef: `${descriptor.artifactRef}#${stepKey}`,
        adapter: { compiledFrom: { stageId: stage.id, ordinal, keySource: source }, legacyOrdinalMapping: source === LEGACY_STAGE_ORDINAL },
        gate: resolveGate(step, policy),
        wait,
        deadlines: {
          // run deadline — попытка; wait deadline — ожидание; task deadline —
          // отдельная настройка контроля, а не сумма первых двух.
          runDeadlineSec: step.execution_timeout_seconds ?? definition.defaults?.execution_timeout_seconds ?? null,
          waitDeadlineSec: wait ? wait.timeoutSec : null,
          taskDeadlineSec: null,
        },
        maxAttempts: step.max_attempts ?? definition.defaults?.max_attempts ?? 1,
        dependsOn: previous ? [previous] : [],
        externalOperation: externalOperation ? { ...externalOperation, ref: null } : null,
        hooks: { onComplete: step.on_complete || [], onFail: step.on_fail || [] },
        workspaceRefRequired: executionKind === 'agent',
      };
      steps.push(compiledStep);
      stageStepIds.push(stepId);
      ordinal += 1;
    }
    stages.push({ id: stage.id, title: stage.title, stepIds: stageStepIds });
  }

  if (steps.length === 0) {
    throw new PlanError('COMPILE_NO_STEPS', `playbook "${descriptor.id}" compiled to zero steps`, { playbookId: descriptor.id });
  }

  const resolvedPlanId = planId || planIdFor({ profileId, userTaskId, playbookId: descriptor.id, artifactHash: descriptor.artifactHash, compiledPlanRevision });
  const goalDigest = `sha256:${crypto.createHash('sha256').update(String(goal)).digest('hex').slice(0, 32)}`;

  return {
    schemaVersion: SCHEMA_VERSION,
    planId: resolvedPlanId,
    compiledPlanRevision,
    profileId,
    userTaskId,
    gtdId: gtdId ?? null,
    // Единственный владелец продолжения (границы §5): gtdId есть → gtd, иначе output.
    continuationOwner: continuationOwner || (gtdId ? 'gtd' : 'output'),
    playbook: {
      playbookRef: descriptor.artifactRef,
      playbookId: descriptor.id,
      playbookVersion: descriptor.version,
      artifactHash: descriptor.artifactHash,
      sourceRevision,
      docRef: descriptor.docRef,
      pinnedAt: clock().toISOString(),
      compiledOperationId: operationId,
    },
    goalDigest,
    inputs: inputs.map(({ name, required, derive, provided, source }) => ({ name, required, derive, provided, source })),
    bindings: bindings.map(binding => ({ name: binding.name || binding.ref, ref: binding.ref || null, scope: binding.scope || null })),
    stages,
    steps,
    completionPolicy: {
      // Required gate выключить нельзя (AC-147): флаг обязателен в контракте плана.
      requiredGatesDisableable: false,
      acceptanceRequiresFreshEvidence: true,
      maxAttemptsFromDefinition: definition.defaults?.max_attempts ?? 1,
    },
    readiness: {
      unresolvedValidators: steps.flatMap(step => [...step.gate.validators, ...step.gate.alreadyDone].filter(v => !v.resolved).map(v => ({ stepId: step.stepId, stepKey: step.stepKey, validator: v.name }))),
      externalOperationRefs: steps.filter(step => step.externalOperation).map(step => ({ stepId: step.stepId, kind: step.externalOperation.kind, required: step.externalOperation.required })),
      durableWaits: steps.filter(step => step.wait && step.wait.requiresDurableRecord).map(step => ({ stepId: step.stepId, kind: step.wait.kind })),
    },
    adaptation: adaptation ? { ...adaptation, derivedFrom } : null,
    derivedFrom: derivedFrom || null,
    definitionBytes,
    definitionBytesHash: hashBytes(definitionBytes),
    stepStates: Object.fromEntries(steps.map(step => [step.stepId, 'pending'])),
  };
}

module.exports = {
  AWAITING_USER_MARKER,
  EXTERNAL_OPERATIONS,
  PROGRAMMATIC_HANDLERS,
  SCHEMA_VERSION,
  compilePlan,
  hashBytes,
  planIdFor,
  resolveWait,
  stepTypeOf,
};