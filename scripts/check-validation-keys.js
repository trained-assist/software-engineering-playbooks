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
// The vocabulary lives in `contracts/validation-keys.json` so this repo can report
// without importing the agent. `--against-agent <dir>` checks that snapshot against
// the agent's real registry, so the report can never quietly lie.
//
//   node scripts/check-validation-keys.js                     # report the real playbooks
//   node scripts/check-validation-keys.js --json              # machine-readable
//   node scripts/check-validation-keys.js --strict            # exit 1 on UNCLASSIFIED gaps
//   node scripts/check-validation-keys.js --against-agent DIR # warn if the snapshot drifted
//   node scripts/check-validation-keys.js --against-agent DIR --strict  # fail on drift
//
// `--playbooks DIR --keys FILE` point the report at fixtures — that is how the tests
// replay it deterministically.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_KEYS = path.join(ROOT, 'contracts', 'validation-keys.json');
const DEFAULT_PLAYBOOKS = path.join(ROOT, 'playbooks');

function loadKeys(file = DEFAULT_KEYS) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.keys) || !doc.keys.length) throw new Error(`${file}: keys[] is empty`);
  return new Set(doc.keys);
}

function readPlaybooks(dir = DEFAULT_PLAYBOOKS) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// Pure: playbooks + registry → what is checkable and what is not. No printing, no exit.
function analyze({ playbooksDir = DEFAULT_PLAYBOOKS, keysFile = DEFAULT_KEYS, registry = null } = {}) {
  const reg = registry || loadKeys(keysFile);
  const steps = [];
  for (const playbook of readPlaybooks(playbooksDir)) {
    for (const stage of playbook.stages || []) {
      for (const step of stage.steps || []) {
        const keys = Object.keys(step.validation || {});
        const unreachable = keys.filter(k => !reg.has(k));
        steps.push({
          playbook: playbook.id,
          stage: stage.id,
          step: step.step_type,
          kind: step.execution_kind,
          advisory: step.advisory === true,
          keys,
          unreachable,
        });
      }
    }
  }
  const agent = steps.filter(s => s.kind === 'agent');
  const withGap = steps.filter(s => s.unreachable.length > 0);
  const agentWithGap = agent.filter(s => s.unreachable.length > 0);
  // An advisory step is intentionally unclassified (R1: «intentional advisory явно
  // маркируется»); everything else is a gap still waiting for a decision.
  const advisory = agentWithGap.filter(s => s.advisory);
  const unclassified = agentWithGap.filter(s => !s.advisory);
  const unreachableKeys = new Set();
  for (const s of withGap) for (const k of s.unreachable) unreachableKeys.add(k);
  return {
    registrySize: reg.size,
    total: steps.length,
    agentSteps: agent.length,
    stepsWithGap: withGap.length,
    agentStepsWithGap: agentWithGap.length,
    unclassified: unclassified.length,
    advisory: advisory.length,
    percentUnclassified: Math.round((unclassified.length / Math.max(1, agent.length)) * 100),
    unreachableKeys: [...unreachableKeys].sort(),
    unclassifiedTypes: [...new Set(unclassified.map(s => s.step))].sort(),
    advisoryTypes: [...new Set(advisory.map(s => s.step))].sort(),
    steps,
  };
}

// The agent's real registry keys, from `createDefaultRegistry()` — used only to check
// the snapshot above. A regex over the returned object literal, deliberately not an
// import: this repo has no agent dependency and must run in CI without one.
function extractAgentKeys(agentDir) {
  const file = path.join(agentDir, 'src', 'playbook-validators.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('function createDefaultRegistry');
  if (start < 0) throw new Error(`${file}: createDefaultRegistry() not found`);
  const body = src.slice(start, src.indexOf('\n}', start));
  const keys = new Set();
  for (const m of body.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)) keys.add(m[1]);
  if (!keys.size) throw new Error(`${file}: no registry keys extracted`);
  return keys;
}

function diffKeys(contractKeys, agentKeys) {
  return {
    missingInContract: [...agentKeys].filter(k => !contractKeys.has(k)).sort(),
    staleInContract: [...contractKeys].filter(k => !agentKeys.has(k)).sort(),
  };
}

function formatReport(a) {
  const lines = [];
  lines.push(`validation-keys: ${a.registrySize} runtime keys, ${a.total} steps (${a.agentSteps} agent)`);
  lines.push(`validation-keys: ${a.unclassified} agent step(s) UNCLASSIFIED with unreachable keys ` +
    `(${a.percentUnclassified}% of agent steps)${a.advisory ? `, ${a.advisory} explicitly advisory` : ''}`);
  if (!a.unreachableKeys.length) {
    lines.push('validation-keys: every declared key is reachable.');
    return lines.join('\n');
  }
  lines.push(`validation-keys: ${a.unreachableKeys.length} distinct key(s) the runtime cannot evaluate:`);
  for (const k of a.unreachableKeys) lines.push(`  - ${k}`);
  lines.push(`validation-keys: unclassified step types (${a.unclassifiedTypes.length}): ${a.unclassifiedTypes.join(', ')}`);
  if (a.advisoryTypes.length) lines.push(`validation-keys: advisory step types (${a.advisoryTypes.length}): ${a.advisoryTypes.join(', ')}`);
  lines.push('validation-keys: REPORT ONLY by default — a key becomes checkable by adding it to the');
  lines.push('validation-keys: agent registry, or by marking the step `advisory: true` with a reason.');
  lines.push('validation-keys: See #106 (R1) and the owner decision of 2026-10-03.');
  return lines.join('\n');
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv;
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');
  const playbooksDir = argValue(argv, '--playbooks') || DEFAULT_PLAYBOOKS;
  const keysFile = argValue(argv, '--keys') || DEFAULT_KEYS;
  const againstAgent = argValue(argv, '--against-agent');

  let analysis;
  try {
    analysis = analyze({ playbooksDir, keysFile });
  } catch (e) {
    console.error(`validation-keys: ${e.message}`);
    process.exit(1);
  }

  let drift = null;
  if (againstAgent) {
    try {
      drift = diffKeys(loadKeys(keysFile), extractAgentKeys(againstAgent));
    } catch (e) {
      console.error(`validation-keys: cannot read the agent registry: ${e.message}`);
      process.exit(1);
    }
  }

  if (json) {
    console.log(JSON.stringify({ ...analysis, steps: undefined, drift }, null, 2));
  } else {
    console.log(formatReport(analysis));
    if (drift && (drift.missingInContract.length || drift.staleInContract.length)) {
      console.log(`::warning::validation-keys snapshot drifted from the agent registry — ` +
        `missing: ${drift.missingInContract.join(',') || 'none'}; stale: ${drift.staleInContract.join(',') || 'none'}`);
      console.log(`validation-keys: agent has ${drift.missingInContract.length} key(s) this snapshot lacks, ` +
        `and ${drift.staleInContract.length} key(s) it no longer has. Update contracts/validation-keys.json.`);
    } else if (drift) {
      console.log('validation-keys: snapshot matches the agent registry.');
    }
  }

  // --strict fails on UNCLASSIFIED gaps (advisory ones are the intended end-state) and
  // on registry drift when --against-agent was given. The default never fails.
  if (strict && (analysis.unclassified > 0 || (drift && (drift.missingInContract.length || drift.staleInContract.length)))) {
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { analyze, loadKeys, readPlaybooks, extractAgentKeys, diffKeys, formatReport };
