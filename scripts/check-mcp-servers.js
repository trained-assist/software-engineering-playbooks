#!/usr/bin/env node
'use strict';

// CLI for the MCP composition check.
//
// The check itself lives in src/mcp-servers/ (it is a library, so it can be
// unit-tested without spawning servers). This file only wires it to a command
// line:
//
//   node scripts/check-mcp-servers.js [--declaration mcp-servers.json]
//                                     [--host-config ~/.config/opencode/opencode.json]
//                                     [--no-probe] [--json]
//
// Exit code 0 = the declaration (and, when asked for, the host) is consistent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkComposition } = require('../src/mcp-servers');

const ROOT = path.join(__dirname, '..');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const HELP = `Usage: node scripts/check-mcp-servers.js [options]

  --declaration <file>   the composition declaration (default: mcp-servers.json)
  --host-config <file>   compare with a host config (e.g. ~/.config/opencode/opencode.json)
  --no-probe             do not start local MCP servers to compare their tool names
  --json                 machine-readable output
`;

function parseArgs(argv) {
  const args = { declaration: path.join(ROOT, 'mcp-servers.json'), hostConfig: null, probe: true, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--declaration') args.declaration = path.resolve(expandHome(argv[++i]));
    else if (arg === '--host-config') args.hostConfig = path.resolve(expandHome(argv[++i]));
    else if (arg === '--no-probe') args.probe = false;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let declaration;
  try {
    declaration = readJson(args.declaration);
  } catch (e) {
    console.error(`FAIL  cannot read ${args.declaration}: ${e.message}`);
    return 1;
  }

  let hostConfig = null;
  if (args.hostConfig) {
    try {
      hostConfig = readJson(args.hostConfig);
    } catch (e) {
      console.error(`FAIL  cannot read ${args.hostConfig}: ${e.message}`);
      return 1;
    }
  }

  // Without --host-config there is nothing to probe: the declared servers are
  // counted in-process instead (see src/mcp-servers/index.js).
  const result = await checkComposition({
    declaration,
    hostConfig,
    repoRoot: ROOT,
    probe: args.probe ? undefined : (async () => ({ ok: false, tools: [], error: 'probing disabled' })),
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2) + '\n');
  } else {
    for (const line of result.info) console.log(`info  ${line}`);
    for (const line of result.warnings) console.warn(`warn  ${line}`);
    for (const line of result.errors) console.error(`FAIL  ${line}`);
    console.log(result.errors.length
      ? `mcp-servers: failed with ${result.errors.length} error(s)`
      : `ok    mcp-servers — ${Object.keys(declaration.servers || {}).length} declared servers, no inconsistencies`);
  }
  return result.errors.length ? 1 : 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(`FAIL  ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
