'use strict';

// Фейковый исполнитель шагов (AC-143 evidence; чек-лист #63 § «fake executor»).
//
// Он нужен, чтобы прогнать ВСЕ типы исходов (REVIEW-WITH-REAL-PLAYBOOKS §11):
//
//   done                — шаг выполнен, валидаторы дали pass со ссылкой на evidence;
//   failed              — шаг не выполнен (попытка считается, U/G ID не меняются);
//   awaiting_user_input — durable ожидание человека: awaitingInputId, живой
//                         процесс припаркован, токены не жгутся;
//   awaiting_condition  — внешнее условие (CI/merge): conditionRef, слот освобождён;
//   unknown_effect      — внешний мутирующий вызов в неизвестном состоянии.
//
// Инварианты, которые проверяет приёмка:
//   * userTaskId и gtdId приходят ИЗ ПЛАНА и не подменяются аргументами шага;
//     на всех пяти исходах они совпадают с плановыми (AC-143: «fake executor
//     выдаёт done/failed/awaiting_user_input/awaiting_condition/unknown_effect с
//     неизменными U/G IDs»);
//   * retry шага = тот же stepId и тот же jobId, новый runId;
//   * внешняя операция шага получает operationId, стабильный на всём шаге:
//     повтор диспатча после потерянного ACK обязан быть дедуплицирован, а не
//     выполнен второй раз;
//   * «красный CI» — это структурный отчёт, а не пустой ответ: outcome=done с
//     report.conclusion=red, а обязательный гейт плана при этом не пройден.

const crypto = require('crypto');

const OUTCOMES = ['done', 'failed', 'awaiting_user_input', 'awaiting_condition', 'unknown_effect'];

function jobIdFor({ planId, stepId }) {
  return `job_${crypto.createHash('sha256').update(`${planId}|${stepId}`).digest('hex').slice(0, 12)}`;
}

function runIdFor({ jobId, attempt }) {
  return `run_${crypto.createHash('sha256').update(`${jobId}|${attempt}`).digest('hex').slice(0, 12)}`;
}

/** Стабильный на всём шаге идентификатор внешней мутации: дедуп по нему. */
function externalOperationIdFor({ planId, stepId, kind }) {
  return `extop_${crypto.createHash('sha256').update(`${planId}|${stepId}|${kind}`).digest('hex').slice(0, 12)}`;
}

function createFakeExecutor({ clock = () => new Date() } = {}) {
  return {
    outcomes: [...OUTCOMES],

    /**
     * Одна попытка шага. Никакого LLM, никакой сети: форма результата — та же,
     * что у настоящего исполнителя (Playbook v1 outcome + validator results).
     *
     * @param {object} options
     * @param {object} options.plan
     * @param {object} options.step
     * @param {number} options.attempt 1-based, переживает retry
     * @param {'done'|'failed'|'awaiting_user_input'|'awaiting_condition'|'unknown_effect'} options.outcome
     * @param {object} [options.validatorResults] {validatorName: {status, evidenceRef}}
     * @param {object} [options.report] структурный отчёт исполнителя (напр. {conclusion:'red'})
     */
    runStep({ plan, step, attempt, outcome, validatorResults = {}, report = null, detail = null }) {
      if (!OUTCOMES.includes(outcome)) {
        throw new Error(`unknown fake outcome "${outcome}"; expected one of ${OUTCOMES.join('|')}`);
      }
      const jobId = jobIdFor({ planId: plan.planId, stepId: step.stepId });
      const runId = runIdFor({ jobId, attempt });
      const at = clock().toISOString();
      const base = {
        // U/G binding берётся из плана. Никогда из аргументов исполнителя.
        profileId: plan.profileId,
        userTaskId: plan.userTaskId,
        gtdId: plan.gtdId,
        continuationOwner: plan.continuationOwner,
        planId: plan.planId,
        stepId: step.stepId,
        stepKey: step.stepKey,
        jobId,
        runId,
        attempt,
        outcome,
        at,
        validatorResults,
        report,
        detail,
        externalOperationId: step.externalOperation ? externalOperationIdFor({ planId: plan.planId, stepId: step.stepId, kind: step.externalOperation.kind }) : null,
        externalOperationRef: step.externalOperation ? { ...step.externalOperation, ref: null } : null,
        awaitingInputId: null,
        conditionRef: null,
        effectStateUnknown: false,
        evidence: Object.values(validatorResults).map(v => v.evidenceRef).filter(Boolean),
      };

      if (outcome === 'awaiting_user_input') {
        return {
          ...base,
          awaitingInputId: `ain_${crypto.createHash('sha256').update(`${runId}|user_input`).digest('hex').slice(0, 12)}`,
          transition: { from: 'running', to: 'awaiting_user_input', reasonCode: 'DURABLE_AWAITING_INPUT' },
        };
      }
      if (outcome === 'awaiting_condition') {
        return {
          ...base,
          conditionRef: `cond_${crypto.createHash('sha256').update(`${runId}|condition`).digest('hex').slice(0, 12)}`,
          transition: { from: 'running', to: 'awaiting_condition', reasonCode: 'DURABLE_AWAITING_CONDITION' },
        };
      }
      if (outcome === 'unknown_effect') {
        return {
          ...base,
          effectStateUnknown: true,
          transition: { from: 'running', to: 'unknown', reasonCode: 'EFFECT_STATE_UNKNOWN' },
        };
      }
      if (outcome === 'failed') {
        return { ...base, transition: { from: 'running', to: 'failed', reasonCode: 'STEP_EXECUTION_FAILED' } };
      }
      return { ...base, transition: { from: 'running', to: 'done', reasonCode: 'STEP_COMPLETED' } };
    },
  };
}

module.exports = { OUTCOMES, createFakeExecutor, externalOperationIdFor, jobIdFor, runIdFor };