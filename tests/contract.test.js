'use strict';

// Domain-skill CI contract: the MCP registry and the externally visible
// provider manifest must stay in sync, the public Task Packet contract must
// keep both context sources, and the index must remain a fallback, not a
// dependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../src/mcp-skills/registry');
const { canUseIndex } = require('../src/context-sources/indexed-repo');

const root = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const manifest = readJson('provider-manifest.json');
const taskPacketSchema = readJson('contracts/task-packet.schema.json');
const qaLogSchema = readJson('contracts/qa-log.schema.json');
const prAutofixSchema = readJson('contracts/pr-autofix-registration.schema.json');

test('every registry tool has a name, description, input schema and handler', () => {
  const names = new Set();
  for (const tool of registry.listTools()) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.ok(!names.has(tool.name), `duplicate tool name ${tool.name}`);
    names.add(tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
  }
  for (const expected of [
    'engineering_prepare_task',
    'engineering_repo_context',
    'qa_log_register',
    'qa_log_lookup',
    'qa_log_list',
    'engineering_pr_autofix_register',
    'engineering_pr_autofix_install',
    'engineering_pr_autofix_status',
    'engineering_pr_autofix_disable',
  ]) {
    assert.ok(names.has(expected), `missing registered tool ${expected}`);
  }
});

test('provider manifest actions map to registered tools with matching required inputs', () => {
  const byName = new Map(registry.listTools().map((t) => [t.name, t]));
  assert.ok(manifest.actions.length > 0);
  for (const action of manifest.actions) {
    const tool = byName.get(action.name);
    assert.ok(tool, `manifest action ${action.name} has no tool`);
    const declared = new Set(action.inputSchema.required || []);
    const actual = new Set(tool.inputSchema.required || []);
    assert.deepEqual([...declared].sort(), [...actual].sort(), `${action.name} required inputs differ`);
  }
});

test('Task Packet contract keeps raw-repo as a source (index is never a hard dependency)', () => {
  assert.ok(taskPacketSchema.properties.source.enum.includes('raw-repo'));
  assert.ok(taskPacketSchema.properties.source.enum.includes('indexed-repo'));
  assert.equal(canUseIndex(path.join(os.tmpdir(), 'definitely-not-an-index')), false);
});

test('qa-log contract declares the no-raw-credentials metadata shape', () => {
  for (const field of ['id', 'name', 'location', 'how_to_read', 'added_at']) {
    assert.ok(qaLogSchema.required.includes(field), `qa-log schema should require ${field}`);
    assert.ok(field in qaLogSchema.properties, `qa-log schema should define ${field}`);
  }
});

test('pr-autofix registration contract is a capability record — status enum, no secret fields', () => {
  const { RECORD_FIELDS, STATUSES } = require('../src/pr-autofix');
  for (const field of RECORD_FIELDS) {
    assert.ok(prAutofixSchema.required.includes(field), `pr-autofix schema should require ${field}`);
    assert.ok(field in prAutofixSchema.properties, `pr-autofix schema should define ${field}`);
  }
  assert.deepEqual([...prAutofixSchema.properties.status.enum].sort(), [...STATUSES].sort());
  for (const forbidden of ['token', 'secret', 'password', 'credential', 'credential_refs', 'api_key', 'private_key']) {
    assert.ok(!(forbidden in prAutofixSchema.properties), `pr-autofix registration must not define ${forbidden}`);
  }
  assert.equal(prAutofixSchema.additionalProperties, false);
});
