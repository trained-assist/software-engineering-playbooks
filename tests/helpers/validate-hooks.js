'use strict';

// Vendored from trained-assist-agent/src/playbook-hooks.js
// Keep in sync: diff this file against the agent's source on schema changes.
// Source: trained-assist-agent@2d3d19b (2026-09-28)

const HOOK_TYPES = ['notify', 'check', 'create_issue', 'publish'];
const TASK_HOOK_EVENTS = ['task_done', 'task_failed'];
const ITEM_HOOK_EVENTS = ['on_complete', 'on_fail', 'stage_enter', 'stage_exit'];

function validateHook(hook, where) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    throw new Error(`${where}: hook must be a non-array object`);
  }
  if (!HOOK_TYPES.includes(hook.type)) {
    throw new Error(`${where}: unknown hook type "${hook.type}" (valid: ${HOOK_TYPES.join(', ')})`);
  }
  if (hook.to != null && typeof hook.to !== 'string') {
    throw new Error(`${where}: hook "to" must be a string`);
  }
  if (hook.text != null && typeof hook.text !== 'string') {
    throw new Error(`${where}: hook "text" must be a string`);
  }
}

function validateHooks(hooks, { where = 'hooks', events = [] } = {}) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error(`${where}: hooks must be a non-array object`);
  }
  for (const [key, list] of Object.entries(hooks)) {
    if (events.length && !events.includes(key)) {
      throw new Error(`${where}: unknown hook event "${key}" (valid: ${events.join(', ')})`);
    }
    if (!Array.isArray(list)) {
      throw new Error(`${where}.${key}: hook list must be an array`);
    }
    list.forEach((h, i) => validateHook(h, `${where}.${key}[${i}]`));
  }
}

module.exports = { HOOK_TYPES, TASK_HOOK_EVENTS, ITEM_HOOK_EVENTS, validateHook, validateHooks };
