#!/usr/bin/env node
'use strict';

// Build / refresh / check helper for the deterministic repository index (v1).
//
//   node scripts/index-repo.js --repo <path>            # build or refresh
//   node scripts/index-repo.js --repo <path> --check    # is the index usable?
//   node scripts/index-repo.js --repo <path> --json     # machine-readable
//
// A refresh is a full deterministic rebuild for now (nightly/incremental
// scheduling is an explicit non-goal for v1). The index is an optimization:
// consumers must fall back to raw-repo discovery when this says "not usable".

const { buildIndex, indexCompatibility } = require('../src/index');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function print(value, asJson) {
  process.stdout.write((asJson ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoPath = args.repo || args._[0];
  if (!repoPath) {
    console.error('usage: index-repo --repo <path> [--check] [--out <dir>] [--json]');
    process.exit(2);
  }

  if (args.check) {
    const status = indexCompatibility(repoPath);
    const summary = {
      command: 'check',
      repoPath,
      usable: status.usable,
      reason: status.reason,
      revision: status.meta ? status.meta.revision : null,
      schemaVersion: status.meta ? status.meta.schemaVersion : null,
      generatedAt: status.meta ? status.meta.generatedAt : null,
    };
    print(summary, args.json);
    process.exit(status.usable ? 0 : 1);
  }

  const index = buildIndex({ repoPath, outDir: args.out, generatedAt: args['generated-at'] });
  const summary = {
    command: 'build',
    root: index.root,
    revision: index.meta.revision,
    schemaVersion: index.meta.schemaVersion,
    generatedAt: index.meta.generatedAt,
    fileCount: index.meta.fileCount,
    symbolCount: index.meta.symbolCount,
    testCount: index.meta.testCount,
    hotspotCount: index.hotspots.length,
  };
  if (args.json) {
    print({ ...summary, languages: index.meta.languages }, true);
  } else {
    console.log(`index built: ${index.root}`);
    console.log(`revision:    ${index.meta.revision} (${index.meta.branch || 'detached'})`);
    console.log(`schema:      v${index.meta.schemaVersion} @ ${index.meta.generatedAt}`);
    console.log(`files:       ${index.meta.fileCount}  symbols: ${index.meta.symbolCount}  tests: ${index.meta.testCount}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`index-repo failed: ${e.message}`);
  process.exit(1);
}
