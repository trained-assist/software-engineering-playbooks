#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { constructionTasks } = require('../src/pr-autofix/construction');
const { resolveGithubCapability } = require('../src/pr-autofix/installer');
async function main() {
  const flags = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i].replace(/^--/, '');
    flags[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  }
  if (typeof flags.table !== 'string' || typeof flags.tool !== 'string') throw Error('--table and --tool (pinned pr-autofix checkout) are required');
  const tableBytes = fs.readFileSync(flags.table);
  const table = JSON.parse(tableBytes);
  const { buildConstructionTasks } = await import(pathToFileURL(path.resolve(flags.tool, 'scripts/lib/devbaseline/construction-tasks.mjs')).href);
  const tasks = buildConstructionTasks(table.repos);
  const apply = flags.apply === true;
  const reviewed = typeof flags.review === 'string' ? JSON.parse(fs.readFileSync(flags.review)) : null;
  if (apply && typeof flags.receipts !== 'string') throw Error('--receipts is required for durable apply evidence');
  const result = await constructionTasks({ tableBytes, tasks, reviewed, apply,
    github: apply ? resolveGithubCapability() : null,
    onReceipt: r => fs.appendFileSync(flags.receipts, JSON.stringify(r) + '\n'),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(e => { process.stderr.write(`${e.code || 'ERROR'}: ${e.message}\n`); process.exitCode = 7; });
