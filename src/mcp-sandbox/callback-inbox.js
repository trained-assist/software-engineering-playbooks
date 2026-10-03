'use strict';

// Inbox обратных вызовов внешнего сервиса (P15, эпик E5 #21, этап I04).
//
// Внешний сервис подтверждает действие не только квитанцией в ответе, но и отдельным
// обратным вызовом — и доставляет его повторно, если не получил подтверждение. В
// песочнице это настоящий HTTP POST в этот inbox (src/mcp-sandbox/transports/
// http-server.js), а не «запись в лог».
//
// Инвариант ровно один: эффект обратного вызова применяется один раз на операцию.
// Дедупликация по двум ключам — callbackId (тот же вызов пришёл повторно) и operationId
// (тот же эффект пришёл с новым идентификатором вызова). Повтор не создаёт второго
// действия и второго статус-сообщения: в status-леджере остаётся одна строка на
// операцию с исходным reply context.

const fs = require('fs');
const path = require('path');

const APPLIED_FILE = 'applied.jsonl';
const STATUS_FILE = 'status.jsonl';

const CALLBACK_KINDS = ['application.decision.recorded'];

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {object} options
 * @param {string} options.root изолированный каталог inbox'а
 * @param {object} [options.log] общий event log домена (P14-формат)
 * @param {() => Date} [options.clock]
 */
function createCallbackInbox({ root, log, clock = () => new Date() } = {}) {
  if (!root) throw new Error('callback inbox requires an isolated root');
  const appliedFile = path.join(root, APPLIED_FILE);
  const statusFile = path.join(root, STATUS_FILE);
  const seen = new Set(readLines(appliedFile).map(entry => entry.key));

  function keyFor(envelope) {
    return `${envelope.callbackId}::${envelope.operationId}`;
  }

  function apply(envelope = {}) {
    const callbackId = typeof envelope.callbackId === 'string' ? envelope.callbackId : null;
    const operationId = typeof envelope.operationId === 'string' ? envelope.operationId : null;
    const eventId = typeof envelope.eventId === 'string' ? envelope.eventId : null;
    const replyContext = envelope.replyContext || null;

    if (!callbackId || !operationId || !CALLBACK_KINDS.includes(envelope.kind)) {
      log?.write('callback.rejected', { callbackId, operationId, from: 'received', to: 'rejected', reasonCode: 'CALLBACK_REJECTED', detail: 'malformed callback envelope' });
      return { applied: false, duplicate: false, callbackId, operationId, reasonCode: 'CALLBACK_REJECTED' };
    }

    const key = keyFor(envelope);
    const duplicate = seen.has(key) || seen.has(`*::${operationId}`);
    if (duplicate) {
      log?.write('callback.duplicate_ignored', {
        callbackId,
        operationId,
        eventId,
        replyChannel: replyContext ? replyContext.channel : null,
        from: 'received',
        to: 'ignored',
        reasonCode: 'DUPLICATE_CALLBACK_IGNORED',
        detail: 'the effect of this operation was already applied; no second action, no second status message',
      });
      return { applied: false, duplicate: true, callbackId, operationId, reasonCode: 'DUPLICATE_CALLBACK_IGNORED' };
    }

    seen.add(key);
    seen.add(`*::${operationId}`);
    const applied = { key, callbackId, operationId, eventId, at: clock().toISOString() };
    appendLine(appliedFile, applied);

    const status = {
      operationId,
      callbackId,
      eventId,
      applicationId: envelope.applicationId || null,
      decision: envelope.decision || null,
      replyContext,
      at: applied.at,
    };
    appendLine(statusFile, status);

    log?.write('callback.applied', {
      callbackId,
      operationId,
      eventId,
      replyChannel: replyContext ? replyContext.channel : null,
      from: 'received',
      to: 'applied',
      reasonCode: 'CALLBACK_APPLIED',
      detail: 'exactly one status message for this operation',
    });

    return { applied: true, duplicate: false, callbackId, operationId, reasonCode: 'CALLBACK_APPLIED' };
  }

  return {
    root,
    apply,
    appliedCount: () => readLines(appliedFile).length,
    duplicateCount: () => (log ? log.entries.filter(entry => entry.event === 'callback.duplicate_ignored').length : 0),
    statusEntries: () => readLines(statusFile),
    appliedEntries: () => readLines(appliedFile),
  };
}

module.exports = { createCallbackInbox, APPLIED_FILE, STATUS_FILE, CALLBACK_KINDS };
