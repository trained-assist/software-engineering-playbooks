#!/usr/bin/env node
'use strict';

// Report — not gate — whether a reconciliation receipt is an honest one (#135).
//
// Owner decision (2026-10-03, same as scripts/check-validation-keys.js): report first,
// no hard gate. What this CLI adds over a prose instruction is that the two facts cannot
// be swapped any more: `code=merged baseline=pending` is a valid, reportable state, and a
// baseline claimed `applied` without a commit, without paths, with an unapplied delta or
// with a recorded conflict is a lie the step can no longer state quietly.
//
//   node scripts/check-reconciliation.js receipt.json            # human report
//   node scripts/check-reconciliation.js receipt.json --json     # machine-readable
//   node scripts/check-reconciliation.js a.json b.json --strict  # exit 1 on violations
//   node scripts/check-reconciliation.js receipt.json --against-schema contracts/reconciliation-receipt.schema.json
//
// Exit code: 0 unless --strict and something is wrong.

const fs = require('fs');
const path = require('path');
const { validate, summarizeReceipt } = require('../src/reconciliation/receipt');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SCHEMA = path.join(ROOT, 'contracts', 'reconciliation-receipt.schema.json');

function loadReceipt(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function compareSchema(schemaPath = DEFAULT_SCHEMA) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const p = schema.properties || {};
  const enums = {
    'code_delivery.state': ((p.code_delivery && p.code_delivery.properties.state || {}).enum) || [],
    'baseline.state': ((p.baseline && p.baseline.properties.state || {}).enum) || [],
    'delta.kind': ((p.delta && p.delta.items && p.delta.items.properties.kind || {}).enum) || [],
    'target.kind': (((p.delta && p.delta.items && p.delta.items.properties.target || {}).properties || {}).kind || {}).enum || [],
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  return { schema: path.basename(schemaPath), required, enums };
}

function schemaDrift(report, mod) {
  const drift = [];
  const expected = {
    'code_delivery.state': mod.CODE_DELIVERY_STATES,
    'baseline.state': mod.BASELINE_STATES,
    'delta.kind': mod.DELTA_KINDS,
    'target.kind': mod.TARGET_KINDS,
  };
  for (const [field, values] of Object.entries(expected)) {
    const inSchema = report.enums[field] || [];
    const same = inSchema.length === values.length && inSchema.every((v, i) => v === values[i]);
    if (!same) drift.push({ field, schema: inSchema, module: values });
  }
  return drift;
}

function formatReport(results, report, drift) {
  const lines = [];
  for (const r of results) {
    lines.push(`${r.file}: ${r.summary}`);
    lines.push(`  verdict: ${r.ok ? 'ok — receipt is self-consistent' : `NOT HONEST — ${r.violations.length} violation(s)`}`);
    for (const v of r.violations) {
      const where = v.requirement_id ? ` [${v.requirement_id}]` : (v.field ? ` [${v.field}]` : '');
      lines.push(`  - ${v.code}${where}: ${v.message}`);
    }
  }
  lines.push(`contract: ${report.schema} requires ${report.required.join(', ')}`);
  if (drift && drift.length) {
    for (const d of drift) lines.push(`::warning::${d.field} drifted between schema and module: schema=[${d.schema}] module=[${d.module}]`);
  } else if (drift) {
    lines.push('contract: schema and module agree on every enumerated state.');
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const files = [];
  let json = false;
  let strict = false;
  let checkSchema = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '--against-schema') { checkSchema = true; i++; }
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else files.push(a);
  }
  if (!files.length) {
    console.error('usage: node scripts/check-reconciliation.js <receipt.json ...> [--json] [--strict] [--against-schema FILE]');
    process.exit(2);
  }

  const mod = require('../src/reconciliation/receipt');
  const report = compareSchema(argv[argv.indexOf('--against-schema') + 1] || DEFAULT_SCHEMA);
  const drift = checkSchema ? schemaDrift(report, mod) : null;

  const results = [];
  for (const file of files) {
    let receipt;
    try {
      receipt = loadReceipt(file);
    } catch (err) {
      results.push({ file, ok: false, summary: `receipt: unreadable (${err.message})`, violations: [{ code: 'RECEIPT_UNREADABLE', message: err.message }], facts: null });
      continue;
    }
    const { ok, violations, facts, summary } = validate(receipt);
    results.push({ file, ok, violations, facts, summary });
  }

  const problems = results.filter(r => !r.ok).length + (drift ? drift.length : 0);
  if (json) console.log(JSON.stringify({ results, contract: report, drift }, null, 2));
  else console.log(formatReport(results, report, drift));

  if (strict && problems) {
    console.log(`reconciliation: ${problems} problem(s).`);
    process.exit(1);
  }
  if (!problems) console.log('reconciliation: nothing dishonest found.');
}

if (require.main === module) main();
module.exports = { main, compareSchema, schemaDrift };