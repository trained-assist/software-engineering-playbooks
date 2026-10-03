'use strict';

// Простое расписание без GTD (AC-143: «HH simple schedule по-прежнему без GTD»;
// P22 — расписание, P23 — GTD opt-in).
//
// Проверяемые свойства, взятые из границ (§7, §5a) и P22:
//   * каждое срабатывание создаёт НОВЫЙ userTaskId: scheduleId постоянен,
//     occurrence уникален, а задача — новая;
//   * occurrence дедуплицируется по occurrenceKey: повтор того же тика не
//     создаёт вторую задачу (crash replay);
//   * gtdId появляется ТОЛЬКО при явной регистрации на контроль. Расписание само
//     его не создаёт: hour/day occurrences не означают «довести до конца»;
//   * disable ≠ cancel: выключение расписания не отменяет уже принятую задачу и
//     не закрывает запись контроля;
//   * терминальный результат unmanaged-задачи не содержит gtdId вовсе — там просто
//     нет контроля, а не «gtdId пустой».
//
// Виртуальные часы: срабатывания вычисляются от `at`, реального сна нет
// (SANDBOX · I07: «Hour/day waits не требуют реального сна»).

const crypto = require('crypto');

const INTERVALS = { hourly: 3600, daily: 86400 };

function occurrenceKeyFor({ scheduleId, at }) {
  return `${scheduleId}@${new Date(at).toISOString()}`;
}

function userTaskIdFor({ scheduleId, occurrenceKey }) {
  return `ut_${crypto.createHash('sha256').update(`${scheduleId}|${occurrenceKey}`).digest('hex').slice(0, 14)}`;
}

/**
 * @param {object} options
 * @param {string} options.scheduleId постоянный идентификатор расписания
 * @param {number} options.intervalSeconds
 * @param {object} options.gtdPort порт GTD (P23) для явной регистрации
 * @param {() => Date} [options.clock]
 */
function createSimpleSchedule({ scheduleId, intervalSeconds, gtdPort, clock = () => new Date(), profileId, playbookId = null, registerControl = null } = {}) {
  if (!scheduleId) throw new Error('schedule requires a stable scheduleId');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) throw new Error('schedule interval must be a whole number of seconds >= 60');

  const occurrences = new Map(); // occurrenceKey → occurrence record
  let disabled = false;
  let counter = 0;

  return {
    scheduleId,
    intervalSeconds,
    intervals: INTERVALS,

    /**
     * Одно срабатывание. Никакого gtdId, если вызывающий не попросил явную
     * регистрацию на контроль (registerControl с reason/criteria/nextTrigger/
     * deadline/caps — иначе порт всё равно откажет).
     */
    fire({ at = clock() } = {}) {
      const occurrenceKey = occurrenceKeyFor({ scheduleId, at });
      if (occurrences.has(occurrenceKey)) {
        const existing = occurrences.get(occurrenceKey);
        return { status: 'duplicate', occurrenceKey, userTaskId: existing.userTaskId, created: false, gtdId: existing.gtdId };
      }
      if (disabled) {
        return { status: 'disabled', occurrenceKey, created: false, userTaskId: null, gtdId: null };
      }
      const userTaskId = userTaskIdFor({ scheduleId, occurrenceKey });
      const occurrence = {
        occurrenceKey,
        userTaskId,
        profileId: profileId || null,
        playbookId,
        firedAt: new Date(at).toISOString(),
        gtdId: null,
        gtdRegistration: null,
      };
      if (registerControl) {
        const registered = gtdPort.registerControl({ profileId, userTaskId, ...registerControl });
        if (registered.status === 'registered') {
          occurrence.gtdId = registered.gtdId;
          occurrence.gtdRegistration = { gtdId: registered.gtdId, reason: registered.record.reason };
        } else {
          occurrence.gtdRegistration = { status: registered.status, reason: registered.reason || null };
        }
      }
      occurrences.set(occurrenceKey, occurrence);
      return { status: 'fired', occurrenceKey, userTaskId, created: true, gtdId: occurrence.gtdId, occurrence: { ...occurrence } };
    },

    /** Выключение расписания ≠ отмена уже принятой задачи и ≠ закрытие контроля. */
    disable() {
      disabled = true;
      return { scheduleId, disabled: true, acceptedTasksUntouched: [...occurrences.values()].map(o => o.userTaskId) };
    },

    enable() {
      disabled = false;
      return { scheduleId, disabled: false };
    },

    /** Терминальный результат unmanaged-задачи: gtdId отсутствует, а не «пустой». */
    terminalResult(userTaskId) {
      const occurrence = [...occurrences.values()].find(candidate => candidate.userTaskId === userTaskId);
      if (!occurrence) return { userTaskId, known: false, gtdId: undefined, continuationOwner: 'output', reason: 'SCHEDULE_OCCURRENCE_UNKNOWN' };
      const underControl = Boolean(occurrence.gtdId);
      return {
        userTaskId,
        known: true,
        occurrenceKey: occurrence.occurrenceKey,
        // Ключ присутствует только для реально зарегистрированного контроля.
        ...(underControl ? { gtdId: occurrence.gtdId } : {}),
        continuationOwner: underControl ? 'gtd' : 'output',
        controlRegistration: occurrence.gtdRegistration,
      };
    },

    occurrences: () => [...occurrences.values()],
    count: () => occurrences.size,
    isDisabled: () => disabled,
    nextKeys: (from, times = 2) => {
      const out = [];
      let cursor = new Date(from).getTime();
      for (let i = 1; i <= times; i += 1) {
        cursor += intervalSeconds * 1000;
        out.push(occurrenceKeyFor({ scheduleId, at: new Date(cursor) }));
      }
      counter += times;
      return out;
    },
  };
}

module.exports = { INTERVALS, createSimpleSchedule, occurrenceKeyFor, userTaskIdFor };