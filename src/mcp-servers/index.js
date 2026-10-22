'use strict';

// The declared MCP composition of this stack, and the check that keeps the host
// honest about it.
//
// Two failure modes made the composition invisible before (issue #164):
//
//   1. The host started the engineering servers from a WORKING TREE with
//      uncommitted changes. The running server was a state that exists
//      nowhere else, could not be reproduced, and silently changed shape
//      depending on what happened to be on disk.
//
//   2. Two servers published the SAME tool names (`search_serp_free`,
//      `search_serper`). The agent saw one of the two — which one depended on
//      server start order, not on intent.
//
// The declaration (`mcp-servers.json`) says which servers compose the stack,
// what each one is for, which repository and revision it runs, and how many
// tools it publishes. The check compares that declaration with the host
// configuration and with the catalogs the servers actually serve.

const fs = require('fs');
const path = require('path');
const { checkoutState, resolveRef, normalizeRepository } = require('./git');
const { probeTools } = require('./probe');

const THIS_REPOSITORY = 'trained-assist/software-engineering-playbooks';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// The tool lists of the servers this repository owns, counted in-process (no
// spawn, no network) so the declaration can be checked anywhere.
const OWNED_TOOL_SOURCES = {
  'src/mcp-skills/index.js': () => require('../mcp-skills/registry').listTools().map(t => t.name),
  'src/mcp-checklists/index.js': () => require('../mcp-checklists/index').TOOLS.map(t => t.name),
};

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isTag(value) {
  return typeof value === 'string' && value.length > 0 && !isSha(value);
}

function isRepository(value) {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function hostServerDisabled(server) {
  return Boolean(server && server.disabled);
}

// The path of the server script inside its checkout: the host starts
// `node /abs/path/to/checkout/src/mcp-skills/index.js`.
function entrypointOf(command) {
  if (!Array.isArray(command)) return null;
  const last = command[command.length - 1];
  return typeof last === 'string' ? last : null;
}

function checkoutRootFor(entrypointPath, declaredEntrypoint) {
  if (!entrypointPath || !declaredEntrypoint) return null;
  const normalized = entrypointPath.replace(/\\/g, '/');
  const suffix = '/' + declaredEntrypoint.replace(/^\/+/, '');
  const index = normalized.lastIndexOf(suffix);
  if (index < 0) return null;
  return normalized.slice(0, index) || '/';
}

function validateDeclaration(declaration, { repoRoot }) {
  const errors = [];
  const warnings = [];
  const info = [];

  if (!declaration || typeof declaration !== 'object') {
    errors.push('mcp-servers.json: the declaration must be a JSON object');
    return { errors, warnings, info, servers: {} };
  }
  if (typeof declaration.version !== 'number') errors.push('mcp-servers.json: version must be a number');
  if (!declaration.servers || typeof declaration.servers !== 'object' || Array.isArray(declaration.servers)) {
    errors.push('mcp-servers.json: servers must be an object');
    return { errors, warnings, info, servers: {} };
  }

  const names = Object.keys(declaration.servers);
  if (names.length === 0) errors.push('mcp-servers.json: at least one server must be declared');

  for (const name of names) {
    const server = declaration.servers[name];
    const where = `mcp-servers.json: server "${name}"`;
    if (!server || typeof server !== 'object') {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (server.type !== 'local' && server.type !== 'remote') {
      errors.push(`${where} must declare type "local" or "remote"`);
    }
    if (typeof server.role !== 'string' || server.role.trim().length === 0) {
      errors.push(`${where} must declare a role (what the server is for)`);
    }
    if (typeof server.enabled !== 'boolean') {
      errors.push(`${where} must declare enabled (true/false)`);
    }
    if (server.providerId !== null && typeof server.providerId !== 'string') {
      errors.push(`${where} providerId must be a string or null`);
    }
    if (server.expectedToolCount !== null && typeof server.expectedToolCount !== 'number') {
      errors.push(`${where} expectedToolCount must be a number or null`);
    }

    const source = server.source;
    if (!source || typeof source !== 'object') {
      errors.push(`${where} must declare a source`);
      continue;
    }
    if (server.type === 'remote') {
      if (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url)) {
        errors.push(`${where} must declare source.url (http(s) URL)`);
      }
      continue;
    }

    if (!isRepository(source.repository)) {
      errors.push(`${where} must declare source.repository as "org/repo"`);
    }
    if (typeof source.entrypoint !== 'string' || !source.entrypoint.trim()) {
      errors.push(`${where} must declare source.entrypoint (path inside the repository)`);
    }
    if (source.ref !== null && source.ref !== undefined && !isSha(source.ref) && !isTag(source.ref)) {
      errors.push(`${where} source.ref must be a 40-hex commit sha, a tag, or null`);
    }

    if (source.repository === THIS_REPOSITORY && typeof source.entrypoint === 'string') {
      const owned = OWNED_TOOL_SOURCES[source.entrypoint.replace(/^\.\//, '')];
      if (!owned) {
        errors.push(`${where} points at this repository but "${source.entrypoint}" is not a known server of it`);
      } else {
        const entrypointPath = path.join(repoRoot, source.entrypoint);
        if (!fs.existsSync(entrypointPath)) {
          errors.push(`${where} entrypoint "${source.entrypoint}" does not exist in the checkout`);
        }
        const tools = owned();
        info.push(`${name}: ${tools.length} tools (this repository, counted in-process)`);
        if (typeof server.expectedToolCount === 'number' && server.expectedToolCount !== tools.length) {
          errors.push(`${where} declares expectedToolCount ${server.expectedToolCount}, but the server publishes ${tools.length}`);
        }
      }
    }
  }

  return { errors, warnings, info, servers: declaration.servers };
}

// Compare the declaration with the host configuration: the same servers, the
// same commands, the same revisions — and no server that the declaration does
// not know about.
function compareHost(declaration, servers, hostConfig, { repoRoot }) {
  const errors = [];
  const warnings = [];
  const info = [];

  const hostServers = hostConfig && hostConfig.mcp && hostConfig.mcp.servers;
  if (!hostServers || typeof hostServers !== 'object') {
    errors.push('host config: mcp.servers is missing — nothing to compare the declaration against');
    return { errors, warnings, info };
  }

  for (const [name, server] of Object.entries(servers)) {
    const where = `host config: server "${name}"`;
    const host = hostServers[name];
    if (!host) {
      errors.push(`${where} is declared but missing from the host config`);
      continue;
    }
    if (server.enabled && hostServerDisabled(host)) {
      errors.push(`${where} is declared as enabled but is disabled in the host config`);
    }
    if (!server.enabled && !hostServerDisabled(host)) {
      errors.push(`${where} is declared as disabled but is enabled in the host config`);
    }
    if (server.type === 'remote') {
      if (host.url !== server.source.url) {
        errors.push(`${where} runs "${host.url || 'nothing'}" but the declaration pins "${server.source.url}"`);
      }
      continue;
    }

    const declaredEntrypoint = server.source.entrypoint.replace(/^\/+/, '');
    const script = entrypointOf(host.command);
    const root = checkoutRootFor(script, declaredEntrypoint);
    if (!root) {
      errors.push(`${where} does not start the declared entrypoint "${server.source.entrypoint}" (command: ${(host.command || []).join(' ')})`);
      continue;
    }
    const state = checkoutState(root);
    if (state.error) {
      errors.push(`${where}: cannot read the checkout at ${root} — ${state.error}`);
      continue;
    }
    if (state.repository !== server.source.repository) {
      errors.push(`${where} runs ${state.repository || 'an unknown repository'}, the declaration pins ${server.source.repository}`);
    }
    if (!state.clean) {
      const message = `${where} runs an UNCOMMITTED checkout at ${root} — the running server is a state that exists nowhere else`;
      // A pinned server must be exactly the pinned revision, so uncommitted
      // changes are a lie. An unpinned one is only reported: the stack does not
      // control that checkout, but the operator has to know it is not clean.
      if (server.source.ref) errors.push(message);
      else warnings.push(`${message} (this server is not pinned — the declaration does not control its revision)`);
    }
    const ref = server.source.ref;
    if (ref) {
      const expected = isSha(ref) ? ref : resolveRef(root, ref);
      if (!expected) {
        errors.push(`${where} pins "${ref}", but that revision is unknown in the checkout at ${root}`);
      } else if (expected !== state.head) {
        errors.push(`${where} runs ${state.head.slice(0, 12)} but the declaration pins ${expected.slice(0, 12)} (${ref})`);
      }
    }
    info.push(`${name}: ${state.head.slice(0, 12)}${state.clean ? '' : ' (dirty)'} — ${state.repository || state.origin}`);
  }

  for (const name of Object.keys(hostServers)) {
    if (!servers[name]) {
      errors.push(`host config: server "${name}" is enabled but not declared — an undeclared server can shadow a tool name silently`);
    }
  }

  return { errors, warnings, info };
}

// Two enabled servers that publish the same tool name: the agent sees one of
// them, and which one depends on start order, not on intent.
async function checkToolNameCollisions(servers, hostConfig, { probe = probeTools } = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const hostServers = (hostConfig && hostConfig.mcp && hostConfig.mcp.servers) || {};

  const owners = new Map();
  for (const [name, server] of Object.entries(servers)) {
    if (!server.enabled || server.type !== 'local') continue;
    const host = hostServers[name];
    if (!host || hostServerDisabled(host)) continue;
    const answer = await probe(host.command);
    if (!answer.ok) {
      warnings.push(`cannot read the tool list of "${name}": ${answer.error} — name collisions with it were not checked`);
      continue;
    }
    info.push(`${name}: ${answer.tools.length} tools published`);
    for (const tool of answer.tools) {
      if (!owners.has(tool)) owners.set(tool, []);
      owners.get(tool).push(name);
    }
  }

  for (const [tool, names] of owners) {
    if (names.length > 1) {
      errors.push(`tool name "${tool}" is published by ${names.length} servers: ${names.join(', ')} — the agent sees one of them, chosen by start order`);
    }
  }

  return { errors, warnings, info };
}

// The whole check. `declaration` is the parsed mcp-servers.json, `hostConfig`
// the parsed host configuration (optional — without it only the declaration is
// checked).
async function checkComposition({ declaration, hostConfig, repoRoot, probe } = {}) {
  const result = validateDeclaration(declaration, { repoRoot });
  const errors = [...result.errors];
  const warnings = [...result.warnings];
  const info = [...result.info];

  if (hostConfig) {
    const comparison = compareHost(declaration, result.servers, hostConfig, { repoRoot });
    errors.push(...comparison.errors);
    warnings.push(...comparison.warnings);
    info.push(...comparison.info);
    const collisions = await checkToolNameCollisions(result.servers, hostConfig, { probe });
    errors.push(...collisions.errors);
    warnings.push(...collisions.warnings);
    info.push(...collisions.info);
  }

  return { errors, warnings, info };
}

module.exports = { checkComposition, validateDeclaration, compareHost, checkToolNameCollisions, THIS_REPOSITORY };
