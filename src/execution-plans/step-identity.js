'use strict';

// Идентичность шагов compiled plan (P24: «правки не меняют ID запущенных шагов»).
//
// Три разных вещи, которые легко спутать:
//
//   stepKey  — семантический ключ шага ВНУТРИ definition'а: `stageId#ordinal`
//              (legacy-артефакты) или `stageId:<step.id>` (когда у шага есть
//              собственное `id`). Ключ переживает правку артефакта и поэтому
//              годится для сопоставления версий, но идентификатором НЕ является:
//              он не уникален между планами и меняется при вставке шага выше.
//
//   stepId   — идентификатор шага В ПЛАНЕ. Компилятор присваивает его один раз
//              и сохраняет вместе с pinned-хешем артефакта, из которого шаг
//              скомпилирован: `stp_<sha256(playbookId@artifactHash#stepKey)>`.
//              Повторная компиляция того же артефакта даёт те же ID (детерминизм
//              и воспроизводимость), а правка артефакта даёт ДРУГИЕ ID в НОВОМ
//              плане — старый план при этом не перестраивается.
//
//   pinned   — байты definition'а, из которых собраны шаги (хранятся рядом с
//              планом). «Активный план продолжает pinned revision» проверяется
//              пересчётом sha256 этих байт, а не памятью рантайма.
//
// Почему stepId включает хеш артефакта: один и тот же stepKey в другой ревизии
// — это потенциально другой шаг (изменились инструкции/гейты). Общий stepId
// сделал бы историю плана неоднозначной. Сопоставление версий — работа stepKey,
// и для этого есть diffPlans().

const crypto = require('crypto');
const { PlanError } = require('./errors');

const LEGACY_STAGE_ORDINAL = 'legacy_stage_ordinal';
const EXPLICIT_STEP_ID = 'explicit_step_id';

/**
 * Семантический ключ шага. В проверенных 132 шагах поля `id` нет — legacy-маппинг
 * `stageId#ordinal` допустим ровно внутри pinned-ревизии (см. границы §12a).
 */
function stepKeyOf({ stageId, step, ordinal }) {
  if (step && typeof step.id === 'string' && step.id.length > 0) {
    return { stepKey: `${stageId}:${step.id}`, source: EXPLICIT_STEP_ID };
  }
  return { stepKey: `${stageId}#${ordinal + 1}`, source: LEGACY_STAGE_ORDINAL };
}

/** Детерминированный stepId: один и тот же pinned-артефакт → один и тот же ID. */
function stepIdOf({ playbookId, artifactHash, stepKey }) {
  const digest = crypto.createHash('sha256').update(`${playbookId}@${artifactHash}#${stepKey}`).digest('hex').slice(0, 16);
  return `stp_${digest}`;
}

function makeStepIdFactory({ playbookId, artifactHash }) {
  return stepKey => stepIdOf({ playbookId, artifactHash, stepKey });
}

function stepRef(step) {
  return { stepId: step.stepId, stepKey: step.stepKey };
}

/** Канонический отпечаток шага: всё, что нельзя менять назад у running-шага. */
function stepFingerprint(step) {
  return JSON.stringify({
    stepId: step.stepId,
    stepKey: step.stepKey,
    title: step.title,
    stepType: step.stepType,
    executionKind: step.executionKind,
    gate: step.gate,
    wait: step.wait,
    dependsOn: step.dependsOn,
    externalOperation: step.externalOperation,
  });
}

function findStep(plan, stepId) {
  const step = (plan.steps || []).find(candidate => candidate.stepId === stepId);
  if (!step) {
    throw new PlanError('STEP_NOT_FOUND', `plan ${plan.planId} has no step ${stepId}`, { planId: plan.planId, stepId });
  }
  return step;
}

/**
 * Инвариант AC-143 «правка не меняет running step IDs»: у всех шагов, которые уже
 * начали исполняться (running/терминальные), отпечаток обязан совпасть.
 */
function assertRunningStepsUnchanged({ before, after }) {
  if (!before || !after) {
    throw new PlanError('PLAN_NOT_COMPILED', 'both plan snapshots are required to compare running steps');
  }
  if (before.planId !== after.planId) {
    throw new PlanError('RUNNING_STEP_IDS_CHANGED', `planId changed between snapshots: ${before.planId} → ${after.planId}`, {
      beforePlanId: before.planId,
      afterPlanId: after.planId,
    });
  }
  const touchedStates = new Set(['running', 'passed', 'failed', 'awaiting_user_input', 'awaiting_condition']);
  const byId = new Map((after.steps || []).map(step => [step.stepId, step]));
  const violations = [];
  for (const step of before.steps || []) {
    const state = (before.stepStates && before.stepStates[step.stepId]) || 'pending';
    if (!touchedStates.has(state)) continue;
    const other = byId.get(step.stepId);
    if (!other) {
      violations.push({ stepId: step.stepId, stepKey: step.stepKey, problem: 'step_disappeared' });
      continue;
    }
    if (stepFingerprint(step) !== stepFingerprint(other)) {
      violations.push({ stepId: step.stepId, stepKey: step.stepKey, problem: 'step_contract_changed' });
    }
  }
  if (violations.length > 0) {
    throw new PlanError('RUNNING_STEP_IDS_CHANGED', `running steps changed in place: ${violations.map(v => v.stepKey).join(', ')}`, {
      planId: before.planId,
      violations,
    });
  }
  return { unchanged: true, checkedSteps: (before.steps || []).length };
}

/**
 * Сопоставление двух ревизий плана по stepKey. Это единственный разрешённый
 * способ говорить «это тот же шаг в другой версии артефакта».
 */
function diffPlans(before, after) {
  const beforeByKey = new Map((before.steps || []).map(step => [step.stepKey, step]));
  const afterByKey = new Map((after.steps || []).map(step => [step.stepKey, step]));
  const added = [];
  const removed = [];
  const retained = [];
  for (const [key, step] of afterByKey) {
    const old = beforeByKey.get(key);
    if (!old) {
      added.push(stepRef(step));
      continue;
    }
    retained.push({
      stepKey: key,
      beforeStepId: old.stepId,
      afterStepId: step.stepId,
      sameStepId: old.stepId === step.stepId,
      retitled: old.title !== step.title,
    });
  }
  for (const [key, step] of beforeByKey) {
    if (!afterByKey.has(key)) removed.push(stepRef(step));
  }
  return { added, removed, retained };
}

module.exports = {
  EXPLICIT_STEP_ID,
  LEGACY_STAGE_ORDINAL,
  assertRunningStepsUnchanged,
  diffPlans,
  findStep,
  makeStepIdFactory,
  stepFingerprint,
  stepIdOf,
  stepKeyOf,
  stepRef,
};