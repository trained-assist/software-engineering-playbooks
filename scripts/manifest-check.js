#!/usr/bin/env node
'use strict';

// Guards the externally visible provider manifest against drift from the MCP
// tool registry: every declared action must map to a real tool, and its
// required inputs must be a subset of the tool's own input schema. Registry
// tools that are intentionally not provider-exposed yet are warned about (the
// workspace tools are deferred provider-manifest packaging), never failed.

const fs = require('fs');
const path = require('path');
const registry = require('../src/mcp-skills/registry');

const MANIFEST = path.join(__dirname, '..', 'provider-manifest.json');
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  console.error(`manifest:check failed — cannot parse provider-manifest.json: ${e.message}`);
  process.exit(1);
}

check(typeof manifest.version === 'number', 'provider-manifest.json: version must be a number');
check(typeof manifest.providerId === 'string' && manifest.providerId.length > 0, 'provider-manifest.json: providerId is required');
check(Array.isArray(manifest.actions), 'provider-manifest.json: actions must be an array');

const toolByName = new Map(registry.listTools().map((t) => [t.name, t]));
const seen = new Set();
for (const action of asArray(manifest.actions)) {
  check(action && typeof action.name === 'string' && action.name.length > 0, 'provider-manifest.json: every action needs a name');
  if (!action || typeof action.name !== 'string') continue;
  check(!seen.has(action.name), `provider-manifest.json: duplicate action "${action.name}"`);
  seen.add(action.name);

  const tool = toolByName.get(action.name);
  if (!tool) {
    errors.push(`provider-manifest.json: action "${action.name}" has no registered MCP tool`);
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
}

for (const tool of registry.listTools()) {
  if (!seen.has(tool.name)) warnings.push(`registry tool "${tool.name}" is not in provider-manifest.json (not yet exposed)`);
}

for (const warning of warnings) console.warn(`warn  ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`FAIL  ${error}`);
  console.error(`manifest:check failed with ${errors.length} error(s)`);
  process.exit(1);
}
console.log(`ok    manifest:check — ${manifest.actions.length} actions, ${registry.listTools().length} registered tools`);
