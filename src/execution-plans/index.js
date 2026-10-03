'use strict';

// Публичная поверхность модуля compiled plan (P24, эпик E5 #21, этап I07).
//
// Слои (границы §13: plan compiler/runtime может быть переиспользуемым пакетом):
//
//   compiler.js     pinned definition → Execution Plan (стабильные stepId);
//   adaptation.js   feature/integration split + migration dependency;
//   gates.js        обязательные гейты, inconclusive ≠ failed, приёмка по свежему evidence;
//   executor.js     фейковый исполнитель: 5 типов исходов, неизменные U/G ID;
//   providers/cloud-ci.js  синтетический облачный CI (dispatch один раз);
//   gtd-port.js     граница с GTD Manager из P23 (opt-in контроль, ACK, одно решение);
//   schedule.js     простое расписание без GTD;
//   checklist.js    view над planId;
//   runtime.js      состояние шагов, durable ожидания, отчётность GTD, логи;
//   step-identity.js stepId/stepKey/пин и инвариант «правка не меняет running step IDs».
//
// Модуль НЕ запускает агентов, не ходит в сеть и не знает про MCP: это
// планирование и исполнение шагов по контракту Playbook v1.

const { CapabilityError, isCapabilityError } = require('../playbook-artifacts/errors');
const { PLAN_ERROR_CODES, PlanError } = require('./errors');
const { adaptFeatureIntegrationSplit, planSetOf } = require('./adaptation');
const { compilePlan, hashBytes, planIdFor, PROGRAMMATIC_HANDLERS, EXTERNAL_OPERATIONS } = require('./compiler');
const { createFakeExecutor, OUTCOMES } = require('./executor');
const { createGtdPort, createInProcessGtdTransport, decide } = require('./gtd-port');
const { createPlanRuntime } = require('./runtime');
const { createSimpleSchedule } = require('./schedule');
const { createCloudCiProvider } = require('./providers/cloud-ci');
const { evaluateAcceptance, evaluateStepGate, precheckAlreadyDone, setGatePolicy, GATE_RESULTS } = require('./gates');
const { assertRunningStepsUnchanged, diffPlans, findStep, stepFingerprint, stepIdOf, stepKeyOf } = require('./step-identity');
const { viewChecklist } = require('./checklist');

module.exports = {
  CapabilityError,
  GATE_RESULTS,
  OUTCOMES,
  PLAN_ERROR_CODES,
  PlanError,
  PROGRAMMATIC_HANDLERS,
  EXTERNAL_OPERATIONS,
  adaptFeatureIntegrationSplit,
  assertRunningStepsUnchanged,
  compilePlan,
  createCloudCiProvider,
  createFakeExecutor,
  createGtdPort,
  createInProcessGtdTransport,
  createPlanRuntime,
  createSimpleSchedule,
  decide,
  diffPlans,
  evaluateAcceptance,
  evaluateStepGate,
  findStep,
  hashBytes,
  isCapabilityError,
  planIdFor,
  planSetOf,
  precheckAlreadyDone,
  setGatePolicy,
  stepFingerprint,
  stepIdOf,
  stepKeyOf,
  viewChecklist,
};