'use strict';

// Ошибки домена playbook-артефактов (P14, эпик E5 #21, этап I04).
//
// Имена кодов CapabilityError — те же, что в P13
// (ai-agent-runner src/mcp/capabilities.ts, PR #46): второй набор терминов ради
// границы «playbooks ↔ runner» не заводим. Коды артефакта добавлены к тем же кодам,
// а не вместо них.

// Отказ хоста до исполнения handler'а (CAPABILITY_* / BINDING_* — как в P13).
const CAPABILITY_CODES = [
  'CAPABILITY_NOT_FOUND',
  'CAPABILITY_VERSION_UNKNOWN',
  'BINDING_SCOPE_MISSING',
  'BINDING_REQUIRED',
];

// Отказ разрешения pinned-артефакта: definition не найдена, версия не та, хеш не тот,
// артефакт не проходит контракт Playbook v1.
const ARTIFACT_CODES = [
  'PLAYBOOK_NOT_FOUND',
  'ARTIFACT_VERSION_MISMATCH',
  'ARTIFACT_HASH_MISMATCH',
  'ARTIFACT_SCHEMA_INVALID',
];

// Технические исходы внешнего эффекта. EFFECT_RECEIPT_MISSING — «ок» без
// проверяемой квитанции (ловушка PR-16), EFFECT_STATE_UNKNOWN — внешнее действие
// могло произойти, повтор вслепую запрещён (AC-118 / ловушка PR-04).
const EFFECT_CODES = [
  'EFFECT_RECEIPT_MISSING',
  'EFFECT_STATE_UNKNOWN',
  'PROVIDER_RECEIPT_MISSING',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNREACHABLE',
  'REPLAY_CONFLICT',
];

const CODES = [...CAPABILITY_CODES, ...ARTIFACT_CODES, ...EFFECT_CODES];

class CapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

function isCapabilityError(err) {
  return err instanceof CapabilityError || (err && typeof err.code === 'string' && CODES.includes(err.code));
}

module.exports = { CapabilityError, CODES, CAPABILITY_CODES, ARTIFACT_CODES, EFFECT_CODES, isCapabilityError };
