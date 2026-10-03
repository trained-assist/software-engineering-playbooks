'use strict';

// Граница с GTD Manager (P24 опирается на P23, карточка #62: GTD module в
// trained-assist-control-plane, PR #22). Это НЕ второй GTD Manager, а порт:
// словарь (`gtdId`, `continuationOwner`, регистрация с reason/criteria/deadline/
// caps, durable ACK исхода, одно решение) взят из P23 и не переименован.
//
// Разделение: порт — граница (кто подключён, что запрещено, как считаются вызовы),
// transport — тот, кто отвечает. Боевой control plane подключает своего клиента;
// песочница — `createInProcessGtdTransport()` с теми же правилами на памяти и
// виртуальных часах. Если transport не подключён (`transport: null`), контроль
// недоступен — и НЕ появляется молчаливый второй владелец продолжения.
//
// Проверяемые правила (все — из P23, не новые):
//   * контроль OPT-IN: gtdId появляется только после явной регистрации; простое
//     расписание, разовая задача и чтение плейбука его не создают;
//   * регистрация неполная (нет reason/criteria/nextTrigger/deadline/caps) →
//     blocked до создания записи;
//   * одна запись контроля на userTaskId (как UNIQUE(user_task_id) в P23): обойти
//     исчерпанные caps «новой записью» нельзя;
//   * self-GTD запрещён;
//   * исходы дедуплицируются по eventId и дают РОВНО одно решение;
//   * неизвестный gtdId у managed-исхода — карантин, а не тихий переход в
//     output-owned recovery;
//   * поздний исход закрытой записи дополняет историю, но не возобновляет работу.

const crypto = require('crypto');

const DECISIONS = ['resume', 'retry', 'wait', 'stop', 'reconcile'];

function gtdIdFor({ profileId, userTaskId }) {
  // Детерминированно и однозначно: та же пара principal+task → та же запись
  // контроля (в P23 это UNIQUE(user_task_id) на уровне данных).
  const digest = crypto.createHash('sha256').update(`${profileId}|${userTaskId}`).digest('hex').slice(0, 12);
  return `gtd_${digest}`;
}

function missingRegistrationFields({ reason, completionCriteria, nextTrigger, deadlineAt, maxAttempts }) {
  const missing = [];
  if (!reason || String(reason).trim().length === 0) missing.push('reason');
  if (!completionCriteria || (Array.isArray(completionCriteria) && completionCriteria.length === 0)) missing.push('completionCriteria');
  if (!nextTrigger || (typeof nextTrigger === 'object' && Object.keys(nextTrigger).length === 0)) missing.push('nextTrigger');
  if (!deadlineAt) missing.push('deadlineAt');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) missing.push('maxAttempts');
  return missing;
}

/**
 * Решение GTD выводится из структурного исхода, а не из текста и не из LLM
 * (P23: «решения детерминированы по структурированному исходу»).
 */
function decide(kind, { attemptsUsed = 0, maxAttempts = 1, hasNextStep = false, effectStateUnknown = false } = {}) {
  if (effectStateUnknown) return 'reconcile';
  if (kind === 'awaiting_user_input' || kind === 'awaiting_condition') return 'wait';
  if (kind === 'done') return hasNextStep ? 'resume' : 'stop';
  if (kind === 'failed') return attemptsUsed >= maxAttempts ? 'stop' : 'retry';
  return 'stop';
}

/**
 * In-process GTD Manager для песочницы: те же правила, что в control-plane,
 * состояние в памяти процесса и виртуальные часы.
 */
function createInProcessGtdTransport({ clock = () => new Date() } = {}) {
  const records = new Map();
  const byTask = new Map();
  const inbox = new Map();

  return {
    kind: 'in_process_sandbox',
    records: () => [...records.values()],
    inboxSize: () => inbox.size,

    registerControl({ profileId, userTaskId, reason, completionCriteria, nextTrigger, deadlineAt, maxAttempts, supervisedByGtdId = null, planId = null }) {
      const missing = missingRegistrationFields({ reason, completionCriteria, nextTrigger, deadlineAt, maxAttempts });
      if (missing.length > 0) {
        return { status: 'blocked', reason: 'INCOMPLETE_CONTROL_RECORD', missing, hint: 'GTD needs reason, completion criteria, next trigger/check, deadline and attempt caps' };
      }
      const gtdId = gtdIdFor({ profileId, userTaskId });
      if (supervisedByGtdId && supervisedByGtdId === gtdId) {
        return { status: 'blocked', reason: 'SELF_SUPERVISION_FORBIDDEN', gtdId };
      }
      const existingId = byTask.get(`${profileId}|${userTaskId}`);
      if (existingId) {
        const existing = records.get(existingId);
        return {
          status: 'already_registered',
          gtdId: existingId,
          state: existing.state,
          // Обойти исчерпанные caps «новой записью управления» нельзя: запись одна.
          hint: existing.state === 'stopped' ? 'control record is stopped; register a new user task instead of a new control record' : 'this user task is already under control',
        };
      }
      const record = {
        gtdId,
        profileId,
        userTaskId,
        planId,
        reason: String(reason),
        completionCriteria,
        nextTrigger,
        deadlineAt,
        maxAttempts,
        attemptsUsed: 0,
        state: 'active',
        controlGeneration: 1,
        registeredAt: clock().toISOString(),
        supervisedByGtdId,
      };
      records.set(record.gtdId, record);
      byTask.set(`${profileId}|${userTaskId}`, record.gtdId);
      return { status: 'registered', gtdId: record.gtdId, record: { ...record } };
    },

    reportOutcome({ profileId, userTaskId, gtdId, eventId, kind, planId = null, stepId = null, runId = null, effectStateUnknown = false, controlGeneration = null }) {
      if (!gtdId) return { status: 'blocked', reason: 'GTD_ID_MISSING', hint: 'a managed outcome must carry its control binding; gtdId=null means the task is not under control' };
      const record = records.get(gtdId);
      if (!record) {
        return {
          status: 'quarantined',
          reason: 'GTD_CONTROL_UNKNOWN',
          reconciliationRequired: true,
          hint: 'unknown gtdId for a managed outcome: quarantine and reconcile, never a silent output-owned recovery',
        };
      }
      if (record.userTaskId !== userTaskId) {
        return { status: 'quarantined', reason: 'GTD_CONTROL_TASK_MISMATCH', reconciliationRequired: true, expectedUserTaskId: record.userTaskId };
      }
      if (record.state === 'stopped' || record.state === 'completed') {
        return { status: 'late', gtdId, state: record.state, reason: 'LATE_OUTCOME_FOR_CLOSED_RECORD', hint: 'history is updated; work is not resurrected' };
      }
      if (!eventId) return { status: 'blocked', reason: 'EVENT_ID_MISSING', hint: 'dedup key is required: a repeated submission must not produce two continuations' };

      if (inbox.has(eventId)) {
        return { status: 'replayed', gtdId, ack: inbox.get(eventId), hint: 'same eventId: one logical continuation, replay returns the original ack' };
      }

      const attemptsUsed = kind === 'failed' ? record.attemptsUsed + 1 : record.attemptsUsed;
      record.attemptsUsed = attemptsUsed;
      const action = decide(kind, {
        attemptsUsed,
        maxAttempts: record.maxAttempts,
        hasNextStep: Boolean(stepId),
        effectStateUnknown,
      });
      if (action === 'stop') record.state = 'stopped';
      const ack = {
        eventId,
        gtdId,
        acceptedAt: clock().toISOString(),
        decision: { action, attemptsUsed, maxAttempts: record.maxAttempts, planId, stepId, runId },
        controlGeneration: controlGeneration ?? record.controlGeneration,
      };
      inbox.set(eventId, ack);
      return { status: 'accepted', gtdId, ack: { ...ack }, record: { ...record } };
    },

    recordAnswer({ awaitingInputId, answerEventId, gtdId = null }) {
      if (!awaitingInputId) return { status: 'blocked', reason: 'AWAITING_INPUT_ID_MISSING' };
      const key = `answer:${awaitingInputId}`;
      if (inbox.has(key)) {
        return { status: 'replayed', ack: inbox.get(key), hint: 'duplicate answer resumes exactly once' };
      }
      const ack = { eventId: answerEventId, awaitingInputId, gtdId, acceptedAt: clock().toISOString(), decision: { action: 'resume' } };
      inbox.set(key, ack);
      return { status: 'accepted', ack: { ...ack } };
    },
  };
}

/**
 * Порт: граница, а не реализация. `transport: null` — GTD Manager не подключён.
 * @param {object} [options]
 * @param {object} [options.transport] ответчик GTD (боевой клиент или sandbox-транспорт)
 * @param {() => Date} [options.clock]
 */
function createGtdPort({ transport = createInProcessGtdTransport(), clock = () => new Date() } = {}) {
  const calls = { register: 0, outcomes: 0, answers: 0 };
  const unavailable = () => ({ status: 'unavailable', reason: 'GTD_MANAGER_NOT_CONFIGURED', hint: 'control record is unavailable; the task stays continuationOwner=output' });

  return {
    available: Boolean(transport),
    calls,
    gtdIdFor,
    decisions: [...DECISIONS],
    records: () => (transport && transport.records ? transport.records() : []),
    inboxSize: () => (transport && transport.inboxSize ? transport.inboxSize() : 0),
    countFor: ({ profileId, userTaskId }) => {
      if (!transport || !transport.records) return null;
      const found = transport.records().find(record => record.profileId === profileId && record.userTaskId === userTaskId);
      return found ? found.gtdId : null;
    },

    /** Явная регистрация на контроль. Единственный путь, где появляется gtdId. */
    registerControl(request) {
      calls.register += 1;
      if (!transport) return unavailable();
      return transport.registerControl({ ...request, registeredAt: clock().toISOString() });
    },

    /** Structured outcome → durable GTD inbox → ACK с ровно одним решением. */
    reportOutcome(request) {
      calls.outcomes += 1;
      if (!transport) return unavailable();
      return transport.reportOutcome(request);
    },

    /** Ответ пользователя на durable Awaiting input. Один ответ — одно возобновление. */
    recordAnswer({ awaitingInputId, answerEventId, gtdId = null }) {
      calls.answers += 1;
      if (!transport) return unavailable();
      return transport.recordAnswer({ awaitingInputId, answerEventId, gtdId });
    },
  };
}

module.exports = {
  DECISIONS,
  createGtdPort,
  createInProcessGtdTransport,
  decide,
  gtdIdFor,
  missingRegistrationFields,
};