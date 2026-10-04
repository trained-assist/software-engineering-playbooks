#!/usr/bin/env node
'use strict';

// Report — not gate — which shipped steps declare a `validation` key the runtime
// cannot evaluate. Owner decision (2026-10-03): report first, no hard gate yet.
//
// Why it matters: a step's `validation` keys are compiled into the plan's acceptance
// criteria, and `trained-assist-agent` can only evaluate keys that exist in
// `createDefaultRegistry()` (src/playbook-validators.js). An unknown key resolves to
// `inconclusive('no-validator')` — it never blocks the step, and under the default
// (soft) finalization it never blocked the plan either. That is how a step could
// report «✅ Шаг готов» with nothing behind it (#106, case 9a6854e4).
//
// The vocabulary lives here as a contract so this repo can report without importing
// the agent. Keep it in sync with
// `trained-assist-agent/src/playbook-validators.js` → `createDefaultRegistry()`;
// `scripts/check-action-manifest.js` does the same job for the action surface.
//
//   node scripts/check-validation-keys.js           # report, always exit 0
//   node scripts/check-validation-keys.js --strict   # exit 1 when something is unreachable

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEYS = path.join(ROOT, 'contracts', 'validation-keys.json');
const PLAYBOOKS = path.join(ROOT, 'playbooks');

function loadKeys() {
  try {
    const doc = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
    if (!Array.isArray(doc.keys) || !doc.keys.length) throw new Error('no keys[]');
    return new Set(doc.keys);
  } catch (e) {
    console.error(`validation-keys: cannot read ${path.relative(ROOT, KEYS)}: ${e.message}`);
    process.exit(1);
  }
}

function collect(registry) {
  const rows = [];
  for (const file of fs.readdirSync(PLAYBOOKS).filter(f => f.endsWith('.json')).sort()) {
    const playbook = JSON.parse(fs.readFileSync(path.join(PLAYBOOKS, file), 'utf8'));
    for (const stage of playbook.stages || []) {
      for (const step of stage.steps || []) {
        const keys = Object.keys(step.validation || {});
        const unreachable = keys.filter(k => !registry.has(k));
        rows.push({
          playbook: playbook.id,
          step: step.step_type,
          kind: step.execution_kind,
          keys,
          unreachable,
          // A step may declare itself advisory once the classification lands; today the
          // flag is read if present so the report stays useful when it arrives.
          advisory: step.advisory === true,
        });
      }
    }
  }
  return rows;
}

function main() {
  const strict = process.argv.includes('--strict');
  const registry = loadKeys();
  const rows = collect(registry);
  const gaps = rows.filter(r => r.unreachable.length > 0);
  const agentRows = rows.filter(r => r.kind === 'agent');
  const agentGaps = agentRows.filter(r => r.unreachable.length > 0);

  const unreachableKeys = new Set();
  for (const r of gaps) for (const k of r.unreachable) unreachableKeys.add(k);
  const uncoveredTypes = [...new Set(agentGaps.map(r => r.step))].sort();

  console.log(`validation-keys: ${registry.size} runtime keys, ${rows.length} steps ` +
    `(${agentRows.length} agent), ${agentGaps.length} agent step(s) with unreachable keys ` +
    `(${Math.round((agentGaps.length / Math.max(1, agentRows.length)) * 100)}%).`);
  if (!gaps.length) {
    console.log('validation-keys: every declared key is reachable.');
    return;
  }
  console.log(`validation-keys: ${unreachableKeys.size} distinct key(s) the runtime cannot evaluate:`);
  for (const k of [...unreachableKeys].sort()) console.log(`  - ${k}`);
  console.log(`validation-keys: step types affected (${uncoveredTypes.length}): ${uncoveredTypes.join(', ')}`);
  console.log('validation-keys: REPORT ONLY — no gate. A key becomes checkable either by adding it');
  console.log('validation-keys: to the agent registry, or by classifying the step as advisory with a');
  console.log('validation-keys: reason. See #106 (R1) and the owner decision of 2026-10-03.');

  if (strict && agentGaps.length) process.exit(1);
}

if (require.main === module) main();
module.exports = { collect, loadKeys };
