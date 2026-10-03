'use strict';

// Коды песочничного домена P15 (эпик E5 #21, этап I04, карточка #54).
//
// Второго словаря ошибок не заводим: CapabilityError, список capability-кодов и
// коды внешнего эффекта взяты из P13/P14 (src/playbook-artifacts/errors.js — копия
// контракта ai-agent-runner src/mcp/capabilities.ts, PR #46). Здесь добавлены только
// коды, которые нужны внешнему доменному сервису-эмулятору P15.

const {
  CapabilityError,
  isCapabilityError,
  CAPABILITY_CODES,
  ARTIFACT_CODES,
  EFFECT_CODES,
} = require('../playbook-artifacts/errors');

// Исходы внешнего сервиса, которых нет в P14: типизированная ошибка чтения/записи и
// отсутствующий ресурс. AUTH_EXPIRED намеренно НЕ код: истёкшая выдача — это blocked с
// человеческим текстом (решение владельца не подменяем машинным кодом для модели).
const PROVIDER_CODES = ['PROVIDER_ERROR', 'PROVIDER_NOT_FOUND', 'PROVIDER_STATE_UNREADABLE'];

const CODES = [...CAPABILITY_CODES, ...ARTIFACT_CODES, ...EFFECT_CODES, ...PROVIDER_CODES];

module.exports = {
  CapabilityError,
  isCapabilityError,
  CAPABILITY_CODES,
  ARTIFACT_CODES,
  EFFECT_CODES,
  PROVIDER_CODES,
  CODES,
};
