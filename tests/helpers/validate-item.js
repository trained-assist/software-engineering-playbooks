'use strict';

// Vendored from trained-assist-agent/src/durable-task-plan.js
// Keep in sync: diff this file against the agent's source on schema changes.
// Source: trained-assist-agent@2d3d19b (2026-09-28)

const ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];
const LEVELS = ['bachelor', 'master', 'doctor'];
const BUDGETS = ['small', 'medium', 'large'];

function validateItem(item) {
  if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new Error('item title required');
  if (!['agent', 'programmatic'].includes(item.execution_kind)) throw new Error('invalid execution_kind');
  for (const [key, values] of [['executor_role', ROLES], ['minimum_model_level', LEVELS], ['context_budget', BUDGETS]]) {
    if (item.execution_kind === 'programmatic' && item[key] == null) continue;
    if (!values.includes(item[key])) throw new Error(`invalid ${key}`);
  }
  if (!item.validation || typeof item.validation !== 'object' || Array.isArray(item.validation) || !Object.keys(item.validation).length) {
    throw new Error('item validation required');
  }
  for (const key of ['delay_after_sec', 'max_attempts', 'execution_timeout_seconds']) {
    if (item[key] != null && (!Number.isSafeInteger(item[key]) || item[key] < (key === 'delay_after_sec' ? 0 : 1))) {
      throw new Error(`invalid ${key}`);
    }
  }
  if (item.wait != null) {
    if (item.execution_kind !== 'programmatic') throw new Error('wait is only allowed on programmatic steps');
    if (typeof item.wait !== 'object' || Array.isArray(item.wait)) throw new Error('invalid wait');
    for (const key of ['poll_every_sec', 'timeout_sec']) {
      if (!Number.isSafeInteger(item.wait[key]) || item.wait[key] < 60) throw new Error(`invalid wait.${key}`);
    }
  }
}

module.exports = { validateItem, ROLES, LEVELS, BUDGETS };
