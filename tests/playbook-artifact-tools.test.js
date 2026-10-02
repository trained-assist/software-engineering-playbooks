'use strict';

// P14 — MCP-фасад: регистрация, контракт, разделение definitions/interface.
//
// Проверяется, что фасад — это только транспорт: инструмент зарегистрирован
// под правильным именем, его inputSchema соответствует provider-manifest.json,
// пустой аргумент даёт structured refusal (не выдуманный ответ), и шаблон
// плейбука не дублируется в интерфейсных файлах (templates = definitions,
// MCP = interface).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Фасад держит host на процесс (общий лог и общий фейковый провайдер) — тест обязан
// дать ему изолированный dataRoot ДО require, иначе состояние песочницы прошлых
// прогонов влияет на приёмку.
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(__dirname, '..', '.sandbox');
// .sandbox/ в .gitignore: в свежем checkout'е (CI) его нет — создаём сами.
fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
const dataRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-mcp-'));
process.env.PLAYBOOK_ARTIFACTS_DATA_ROOT = dataRoot;

const { listTools, callTool } = require('../src/mcp-skills/registry');
const { validateAgainstSchema } = require('../src/playbook-artifacts');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'provider-manifest.json'), 'utf8'));
const artifactSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'playbook-artifact.schema.json'), 'utf8'));
const capabilitySchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'playbook-capability.schema.json'), 'utf8'));

const TOOLS = ['engineering_playbook_list', 'engineering_playbook_get', 'engineering_playbook_record_selection'];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(name => [name, true]));

const ctx = {
  profileId: 'mcp-test-profile',
  userTaskId: 'ut-mcp',
  runId: null,
  operationId: 'op-mcp-test',
  bindings: [
    { ref: 'sbx/playbooks#read', scope: 'playbooks:read' },
    { ref: 'sbx/playbooks#write', scope: 'playbooks:write' },
  ],
};

test('P14: all three playbook tools are registered under their documented names', () => {
  const names = listTools().map(t => t.name);
  for (const tool of TOOLS) {
    assert.ok(names.includes(tool), `expected '${tool}' in the MCP catalog`);
  }
});

test('P14: each tool has a description, inputSchema and a handler', () => {
  const byName = new Map(listTools().map(t => [t.name, t]));
  const facade = require('../src/mcp-skills/tools/70-playbook-artifacts');
  for (const name of TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `tool ${name} not registered`);
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof facade.tools[name].handler, 'function', `${name} must have a handler`);
  }
});

test('P14: provider-manifest.json actions map to registered tools with matching required inputs', () => {
  const byName = new Map(listTools().map(t => [t.name, t]));
  for (const action of manifest.actions) {
    if (!TOOL_BY_NAME[action.name]) continue;
    const tool = byName.get(action.name);
    assert.ok(tool, `manifest action ${action.name} has no registered tool`);
    const declared = new Set(action.inputSchema.required || []);
    const actual = new Set(tool.inputSchema.required || []);
    assert.deepEqual([...declared].sort(), [...actual].sort(), `${action.name} required inputs differ`);
  }
});

test('P14: a read call with no bindings returns blocked, not a fabricated answer', async () => {
  const result = await callTool('engineering_playbook_get', { playbook_id: 'feature' }, { profileId: 'mcp-test-profile' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
  assert.ok(/playbooks:read/.test(result.reason));
});

test('P14: a read call with no playbook_id returns missing_input, not an invented answer', async () => {
  const result = await callTool('engineering_playbook_get', {}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'missing_input');
  assert.deepEqual(result.missingInput, ['playbook_id']);
});

test('P14: a read call returns the artifact as data, not as instructions to run', async () => {
  const result = await callTool('engineering_playbook_get', { playbook_id: 'feature', detail: 'full' }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.execution.planStarted, false);
  assert.equal(result.execution.reason, 'READ_ONLY_NO_PLAN');
  assert.equal(result.advisory.requiresGtdId, false);
  assert.equal(result.advisory.createsGtdId, false);
  assert.equal(result.advisory.gtdId, null);
  assert.ok(result.playbook.artifactHash.startsWith('sha256:'));

  // Тот же результат через внутренний API — и он обязан удовлетворять контракту.
  const { createPlaybookArtifactHost } = require('../src/playbook-artifacts');
  const host = createPlaybookArtifactHost({
    root: path.join(__dirname, '..'),
    dataRoot: fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-schema-')),
    bindingResolver: () => 'sandbox-fixture-binding-value',
  });
  const internal = host.invoke({
    capabilityId: 'engineering.playbook.get',
    arguments: { playbook_id: 'feature', detail: 'full' },
    caller: { profileId: 'mcp-test-profile', userTaskId: 'ut-mcp' },
    binding: { ref: 'sbx/playbooks#read', scope: 'playbooks:read' },
    operationId: 'op-mcp-test',
  });
  assert.equal(internal.kind, 'completed');
  assert.deepEqual(validateAgainstSchema(internal.result, artifactSchema), []);
});

test('P14: a write call returns a receipt and does not create a second effect on replay', async () => {
  const first = await callTool('engineering_playbook_record_selection', { playbook_id: 'feature', reason: 'mcp test' }, { ...ctx, operationId: 'op-mcp-replay' });
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'completed');
  assert.ok(first.effectReceipt);
  assert.match(first.effectReceipt.receiptId, /^rcpt_/);
  assert.match(first.effectReceipt.externalRef, /^sel_/);
  assert.equal(first.selection.replayed, false);

  const second = await callTool('engineering_playbook_record_selection', { playbook_id: 'feature', reason: 'mcp test' }, { ...ctx, operationId: 'op-mcp-replay' });
  assert.equal(second.ok, true);
  assert.equal(second.selection.replayed, true);
  assert.deepEqual(second.effectReceipt, first.effectReceipt);
});

test('P14: the MCP tools never inline playbook step text', () => {
  const facadeDir = path.join(__dirname, '..', 'src', 'mcp-skills');
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(facadeDir);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const marker of ['"step_type"', "'step_type'", 'goal_template', 'when_to_use:', '"stages":']) {
      assert.ok(!source.includes(marker), `${path.relative(__dirname, file)} must not inline playbook definitions (${marker})`);
    }
  }
});

test('P14: the facade does not copy playbook content into its own surface (templates vs interface)', () => {
  const facade = path.join(__dirname, '..', 'src', 'mcp-skills', 'tools', '70-playbook-artifacts.js');
  const source = fs.readFileSync(facade, 'utf8');
  assert.ok(!source.includes('"step_type"'), 'MCP facade must not carry step_type');
  assert.ok(!source.includes('goal_template'), 'MCP facade must not carry goal_template');
  assert.ok(source.includes('engineering_playbook_get'), 'facade must expose the get tool');
  assert.ok(source.includes('engineering_playbook_record_selection'), 'facade must expose the record_selection tool');
  assert.ok(source.includes('P13') || source.includes('capabilities.ts'), 'facade must document P13 parity');
});

test('P14: a capability descriptor satisfies the capability contract', () => {
  const { internals } = require('../src/mcp-skills/tools/70-playbook-artifacts');
  for (const capability of internals.capabilityDocs()) {
    assert.deepEqual(validateAgainstSchema(capability, capabilitySchema), [], `${capability.capabilityId} must satisfy the capability contract`);
  }
});

test('P14: a tool result with no data is never an empty string (trained-assist-agent#1481)', async () => {
  // engineering_playbook_list with no bindings → blocked; not empty.
  const result = await callTool('engineering_playbook_list', {}, { profileId: 'mcp-test-profile' });
  assert.equal(result.ok, false);
  assert.ok(result.reason || result.outcome, 'a refusal must carry a reason, not be silently empty');
});

test('P14: the list call returns a catalog with hashes, and the get call returns the same hash', async () => {
  const list = await callTool('engineering_playbook_list', {}, ctx);
  assert.equal(list.ok, true);
  assert.ok(list.artifacts.length > 0);
  const feature = list.artifacts.find(a => a.id === 'feature');
  assert.ok(feature, 'feature must be in the catalog');
  assert.match(feature.artifactHash, /^sha256:[0-9a-f]{64}$/);

  const get = await callTool('engineering_playbook_get', { playbook_id: 'feature' }, ctx);
  assert.equal(get.ok, true);
  assert.equal(get.playbook.artifactHash, feature.artifactHash, 'get returns the same hash the catalog promised');
});

test('P14: a foreign binding scope is refused with the exact code, not a generic error', async () => {
  const result = await callTool('engineering_playbook_get', { playbook_id: 'feature' }, {
    profileId: 'mcp-test-profile',
    bindings: [{ ref: 'other#admin', scope: 'playbooks:admin' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BINDING_SCOPE_MISSING');
  assert.ok(/playbooks:admin/.test(result.reason));
});

test('P14: the manifest contract is satisfied for every new playbook tool', () => {
  const byName = new Map(listTools().map(t => [t.name, t]));
  for (const name of TOOLS) {
    const tool = byName.get(name);
    const action = manifest.actions.find(a => a.name === name);
    assert.ok(action, `${name} must be in provider-manifest.json`);
    const declared = new Set(action.inputSchema.required || []);
    const actual = new Set(tool.inputSchema.required || []);
    assert.deepEqual([...declared].sort(), [...actual].sort(), `${name} required inputs must match the manifest`);
  }
});