'use strict';

// Фейковый внешний доменный провайдер для записи выбора плейбука (P14, AC-116
// «мутация фейкового провайдера подтверждена receipt»).
//
// Это НЕ заглушка: он хранит состояние на диске под изолированным root, поэтому
// проверяется настоящий внешний эффект (файл записи) и настоящая идемпотентность по
// operationId. Значение credential binding'а проверяется на «не пусто» и уходит в
// провайдер, но не пишется в его storage и не попадает в квитанцию.
//
// Ключевое свойство (AC-118 / ловушка PR-04): внешний эффект happens-once по
// operationId. Повтор с тем же operationId и тем же payload возвращает ту же
// квитанцию и НЕ создаёт второй эффект; повтор с другим payload под тем же
// operationId — conflict, тоже без второго эффекта. Исход «эффект мог произойти, а
// квитанции нет» (fault 'timeout') не лечится слепым повтором: у провайдера есть
// reconcile по operationId.
//
// Метод возвращает status, а не бросает ожидаемые исходы: blocked/technical_error —
// это контракт handler'а (TASK-ROUTER-AND-MCP §11.4), а не исключение.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_DIR = 'selections';

// Инъекция управляемых сбоев песочницы. Ни один из них не требует сети.
const FAULT_MODES = ['none', 'timeout', 'no_receipt', 'expired_auth', 'unreachable'];

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function receiptIdFor(operationId, payloadHash) {
  return `rcpt_${crypto.createHash('sha256').update(`${operationId}:${payloadHash}`).digest('hex').slice(0, 16)}`;
}

function externalRefFor(operationId) {
  return `sel_${crypto.createHash('sha256').update(operationId).digest('hex').slice(0, 12)}`;
}

function readRecord(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.root изолированный каталог песочницы (обязателен: прод-хранилище неприкосновенно)
 * @param {() => Date} [options.clock]
 * @param {'none'|'timeout'|'no_receipt'|'expired_auth'|'unreachable'} [options.fault] управляемый сбой
 */
function createFakeSelectionProvider({ root, clock = () => new Date(), fault = 'none' } = {}) {
  if (!root) throw new Error('fake selection provider requires an isolated root (never a production data root)');
  if (!FAULT_MODES.includes(fault)) throw new Error(`unknown fault "${fault}"; expected one of ${FAULT_MODES.join('|')}`);

  const dir = path.join(root, STORE_DIR);

  function storeFor(operationId) {
    return path.join(dir, `${fingerprint({ operationId })}.json`);
  }

  function write(record) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(storeFor(record.operationId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  }

  function lookup(operationId) {
    const record = readRecord(storeFor(operationId));
    return record
      ? { found: true, applied: true, externalRef: record.externalRef, receiptId: record.receiptId, at: record.at }
      : { found: false, applied: false, externalRef: null, receiptId: null, at: null };
  }

  return {
    root,
    fault,
    storeDir: dir,
    lookup,
    count: () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')).length : 0),

    /**
     * Мутация выбора плейбука. Никогда не возвращает «просто ok»: без квитанции
     * вызывающий обязан получить technical_error (PR-16), а при неизвестном исходе —
     * EFFECT_STATE_UNKNOWN с reconcile-ссылкой на operationId.
     */
    recordSelection({ operationId, profileId, playbookId, playbookVersion, reason, bindingRef, bindingScope, bindingValue }) {
      if (!bindingValue) return { status: 'blocked', reason: 'credential binding value is empty; the provider cannot authenticate the write' };
      if (fault === 'unreachable') return { status: 'unreachable' };
      if (fault === 'expired_auth') return { status: 'blocked', reason: 'provider rejected the credential binding: expired' };

      const payload = { playbookId, playbookVersion: Number(playbookVersion), reason: String(reason || '') };
      const payloadHash = fingerprint(payload);
      const existing = readRecord(storeFor(operationId));

      // Эффект уже был — возвращаем ту же квитанцию, второй раз ничего не пишем.
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return { status: 'conflict', existingPayloadHash: existing.payloadHash, requestedPayloadHash: payloadHash };
        }
        return { status: 'replayed', receipt: existing.receipt, externalRecord: lookup(operationId) };
      }

      const record = {
        operationId,
        payloadHash,
        profileId,
        bindingRef,
        bindingScope,
        playbookId: payload.playbookId,
        playbookVersion: payload.playbookVersion,
        reason: payload.reason,
        receiptId: receiptIdFor(operationId, payloadHash),
        externalRef: externalRefFor(operationId),
        at: clock().toISOString(),
        receipt: { receiptId: receiptIdFor(operationId, payloadHash), externalRef: externalRefFor(operationId), at: clock().toISOString() },
      };
      // Эффект происходит ДО попытки выдать квитанцию: так ведёт себя внешний сервис,
      // и именно поэтому повтор вслепую опасен.
      write(record);

      if (fault === 'timeout') {
        return { status: 'unknown', externalRecord: lookup(operationId), receipt: null };
      }
      if (fault === 'no_receipt') {
        return { status: 'acknowledged_without_receipt', externalRecord: lookup(operationId), receipt: null };
      }
      return { status: 'applied', receipt: { receiptId: record.receiptId, externalRef: record.externalRef, at: record.at }, externalRecord: lookup(operationId) };
    },
  };
}

module.exports = { createFakeSelectionProvider, FAULT_MODES, STORE_DIR };
