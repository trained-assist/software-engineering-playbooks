#!/usr/bin/env node
'use strict';

// Z01 · T10 (issue software-engineering-playbooks#78): construction tasks are a REVIEW list, not
// a to-do list somebody owns. This entry point therefore has exactly two modes:
//
//   (default)  render the list from the coverage table and exit 0 WITHOUT opening an issue
//   --apply    refuse, with an explicit exit code, naming what a real apply has to do first
//
// Why not just call pr-autofix: its generator writes `applied: false` unconditionally — a good
// default that is invisible to the caller. Here the refusal is the observable behaviour, so a
// CI job or a script cannot believe it created work when it did not.
//
//   0 = dry-run rendered (no issue created)
//   7 = --apply refused (missing owner/review, or the tool has no apply path yet)

const fs = require('fs');
const path = require('path');

const APPLY_REFUSED = 7;

function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const k = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[k] = true; continue; }
    flags[k] = next; i++;
  }

  // The table lives in the repository that OWNS it (trained-agent-architecture/docs/inventory),
  // not here — a second copy in this repository would be a third thing to keep in sync. So the
  // path is always explicit rather than guessed.
  const table = typeof flags.table === 'string'
    ? path.resolve(flags.table)
    : (process.env.REPO_COVERAGE_TABLE ? path.resolve(process.env.REPO_COVERAGE_TABLE) : null);
  const prAutofix = typeof flags.tool === 'string' ? flags.tool : 'pr-autofix';

  if (flags.apply) {
    process.stderr.write(
      'refusing --apply: construction tasks are not applied by tooling yet.\n'
      + '  reason: an apply needs one owner per task and a reviewed task list; pr-autofix '
      + `${prAutofix} always renders applied:false.\n`
      + '  next:  open the coverage table, split the rows you accept into cards with owners, and\n'
      + '         record the decision in the tracking issue.\n',
    );
    return APPLY_REFUSED;
  }

  if (!table) {
    process.stderr.write('construction-tasks: no coverage table given.\n');
    process.stderr.write('  pass --table <repo-coverage.json> — the table is owned by trained-agent-architecture/docs/inventory\n');
    process.stderr.write('  (generate it with pr-autofix `inventory --profile-ref <ref> --strict`)\n');
    return 2;
  }
  if (!fs.existsSync(table)) {
    process.stderr.write(`construction-tasks: coverage table not found: ${table}\n`);
    return 2;
  }
  const data = JSON.parse(fs.readFileSync(table, 'utf8'));
  const rows = (data && data.repos) || [];
  const gaps = rows.filter((r) => r.readable && (
    !r.ci_present || (r.staging_required && !r.staging_present) || (r.fix && !r.fix.fixer_present)
  ));
  process.stdout.write(`construction-tasks: ${gaps.length} gap(s) across ${rows.length} repositories — dry run, NO issue created\n`);
  for (const g of gaps) {
    const why = [
      !g.ci_present ? 'no CI' : null,
      g.staging_required && !g.staging_present ? 'staging missing' : null,
      g.fix && !g.fix.fixer_present ? 'fixer missing' : null,
    ].filter(Boolean).join(', ');
    process.stdout.write(`  ${g.repo} — ${why}\n`);
  }
  return 0;
}

process.exitCode = main();