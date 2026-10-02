'use strict';

// Compile-time validation: every playbook step passes the runtime's own
// validation rules (vendored from trained-assist-agent). Catches:
// - missing executor_role/minimum_model_level/context_budget on agent steps
// - invalid wait constraints
// - unknown hook events
// - non-deterministic validator keys on wait steps

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAll } = require('../scripts/build-playbooks');
const { validateItem } = require('./helpers/validate-item');
const { validateHooks, TASK_HOOK_EVENTS, ITEM_HOOK_EVENTS } = require('./helpers/validate-hooks');
const { DETERMINISTIC_KEYS } = require('./helpers/validator-keys');

const { built } = buildAll();

for (const pb of built) {
  test(`${pb.id}: every compiled item passes validateItem`, () => {
    for (const stage of pb.stages) {
      for (const step of stage.steps) {
        assert.doesNotThrow(() => validateItem({
          ...step, stage: stage.id,
        }), `validateItem failed for "${step.title}" in stage "${stage.id}"`);
      }
    }
  });

  test(`${pb.id}: task-level hooks use valid events`, () => {
    if (pb.hooks) {
      validateHooks(pb.hooks, { where: `${pb.id} hooks`, events: TASK_HOOK_EVENTS });
    }
  });

  test(`${pb.id}: stage hooks use valid events`, () => {
    for (const stage of pb.stages) {
      const hooks = {};
      if (stage.on_enter) hooks.on_enter = stage.on_enter;
      if (stage.on_exit) hooks.on_exit = stage.on_exit;
      if (Object.keys(hooks).length) {
        validateHooks(hooks, { where: `${pb.id}/${stage.id}`, events: ['on_enter', 'on_exit'] });
      }
    }
  });

  test(`${pb.id}: step hooks use valid events`, () => {
    for (const stage of pb.stages) {
      for (const step of stage.steps) {
        const hooks = {};
        if (step.on_complete) hooks.on_complete = step.on_complete;
        if (step.on_fail) hooks.on_fail = step.on_fail;
        if (Object.keys(hooks).length) {
          validateHooks(hooks, { where: `${pb.id}/${step.title}`, events: ['on_complete', 'on_fail'] });
        }
      }
    }
  });

  test(`${pb.id}: wait steps have only deterministic validators`, () => {
    for (const stage of pb.stages) {
      for (const step of stage.steps) {
        if (step.wait) {
          for (const key of Object.keys(step.validation || {})) {
            assert.ok(
              DETERMINISTIC_KEYS.includes(key),
              `"${step.title}": wait step has non-deterministic validator "${key}" (wait can only poll deterministic keys)`
            );
          }
        }
      }
    }
  });

  test(`${pb.id}: no empty validator keys`, () => {
    for (const stage of pb.stages) {
      for (const step of stage.steps) {
        const keys = Object.keys(step.validation || {});
        assert.ok(keys.length > 0, `"${step.title}": has no validation keys`);
        for (const key of keys) {
          assert.ok(typeof key === 'string' && key.length > 0, `"${step.title}": empty validator key`);
        }
      }
    }
  });
}
