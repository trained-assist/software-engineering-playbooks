'use strict';

// Отказы компилятора и рантайма плана (P24, эпик E5 #21, этап I07).
//
// Словарь не новый: `CAPABILITY_*`/`ARTIFACT_*`/`PLAYBOOK_*` приходят из
// src/playbook-artifacts/errors.js (P14) и переиспользуются как есть —
// переименование чужого кода было бы вторым словарём. Ниже только коды, которых
// в P14 нет: они относятся к compiled plan, шагам, гейтам и ожиданиям.

const { CapabilityError } = require('../playbook-artifacts/errors');

const PLAN_ERROR_CODES = [
  // Компиляция definition → plan
  'COMPILE_INPUT_MISSING',
  'COMPILE_UNRESOLVED_PLACEHOLDER',
  'COMPILE_NO_STEPS',
  'UNSUPPORTED_STEP_CONTRACT',
  'PROGRAMMATIC_HANDLER_UNRESOLVED',
  'SPLIT_POINT_NOT_FOUND',
  'MIGRATION_DEPENDENCY_INVALID',
  // Идентичность шагов и пины
  'STEP_NOT_FOUND',
  'STEP_ID_COLLISION',
  'RUNNING_STEP_IDS_CHANGED',
  'PLAN_DEFINITION_CHANGED',
  // Гейты и приёмка
  'GATE_NOT_DISABLEABLE',
  'ACCEPTANCE_STALE_EVIDENCE',
  'GATE_VIOLATION',
  // Ожидания и внешние операции
  'AWAITING_INPUT_NOT_OPEN',
  'AWAITING_INPUT_ALREADY_ANSWERED',
  'CONDITION_NOT_OPEN',
  'EXTERNAL_OPERATION_NOT_DISPATCHED',
  'EFFECT_STATE_UNKNOWN',
  // Попытки и прогрессия
  'ATTEMPT_CAP_EXHAUSTED',
  'STEP_NOT_READY',
  'STEP_ALREADY_TERMINAL',
  'PLAN_NOT_COMPILED',
  // Расписание и контроль
  'SCHEDULE_OCCURRENCE_UNKNOWN',
  'GTD_CONTROL_ALREADY_REGISTERED',
  'GTD_OUTCOME_REJECTED',
  'GTD_TRANSPORT_UNAVAILABLE',
];

class PlanError extends CapabilityError {
  constructor(code, message, details = {}) {
    super(code, message, details);
  }
}

module.exports = { PlanError, PLAN_ERROR_CODES };