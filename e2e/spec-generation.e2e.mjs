#!/usr/bin/env node
'use strict';

// Standalone end-to-end run of the spec-generation scenario (slice S5, R12).
//
// The loop itself lives in scripts/sandbox/spec-generation.mjs — one source of
// truth for Layer A (deterministic contract) and Layer B (real `opencode`
// generates spec/long.md + spec/short.md, structural checks, optional LLM
// judge). This entry point exists so `npm run test:e2e` is a separate, citable
// command for CI and for the acceptance record, and so a missing environment
// turns into an EXPLICIT skip (exit 0), never a silent green.
//
// Skip (exit 0, printed): no `opencode` binary or no OPENROUTER_API_KEY.
// Failure inside the loop exits 1 — a red loop is never converted to green.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SANDBOX = path.join(REPO, 'scripts', 'sandbox', 'spec-generation.mjs');

function which(bin) {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}

const reasons = [];
if (!which('opencode')) reasons.push('opencode не найден в PATH');
if (!fs.existsSync(SANDBOX)) reasons.push(`нет петли ${path.relative(REPO, SANDBOX)}`);

if (reasons.length) {
  console.log('[e2e] SKIPPED по отсутствию окружения: ' + reasons.join('; '));
  console.log('[e2e] SKIP');
  process.exit(0);
}

console.log('[e2e] прогон полной петли (Layer A + Layer B) через scripts/sandbox/spec-generation.mjs');
const res = spawnSync(process.execPath, [SANDBOX], {
  cwd: REPO,
  stdio: 'inherit',
  env: { ...process.env, SANDBOX_E2E: '1' },
});
process.exit(res.status === null ? 1 : res.status);
