#!/usr/bin/env node
'use strict';

// Build `action-provider-manifest.json` — the contract the control plane actually
// consumes — out of `provider-manifest.json`, which is this repo's own richer
// manifest (v3: adds contextFields / connections).
//
// Why this file exists: `trained-assist-agent` looks for exactly
// `action-provider-manifest.json` (`src/skill-siblings.js` actionManifestPath,
// `scripts/check-skill-schedule.js`, `scripts/deploy.sh`). Until this repo shipped
// that filename, the engineering provider was INVISIBLE to the cron/action
// registry — all declared actions silently unregistered, and the deploy gate only
// warned «provider is not schedulable».
//
// The projection is deliberately v1 (`{version, providerId, actions}`) because that
// is the shape `ActionProviderRegistry.register()` accepts for a provider that
// declares no domain surface. This repo currently has EMPTY contextFields and
// connections, so nothing is lost. If they ever become non-empty, this script
// refuses instead of silently dropping them: core's v2 contract requires
// `contextFields` with minItems 1 and would need a real v2 manifest, not a v1 one.
//
//   node scripts/build-action-manifest.js           # write
//   node scripts/build-action-manifest.js --check   # fail if stale (CI)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'provider-manifest.json');
const TARGET = path.join(ROOT, 'action-provider-manifest.json');

function fail(message) {
  console.error(`action-manifest: ${message}`);
  process.exit(1);
}

function project(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('provider-manifest.json is not an object');
  if (!Array.isArray(manifest.actions)) fail('provider-manifest.json: actions must be an array');
  if (typeof manifest.providerId !== 'string' || !manifest.providerId) {
    fail('provider-manifest.json: providerId is required');
  }
  // Refuse rather than drop: a non-empty domain surface needs core's v2 contract.
  for (const key of ['contextFields', 'collections', 'connections', 'webSurfaces']) {
    const value = manifest[key];
    if (Array.isArray(value) && value.length > 0) {
      fail(
        `provider-manifest.json now declares a non-empty ${key} (${value.length}). ` +
        'The v1 projection below would drop it, and core\'s v2 contract requires ' +
        'contextFields minItems 1 — ship a real v2 action-provider-manifest.json ' +
        '(version: 2, contextFields: [...]) instead of extending this projection.',
      );
    }
  }
  const names = new Set();
  for (const action of manifest.actions) {
    if (!action || typeof action.name !== 'string') fail('every action needs a name');
    if (names.has(action.name)) fail(`duplicate action in provider-manifest.json: ${action.name}`);
    names.add(action.name);
    if (!action.inputSchema || typeof action.inputSchema !== 'object') {
      fail(`action ${action.name}: inputSchema is required — the core registry compiles it`);
    }
  }
  return { version: 1, providerId: manifest.providerId, actions: manifest.actions };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  } catch (e) {
    fail(`cannot parse provider-manifest.json: ${e.message}`);
  }
  const next = serialize(project(manifest));
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null;

  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error('action-manifest: action-provider-manifest.json is stale — run `npm run build:action-manifest`');
      process.exit(1);
    }
    console.log(`action-manifest: up to date (${manifest.actions.length} actions)`);
    return;
  }
  if (current === next) {
    console.log(`action-manifest: up to date (${manifest.actions.length} actions)`);
    return;
  }
  fs.writeFileSync(TARGET, next);
  console.log(`wrote action-provider-manifest.json (${manifest.actions.length} actions)`);
}

if (require.main === module) main();
module.exports = { project };
