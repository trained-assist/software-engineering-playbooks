'use strict';

// Гейты шага и приёмка плана (P24, SANDBOX · I07).
//
// Четыре разных исхода гейта, и их смешение — главный источник ложного «готово»:
//
//   passed      — все обязательные validators дали pass со ссылкой на evidence;
//   failed      — validator дал fail (например CI красный). Это НЕ то же самое,
//                что «отчёт о красных тестах не удался»: отчёт-отчёт успешен,
//                а required gate плана не пройден;
//   inconclusive— validators не дали сигнала (validator не разрешён или
//                исполнитель не принёс evidence). Это отдельно от failed:
//                inconclusive никогда не превращается в pass;
//   unknown     — внешний эффект в неизвестном состоянии: до reconcile повтор
//                запрещён (PR-04), и приёмка по такому шагу невозможна.
//
// Обязательный гейт выключить нельзя (AC-147, PR-20): `required` либо отсутствует
// (значит true), либо true. `setGatePolicy` с required:false — отказ
// GATE_NOT_DISABLEABLE, а не тихая подмена.
//
// Приёмка плана требует свежее доказательство по каждому обязательному шагу
// (PR-20 / U-23 → AC-146): evidence, собранное ДО открытия приёмки, не закрывает
// план. Это ровно проверка «план не закрывается без свежего доказательства по
// каждому пункту».

const { PlanError } = require('./errors');

const GATE_RESULTS = ['passed', 'failed', 'inconclusive', 'not_evaluated'];

/** Обязательность гейта — константа: false здесь означает ошибку, а не настройку. */
function setGatePolicy(steps, { stepId, required }) {
  if (required === false) {
    throw new PlanError('GATE_NOT_DISABLEABLE', `required gate of step ${stepId} cannot be turned off; record a scoped exception with actor/reason/evidence instead`, { stepId });
  }
  return steps.map(step => (step.stepId === stepId ? { ...step, gate: { ...step.gate, required: true } } : step));
}

/** Детерминированный pre-check `already_done` до диспатча: ноль модельных ран'ов. */
function precheckAlreadyDone(step, signals = {}) {
  const checks = step.gate.alreadyDone || [];
  if (checks.length === 0) return { applicable: false };
  const unmet = checks.filter(check => signals[check.name] !== 'pass');
  return {
    applicable: true,
    allSatisfied: unmet.length === 0,
    unmet: unmet.map(check => check.name),
  };
}

/**
 * Оценка обязательного гейта шага по структурному исходу исполнителя.
 * `validatorResults: { <validatorName>: { status: 'passed'|'failed', evidenceRef } }`
 */
function evaluateStepGate(step, { validatorResults = {}, effectStateUnknown = false, outcome } = {}) {
  if (effectStateUnknown) {
    return {
      result: 'unknown',
      satisfied: false,
      reasonCode: 'EFFECT_STATE_UNKNOWN',
      evidence: [],
      missingValidators: step.gate.validators.map(v => v.name),
    };
  }
  if (!step.gate.required) {
    return { result: 'passed', satisfied: true, reasonCode: 'ADVISORY_STEP_NO_REQUIRED_GATE', evidence: Object.values(validatorResults).map(v => v.evidenceRef).filter(Boolean), missingValidators: [] };
  }

  const evidence = [];
  const missingValidators = [];
  const failedValidators = [];
  for (const validator of step.gate.validators) {
    const reported = validatorResults[validator.name];
    if (!reported) {
      missingValidators.push(validator.name);
      continue;
    }
    if (reported.status === 'failed') {
      failedValidators.push(validator.name);
      continue;
    }
    if (!reported.evidenceRef) {
      // «Ок» без проверяемого доказательства — не pass (PR-16 в терминах гейта).
      missingValidators.push(validator.name);
      continue;
    }
    evidence.push(reported.evidenceRef);
  }

  if (failedValidators.length > 0) {
    return {
      result: 'failed',
      satisfied: false,
      reasonCode: step.stepType === 'ci-green' ? 'CI_RED_REQUIRED_GATE' : 'REQUIRED_VALIDATOR_FAILED',
      failedValidators,
      evidence,
      missingValidators,
    };
  }
  if (missingValidators.length > 0) {
    return {
      result: 'inconclusive',
      satisfied: false,
      reasonCode: 'GATE_EVIDENCE_MISSING',
      missingValidators,
      evidence,
      hint: 'an unresolved validator or a missing evidence ref is not a pass; resolve the validator contract before dispatch',
    };
  }
  return { result: 'passed', satisfied: true, reasonCode: `GATE_${outcome ? outcome.toUpperCase() : 'SATISFIED'}`, evidence, missingValidators };
}

/**
 * Приёмка плана. Требует: каждый обязательный шаг passed, evidence свежий
 * относительно открытия приёмки, шагов в unknown/inconclusive нет.
 */
function evaluateAcceptance({ plan, openedAt, staleAfterMs = 0, now }) {
  const required = plan.steps.filter(step => step.gate.required);
  const missing = [];
  const stale = [];
  const unfinished = [];
  for (const step of required) {
    const state = plan.stepStates[step.stepId];
    if (state === 'passed') {
      const evidenceAt = plan.stepEvidence && plan.stepEvidence[step.stepId] ? plan.stepEvidence[step.stepId].at : null;
      if (!evidenceAt) {
        missing.push({ stepId: step.stepId, stepKey: step.stepKey, reason: 'NO_EVIDENCE' });
        continue;
      }
      const ageMs = now.getTime() - new Date(evidenceAt).getTime();
      if (openedAt && ageMs > staleAfterMs) stale.push({ stepId: step.stepId, stepKey: step.stepKey, evidenceAt });
      continue;
    }
    if (state === 'unknown') unfinished.push({ stepId: step.stepId, stepKey: step.stepKey, state, reason: 'EFFECT_STATE_UNKNOWN' });
    else if (state === 'awaiting_user_input' || state === 'awaiting_condition') unfinished.push({ stepId: step.stepId, stepKey: step.stepKey, state, reason: 'DURABLE_WAIT_OPEN' });
    else if (state === 'failed') unfinished.push({ stepId: step.stepId, stepKey: step.stepKey, state, reason: 'REQUIRED_GATE_FAILED' });
    else missing.push({ stepId: step.stepId, stepKey: step.stepKey, reason: 'STEP_NOT_PASSED', state });
  }
  const accepted = missing.length === 0 && stale.length === 0 && unfinished.length === 0;
  return {
    accepted,
    reasonCode: accepted ? 'ACCEPTANCE_SATISFIED' : unfinished.length > 0 ? 'ACCEPTANCE_BLOCKED' : 'ACCEPTANCE_STALE_EVIDENCE',
    requiredSteps: required.length,
    missing,
    stale,
    unfinished,
  };
}

module.exports = { GATE_RESULTS, evaluateAcceptance, evaluateStepGate, precheckAlreadyDone, setGatePolicy };