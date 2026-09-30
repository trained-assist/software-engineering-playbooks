'use strict';

// Vendored copy of CI log compression from trained-assist/pr-autofix
// scripts/autofix.mjs @ 0e36f2e (2026-09-29) — LOG_TOKEN_BUDGET, LOG_ERROR_RE,
// estTokens, compressLog.
//
// Why a copy and not an import: scripts/autofix.mjs is an ESM script that runs
// top-level code on import (it is a CLI, not a library), so requiring it would
// execute the whole autofix run. The function itself is pure and stable.
//
// KEEP IN SYNC: when pr-autofix's compressLog changes, re-vendor here and re-run
// tests/compress-log.test.js (the parity assertions are the drift alarm).
//
// Raw Actions job logs are mostly runner noise: ISO timestamps on every line,
// ANSI colours, ##[group] blocks with env dumps and setup chatter, post-job
// cleanup. Strip that, keep step headers ("Run npm test") and step output, then
// fit the budget keeping error-looking lines and their neighbourhood first, the
// tail next. Order is preserved.

const LOG_TOKEN_BUDGET = 2500;
const LOG_CHAR_LIMIT = 120000; // raw log cap BEFORE compressLog
const LOG_ERROR_RE = /(error|fail|not ok|assert|expected|received|actual|exception|traceback|panic|cannot|undefined|denied|missing|exit code [1-9]|✗|✖|×)/i;

const estTokens = s => Math.ceil(String(s).length / 4);

function compressLog(raw, budgetTokens = LOG_TOKEN_BUDGET) {
  const lines = [];
  let inGroup = false, seen = new Set(), sawStep = false;
  for (let l of String(raw || '').split('\n')) {
    l = l.replace(/^\uFEFF/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').trimEnd();
    if (/^##\[group\]/.test(l)) {
      inGroup = true;
      const step = l.replace(/^##\[group\]/, '');
      if (/^Run /.test(step)) { lines.push(`▶ ${step.slice(0, 160)}`); sawStep = true; }
      continue;
    }
    if (/^##\[endgroup\]/.test(l)) { inGroup = false; continue; }
    if (inGroup || !l.trim()) continue;
    if (/^Post job cleanup|^Cleaning up orphan processes/.test(l)) break;
    if (/^(=== job: )/.test(l)) { lines.push(l); sawStep = false; continue; }
    // Runner preamble before the first step (versions, action downloads).
    if (!sawStep && !LOG_ERROR_RE.test(l)) continue;
    // Collapse exact repeats (retry spam, progress bars).
    if (seen.has(l) && !LOG_ERROR_RE.test(l)) continue;
    seen.add(l);
    lines.push(l.replace(/^##\[error\]/, 'ERROR: ').slice(0, 400));
  }
  const text = lines.join('\n');
  if (estTokens(text) <= budgetTokens) return text;
  // Over budget: error lines ±3 first, then fill from the tail backwards.
  const keep = new Array(lines.length).fill(false);
  let used = 0;
  const take = i => { if (keep[i]) return true; const t = estTokens(lines[i]) + 1; if (used + t > budgetTokens) return false; keep[i] = true; used += t; return true; };
  lines.forEach((l, i) => { if (/^(▶ |=== job: )/.test(l)) take(i); });
  outer: for (let i = lines.length - 1; i >= 0; i--) {
    if (!LOG_ERROR_RE.test(lines[i])) continue;
    for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) if (!take(k)) break outer;
  }
  for (let i = lines.length - 1; i >= 0; i--) if (!take(i)) break;
  const out = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out[out.length - 1] !== '  …') out.push('  …');
  });
  return out.join('\n');
}

module.exports = { compressLog, estTokens, LOG_TOKEN_BUDGET, LOG_CHAR_LIMIT, LOG_ERROR_RE };
