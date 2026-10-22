#!/usr/bin/env node
'use strict';

// Guards the externally visible provider manifests against drift from the MCP
// tool registries: every declared action must map to a real tool, and its
// required inputs must match the tool's own input schema.
//
// Two providers live in this repo and both are checked here:
//
//   provider-manifest.json            → the `engineering` provider.
//     Source of truth: src/mcp-skills/registry.js (the trained-assist-engineering
//     server, mounted by trained-assist-agent as the `engineering` sibling).
//
//   checklists-provider-manifest.json → the `engineering-checklists` provider.
//     Source of truth: src/mcp-checklists/index.js (the local, opt-in server).
//     It has its OWN providerId on purpose: the checklist surface is user-local
//     and opt-in, and merging it into the `engineering` provider would widen
//     the catalog trained-assist-agent registers for every host.
//
// Registry tools that are intentionally not provider-exposed yet are warned
// about (the workspace tools are deferred provider-manifest packaging), never
// failed.

const fs = require('fs');
const path = require('path');
const registry = require('../src/mcp-skills/registry');
const checklists = require('../src/mcp-checklists/index');

const ROOT = path.join(__dirname, '..');
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch (e) {
    console.error(`manifest:check failed — cannot parse ${file}: ${e.message}`);
    process.exit(1);
  }
}

// The checklists server declares its tools as plain MCP definitions; they are
// collected from the same list the server serves, so the manifest cannot
// drift from the wire format.
function checklistsTools() {
  return checklists.TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function validateManifest(manifest, file, toolByName, label) {
  check(typeof manifest.version === 'number', `${file}: version must be a number`);
  check(typeof manifest.providerId === 'string' && manifest.providerId.length > 0, `${file}: providerId is required`);
  check(Array.isArray(manifest.actions), `${file}: actions must be an array`);

  const seen = new Set();
  for (const action of asArray(manifest.actions)) {
    check(action && typeof action.name === 'string' && action.name.length > 0, `${file}: every action needs a name`);
    if (!action || typeof action.name !== 'string') continue;
    check(!seen.has(action.name), `${file}: duplicate action "${action.name}"`);
    seen.add(action.name);

    check(Array.isArray(action.allowedTriggers) && action.allowedTriggers.length > 0,
      `${file}: action "${action.name}" must declare a non-empty allowedTriggers array`);
    check(typeof action.effect === 'string' && action.effect.length > 0,
      `${file}: action "${action.name}" must declare effect`);
    check(typeof action.requiresApproval === 'boolean',
      `${file}: action "${action.name}" must declare requiresApproval`);
    check(typeof action.retrySafety === 'string' && action.retrySafety.length > 0,
      `${file}: action "${action.name}" must declare retrySafety`);

    const tool = toolByName.get(action.name);
    if (!tool) {
      errors.push(`${file}: action "${action.name}" has no registered MCP tool`);
      continue;
    }
    const schema = action.inputSchema || {};
    check(schema.type === 'object', `${action.name}: inputSchema.type must be "object"`);
    const declaredRequired = new Set(asArray(schema.required));
    const toolRequired = new Set(asArray(tool.inputSchema && tool.inputSchema.required));
    for (const field of declaredRequired) {
      check(toolRequired.has(field), `${action.name}: manifest requires "${field}" but the tool does not`);
    }
    for (const field of toolRequired) {
      check(declaredRequired.has(field), `${action.name}: tool requires "${field}" but the manifest does not declare it`);
    }
    const props = Object.keys((schema.properties) || {});
    for (const field of declaredRequired) {
      check(props.includes(field), `${action.name}: required field "${field}" missing from manifest properties`);
    }
    // Every property the manifest advertises must exist on the tool, otherwise
    // a consumer compiles a schema the server will reject.
    for (const field of props) {
      check(Object.prototype.hasOwnProperty.call((tool.inputSchema && tool.inputSchema.properties) || {}, field),
        `${action.name}: manifest property "${field}" is not in the tool schema`);
    }
  }

  for (const tool of toolByName.values()) {
    if (!seen.has(tool.name)) warnings.push(`${label} tool "${tool.name}" is not in the manifest (not yet exposed)`);
  }
  return manifest.actions.length;
}

const engineeringManifest = loadManifest('provider-manifest.json');
const engineeringTools = new Map(registry.listTools().map((t) => [t.name, t]));
const engineeringCount = validateManifest(engineeringManifest, 'provider-manifest.json', engineeringTools, 'engineering');

const checklistsManifest = loadManifest('checklists-provider-manifest.json');
const checklistsToolList = checklistsTools();
const checklistsMap = new Map(checklistsToolList.map((t) => [t.name, t]));
const checklistsCount = validateManifest(checklistsManifest, 'checklists-provider-manifest.json', checklistsMap, 'engineering-checklists');

// The two providers share one agent context: a duplicate tool NAME across them
// is a silent shadowing bug (the agent sees one of the two, not both).
const names = new Map();
for (const [name, source] of [[...engineeringTools.keys()].map(n => [n, 'engineering']), ...checklistsToolList.map(t => [t.name, 'engineering-checklists'])]) {
  if (names.has(name)) {
    errors.push(`duplicate tool name across providers: "${name}" (${names.get(name)} and ${source})`);
  } else {
    names.set(name, source);
  }
}

for (const warning of warnings) console.warn(`warn  ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`FAIL  ${error}`);
  console.error(`manifest:check failed with ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`ok    manifest:check — engineering: ${engineeringCount} actions / ${engineeringTools.size} tools, ` +
  `engineering-checklists: ${checklistsCount} actions / ${checklistsToolList.length} tools`);
