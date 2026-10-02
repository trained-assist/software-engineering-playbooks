'use strict';

// P14 — доменные tools и извлечение pinned playbook-артефактов (эпик E5 #21,
// этап I04, приёмка AC-116).
//
// Проверяется внешний контракт capability, а не «вызвали внутреннюю функцию»:
//   1. версия / bindings / permissions объявлены ДО вызова и в ответе;
//   2. read не запускает план — ни в ответе, ни на диске, ни в графе импортов;
//   3. мутация фейкового провайдера подтверждена проверяемой receipt;
//   4. advisory-вызов возможен без gtdId;
//   5. управляемые сбои: scope, missing input, версия, replay, неизвестный исход
//      внешнего эффекта, «ок» без квитанции, недоступный провайдер.
//
// Песочница изолирована: собственный dataRoot под .sandbox/ (в репозитории), рядом
// с фикстурой плейбуков. Прод-данные, секреты и реальные провайдеры не используются.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createPlaybookArtifactHost,
  createFakeSelectionProvider,
  resolvePinnedPlaybook,
  listPinnedPlaybooks,
  readEvents,
  validateAgainstSchema,
  CapabilityError,
  READ_SCOPE,
  WRITE_SCOPE,
} = require('../src/playbook-artifacts');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || path.join(ROOT, '.sandbox');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const artifactSchema = readJson('contracts/playbook-artifact.schema.json');
const capabilitySchema = readJson('contracts/playbook-capability.schema.json');

const FIXED_CLOCK = () => new Date('2026-10-03T10:00:00.000Z');
const BINDING_VALUE = 'sandbox-fixture-binding-value';

let counter = 0;
function isolatedHost({ fault = 'none', root } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-host-'));
  return createPlaybookArtifactHost({
    root: root || ROOT,
    dataRoot,
    profileId: 'sandbox-profile',
    clock: FIXED_CLOCK,
    providerFault: fault,
    bindingResolver: ({ ref }) => (ref ? BINDING_VALUE : undefined),
    sourceRevision: 'sandbox-pinned-rev',
  });
}

const READ_CALLER = { profileId: 'profile-a', userTaskId: 'ut-42' };
const READ_BINDING = { ref: 'sbx/playbooks#read', scope: READ_SCOPE };
const WRITE_BINDING = { ref: 'sbx/playbooks#write', scope: WRITE_SCOPE };
const op = label => `op-${label}-${++counter}`;

function invoke(host, capabilityId, args, { caller = READ_CALLER, binding = READ_BINDING, operationId = op('x') } = {}) {
  return host.invoke({ capabilityId, arguments: args, caller, binding, operationId });
}

// ── 1. Версия, bindings и permissions явны ДО вызова ────────────────────────

test('P14: every capability publishes version, bindings and permissions before invocation', () => {
  const host = isolatedHost();
  const capabilities = host.listCapabilities();
  assert.equal(capabilities.length, 3);
  const ids = capabilities.map(c => c.capabilityId).sort();
  assert.deepEqual(ids, ['engineering.playbook.get', 'engineering.playbook.list', 'engineering.playbook.record_selection']);
  for (const capability of capabilities) {
    assert.deepEqual(validateAgainstSchema(capability, capabilitySchema), [], `${capability.capabilityId} must satisfy the capability contract`);
    assert.ok(capability.capabilityVersion >= 1);
    assert.equal(capability.permissions.effect, capability.effect);
    assert.equal(capability.permissions.requiresApproval, false);
    assert.ok(capability.advisory.requiresGtdId === false, 'advisory capability must not require a gtdId');
    assert.ok(capability.transports.some(t => t.startsWith('mcp:')), 'a capability must be reachable through the MCP facade');
    assert.ok(capability.transports.includes('internal-api'), 'the same handler must be reachable through the internal API');
  }
});

test('P14: the returned answer repeats version, permissions and the binding it actually used', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature' });
  assert.equal(outcome.kind, 'completed');
  const { result } = outcome;
  assert.equal(result.capabilityId, 'engineering.playbook.get');
  assert.equal(result.capabilityVersion, 1);
  assert.equal(result.permissions.effect, 'read');
  assert.deepEqual(result.permissions.allowedTriggers, ['user', 'system', 'cron']);
  assert.deepEqual(result.bindings.requiredScopes, [READ_SCOPE]);
  assert.deepEqual(result.bindings.providedBinding, READ_BINDING);
  assert.deepEqual(validateAgainstSchema(result, artifactSchema), []);
});

test('P14: an explicit version that is not the registered one is refused, not silently accepted', () => {
  const host = isolatedHost();
  assert.throws(() => host.invoke({
    capabilityId: 'engineering.playbook.get',
    capabilityVersion: 99,
    arguments: { playbook_id: 'feature' },
    caller: READ_CALLER,
    binding: READ_BINDING,
    operationId: op('v'),
  }), err => err instanceof CapabilityError && err.code === 'CAPABILITY_VERSION_UNKNOWN');
  const rejection = host.log.entries.find(entry => entry.event === 'capability.rejected');
  assert.equal(rejection.reasonCode, 'CAPABILITY_VERSION_UNKNOWN');
  assert.equal(rejection.to, 'refused');
  assert.equal(rejection.capabilityVersion, 99);
});

// ── 2. Pinned artifact как data/resource; read не запускает план ───────────

test('P14: a playbook is returned as pinned data — path, sha256 and declared inputs', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature', detail: 'full' });
  const { playbook, definition } = outcome.result;
  assert.equal(playbook.artifactRef, 'playbooks/feature.json');
  const onDisk = fs.readFileSync(path.join(ROOT, 'playbooks', 'feature.json'));
  assert.equal(playbook.artifactHash, `sha256:${require('crypto').createHash('sha256').update(onDisk).digest('hex')}`);
  assert.equal(playbook.sourceRevision, 'sandbox-pinned-rev');
  assert.ok(playbook.stageCount > 0 && playbook.stepCount > 0);
  assert.ok(playbook.inputs.some(input => input.name === 'repo' && input.required), 'declared inputs must be explicit');
  assert.equal(definition.id, 'feature', 'detail=full returns the definition as data');
  assert.equal(definition.version, playbook.version);
});

test('P14: an artifact whose version drifted is refused instead of returning the nearest one', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature', playbook_version: 99 });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'ARTIFACT_VERSION_MISMATCH');
});

test('P14: an artifact whose bytes changed after pinning is refused (expected hash mismatch)', () => {
  const host = isolatedHost();
  const wrong = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature', expected_artifact_hash: `sha256:${'0'.repeat(64)}` });
  assert.equal(wrong.kind, 'technical_error');
  assert.equal(wrong.code, 'ARTIFACT_HASH_MISMATCH');

  const pinned = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature' });
  const same = invoke(host, 'engineering.playbook.get', { playbook_id: 'feature', expected_artifact_hash: pinned.result.playbook.artifactHash });
  assert.equal(same.kind, 'completed');
});

test('P14: an unknown playbook id is a typed refusal, not an empty success', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'no-such-playbook' });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'PLAYBOOK_NOT_FOUND');
});

test('P14: reading a playbook starts no plan — answer, disk and import graph all say so', () => {
  const dataRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-noplan-'));
  const host = createPlaybookArtifactHost({ root: ROOT, dataRoot, clock: FIXED_CLOCK, bindingResolver: () => BINDING_VALUE });
  const before = fs.readdirSync(dataRoot).filter(entry => entry !== 'playbook-artifacts');

  const read = host.invoke({
    capabilityId: 'engineering.playbook.get',
    arguments: { playbook_id: 'feature', detail: 'full' },
    caller: READ_CALLER,
    binding: READ_BINDING,
    operationId: 'op-noplan',
  });
  assert.equal(read.kind, 'completed');
  assert.equal(read.result.execution.planStarted, false);
  assert.equal(read.result.execution.planId, null);
  assert.equal(read.result.execution.reason, 'READ_ONLY_NO_PLAN');

  // Ничего, кроме лога, на диске не появилось: ни плана, ни рана, ни очереди.
  const after = fs.readdirSync(dataRoot).filter(entry => entry !== 'playbook-artifacts');
  assert.deepEqual(after, before);
  assert.deepEqual(fs.readdirSync(path.join(dataRoot, 'playbook-artifacts')), ['events.jsonl']);

  // В графе импортов доменного модуля нет ни workspace, ни run/queue/plan.
  const moduleDir = path.join(ROOT, 'src', 'playbook-artifacts');
  for (const file of fs.readdirSync(moduleDir)) {
    const source = fs.readFileSync(path.join(moduleDir, file), 'utf8');
    assert.ok(!/require\((['"])[^'"]*(workspace|runner|queue|plan-runner)[^'"]*\1\)/.test(source), `${file} must not import plan/run machinery`);
  }
});

// ── 3. Мутация фейкового провайдера подтверждена receipt ───────────────────

test('P14: recording a selection returns a verifiable effect receipt and one external effect', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'debugging', reason: 'repro → fix → verify' }, { binding: WRITE_BINDING, operationId: 'op-write-1' });
  assert.equal(outcome.kind, 'completed');

  const receipt = outcome.effectReceipt;
  assert.equal(receipt.capabilityId, 'engineering.playbook.record_selection');
  assert.equal(receipt.capabilityVersion, 1);
  assert.equal(receipt.operationId, 'op-write-1');
  assert.equal(receipt.bindingRef, WRITE_BINDING.ref);
  assert.equal(receipt.at, '2026-10-03T10:00:00.000Z');
  assert.match(receipt.receiptId, /^rcpt_[0-9a-f]{16}$/);
  assert.match(receipt.externalRef, /^sel_[0-9a-f]{12}$/);
  assert.equal(outcome.result.selection.playbookVersion, 2, 'receipt pins a definition version, not just a name');

  // Квитанция проверяема: у провайдера по externalRef лежит ровно одна запись,
  // и её содержимое совпадает с тем, что вернули наружу.
  assert.equal(host.provider.count(), 1);
  const external = host.provider.lookup('op-write-1');
  assert.equal(external.found, true);
  assert.equal(external.externalRef, receipt.externalRef);
  assert.equal(external.receiptId, receipt.receiptId);
  assert.deepEqual(validateAgainstSchema(outcome.result, artifactSchema), []);
});

test('P14: a repeat of the same operationId replays the same receipt and does NOT apply a second effect', () => {
  const host = isolatedHost();
  const args = { playbook_id: 'debugging', reason: 'same decision, same task' };
  const first = invoke(host, 'engineering.playbook.record_selection', args, { binding: WRITE_BINDING, operationId: 'op-replay' });
  const second = invoke(host, 'engineering.playbook.record_selection', args, { binding: WRITE_BINDING, operationId: 'op-replay' });
  assert.equal(second.kind, 'completed');
  assert.deepEqual(second.effectReceipt, first.effectReceipt);
  assert.equal(second.result.selection.replayed, true);
  assert.equal(host.provider.count(), 1, 'the external effect happened exactly once');
});

test('P14: the same operationId with a different payload is refused, not overwritten', () => {
  const host = isolatedHost();
  invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'debugging', reason: 'first' }, { binding: WRITE_BINDING, operationId: 'op-conflict' });
  const conflict = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'debugging', reason: 'second, different' }, { binding: WRITE_BINDING, operationId: 'op-conflict' });
  assert.equal(conflict.kind, 'technical_error');
  assert.equal(conflict.code, 'REPLAY_CONFLICT');
  assert.equal(host.provider.count(), 1);
});

test('P14: an unknown outcome is never retried blindly — it is reconciled by operationId', () => {
  const host = isolatedHost({ fault: 'timeout' });
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'timeout path' }, { binding: WRITE_BINDING, operationId: 'op-timeout' });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'EFFECT_STATE_UNKNOWN');
  assert.equal(outcome.effectStateUnknown, true);
  assert.equal(outcome.reconcile.operationId, 'op-timeout');

  // Внешний эффект уже произошёл — именно поэтому слепой повтор опасен.
  assert.equal(host.provider.count(), 1);
  const unknownEvents = host.log.entries.filter(entry => entry.event === 'effect.unknown');
  assert.equal(unknownEvents.length, 1);
  assert.equal(unknownEvents[0].reasonCode, 'EFFECT_STATE_UNKNOWN');
  assert.equal(unknownEvents[0].to, 'unknown');

  // Reconcile: тот же operationId на нормальном провайдере отдаёт ту же квитанцию.
  const healthy = isolatedHost();
  healthy.provider.recordSelection({
    operationId: 'op-timeout',
    profileId: READ_CALLER.profileId,
    playbookId: 'feature',
    playbookVersion: 2,
    reason: 'timeout path',
    bindingRef: WRITE_BINDING.ref,
    bindingScope: WRITE_SCOPE,
    bindingValue: BINDING_VALUE,
  });
  const reconciled = healthy.invoke({
    capabilityId: 'engineering.playbook.record_selection',
    arguments: { playbook_id: 'feature', reason: 'timeout path' },
    caller: READ_CALLER,
    binding: WRITE_BINDING,
    operationId: 'op-timeout',
  });
  assert.equal(reconciled.kind, 'completed');
  assert.equal(reconciled.result.selection.replayed, true);
  assert.equal(healthy.provider.count(), 1, 'reconciliation did not produce a second effect');
});

// ── 4. Advisory без gtdId ──────────────────────────────────────────────────

test('P14: retrieval and selection work without any gtdId and never create one', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'ci-run' }, { caller: { profileId: 'profile-a' }, operationId: 'op-no-gtd' });
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.result.advisory.requiresGtdId, false);
  assert.equal(outcome.result.advisory.createsGtdId, false);
  assert.equal(outcome.result.advisory.gtdId, null);
  assert.equal(outcome.result.correlation.gtdId, undefined, 'gtdId was never part of the envelope');

  const advisoryEvents = host.log.entries.filter(entry => entry.event === 'advisory.settled');
  assert.equal(advisoryEvents.length, 1);
  assert.equal(advisoryEvents[0].reasonCode, 'ADVISORY_NO_GTD');
  assert.equal(advisoryEvents[0].gtdId, null);

  // Записанная в провайдере selection тоже не создаёт GTD-записи.
  const write = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'ci-run', reason: 'scheduled run needs the dispatch playbook' }, { binding: WRITE_BINDING, operationId: 'op-no-gtd-write' });
  assert.equal(write.kind, 'completed');
  assert.equal(write.result.advisory.gtdId, null);
  assert.deepEqual(fs.readdirSync(host.provider.storeDir), fs.readdirSync(host.provider.storeDir).filter(f => f.endsWith('.json')));
  const stored = JSON.parse(fs.readFileSync(path.join(host.provider.storeDir, fs.readdirSync(host.provider.storeDir)[0]), 'utf8'));
  assert.equal('gtdId' in stored, false);
});

// ── 5. Управляемые сбои ────────────────────────────────────────────────────

test('P14: a binding of a foreign scope is refused before the handler runs', () => {
  const host = isolatedHost();
  const foreign = { ref: 'other-profile#admin', scope: 'playbooks:admin' };
  assert.throws(() => host.invoke({
    capabilityId: 'engineering.playbook.get',
    arguments: { playbook_id: 'feature' },
    caller: READ_CALLER,
    binding: foreign,
    operationId: 'op-scope',
  }), err => err instanceof CapabilityError && err.code === 'BINDING_SCOPE_MISSING');
  const refusal = host.log.entries.find(entry => entry.reasonCode === 'BINDING_SCOPE_MISSING');
  assert.equal(refusal.to, 'refused');
  assert.equal(refusal.bindingScope, 'playbooks:admin');
  assert.equal(host.log.entries.some(entry => entry.event === 'artifact.resolved'), false, 'no artifact was resolved for a foreign binding');
});

test('P14: no binding at all is blocked with an explicit reason, not a silent read', () => {
  const host = isolatedHost();
  const outcome = host.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: READ_CALLER, operationId: 'op-nobinding' });
  assert.equal(outcome.kind, 'blocked');
  assert.match(outcome.reason, /playbooks:read/);
});

test('P14: a binding the host cannot resolve is blocked, not executed without credentials', () => {
  const dataRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-unresolved-'));
  const host = createPlaybookArtifactHost({ root: ROOT, dataRoot, clock: FIXED_CLOCK, bindingResolver: () => undefined });
  const outcome = host.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: READ_CALLER, binding: READ_BINDING, operationId: 'op-unresolved' });
  assert.equal(outcome.kind, 'blocked');
  assert.equal(host.log.entries.some(entry => entry.reasonCode === 'BINDING_VALUE_UNRESOLVED'), true);
});

test('P14: a missing mandatory argument yields missing_input instead of a guessed answer', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.get', {}, { operationId: 'op-missing' });
  assert.equal(outcome.kind, 'missing_input');
  assert.deepEqual(outcome.fields, ['playbook_id']);
  const refusal = host.log.entries.find(entry => entry.reasonCode === 'MISSING_INPUT');
  assert.deepEqual(refusal.missingFields, ['playbook_id']);
});

test('P14: a caller without a trusted profile is blocked — a capability never guesses who asked', () => {
  const host = isolatedHost();
  const outcome = host.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: {}, binding: READ_BINDING, operationId: 'no-profile' });
  assert.equal(outcome.kind, 'blocked');
  assert.equal(host.log.entries.some(entry => entry.reasonCode === 'NO_TRUSTED_CALLER'), true);
});

test('P14: an expired provider credential is blocked in plain language (no raw provider error)', () => {
  const host = isolatedHost({ fault: 'expired_auth' });
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'expired auth path' }, { binding: WRITE_BINDING, operationId: 'op-expired' });
  assert.equal(outcome.kind, 'blocked');
  assert.match(outcome.reason, /expired/);
  assert.ok(!/stack|at Object|node:internal/.test(outcome.reason), 'raw technical errors must not reach the surface');
});

test('P14: «ok» without a receipt never leaves the domain as success', () => {
  const host = isolatedHost({ fault: 'no_receipt' });
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'provider acknowledges without receipt' }, { binding: WRITE_BINDING, operationId: 'op-noreceipt' });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'PROVIDER_RECEIPT_MISSING');
  assert.equal(outcome.effectReceipt, undefined);
});

test('P14: an unreachable provider is a typed technical error, not a fake success', () => {
  const host = isolatedHost({ fault: 'unreachable' });
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'provider down' }, { binding: WRITE_BINDING, operationId: 'op-unreachable' });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'PROVIDER_UNREACHABLE');
  assert.equal(host.provider.count(), 0);
});

test('P14: a write capability returns completed ONLY with a verifiable receipt — whatever the provider says', () => {
  // Таблица исходов провайдера: инвариант один — «completed» без receipt не выходит.
  const cases = [
    { label: 'applied with receipt', provider: () => ({ status: 'applied', receipt: { receiptId: 'rcpt_1', externalRef: 'sel_1', at: '2026-10-03T10:00:00.000Z' }, externalRecord: { found: true, applied: true } }), expected: 'completed' },
    { label: 'replayed with receipt', provider: () => ({ status: 'replayed', receipt: { receiptId: 'rcpt_2', externalRef: 'sel_2', at: '2026-10-03T10:00:00.000Z' }, externalRecord: { found: true, applied: true } }), expected: 'completed' },
    { label: 'applied without receipt', provider: () => ({ status: 'applied', receipt: null, externalRecord: {} }), expected: 'technical_error' },
    { label: 'replayed without receipt', provider: () => ({ status: 'replayed', receipt: undefined, externalRecord: {} }), expected: 'technical_error' },
    { label: 'empty receipt id', provider: () => ({ status: 'applied', receipt: { receiptId: '', externalRef: 'sel_3', at: '2026-10-03T10:00:00.000Z' }, externalRecord: {} }), expected: 'technical_error' },
    { label: 'acknowledged without receipt', provider: () => ({ status: 'acknowledged_without_receipt', receipt: null, externalRecord: {} }), expected: 'technical_error' },
    { label: 'unknown outcome', provider: () => ({ status: 'unknown', receipt: null, externalRecord: { found: true, applied: true, externalRef: 'sel_4' } }), expected: 'technical_error' },
    { label: 'unreachable', provider: () => ({ status: 'unreachable' }), expected: 'technical_error' },
    { label: 'conflict', provider: () => ({ status: 'conflict', existingPayloadHash: 'a', requestedPayloadHash: 'b' }), expected: 'technical_error' },
    { label: 'blocked', provider: () => ({ status: 'blocked', reason: 'provider refused the credential binding' }), expected: 'blocked' },
  ];

  const { createCapabilityHost } = require('../src/playbook-artifacts/capabilities');
  for (const [index, testCase] of cases.entries()) {
    const dataRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-guard-'));
    const host = createCapabilityHost({
      root: ROOT,
      dataRoot,
      clock: FIXED_CLOCK,
      bindingResolver: () => BINDING_VALUE,
      provider: { storeDir: dataRoot, count: () => 0, lookup: () => ({ found: false, applied: false }), recordSelection: testCase.provider },
    });
    const outcome = host.invoke({
      capabilityId: 'engineering.playbook.record_selection',
      arguments: { playbook_id: 'feature', reason: `case ${index}` },
      caller: READ_CALLER,
      binding: WRITE_BINDING,
      operationId: `op-guard-${index}`,
    });
    assert.equal(outcome.kind, testCase.expected, `${testCase.label}: expected ${testCase.expected}, got ${outcome.kind}`);
    if (outcome.kind === 'completed') {
      assert.ok(outcome.effectReceipt && outcome.effectReceipt.receiptId, `${testCase.label}: completed must carry a receipt`);
      assert.equal(outcome.result.execution.planStarted, false, `${testCase.label}: a recorded selection still runs no plan`);
    } else {
      assert.equal(outcome.effectReceipt, undefined, `${testCase.label}: a non-completed outcome carries no receipt`);
    }
  }
});

// ── 6. Логи I04: корреляция, ключи событий, причины перехода, без секретов ──

test('P14: every log line carries correlation ids, an event key and a transition reason', () => {
  const host = isolatedHost();
  invoke(host, 'engineering.playbook.get', { playbook_id: 'feature' }, { operationId: 'op-log' });
  invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'log check' }, { binding: WRITE_BINDING, operationId: 'op-log-write' });

  const lines = readEvents(host.logFile);
  assert.ok(lines.length >= 6);
  for (const line of lines) {
    for (const key of ['at', 'event', 'profileId', 'userTaskId', 'runId', 'operationId', 'from', 'to', 'reasonCode']) {
      assert.ok(key in line, `event ${line.event} is missing ${key}`);
    }
    assert.equal(line.profileId, 'profile-a');
    assert.equal(line.runId, null, 'headless call has no run — absence must be visible, not invented');
  }
  const keys = lines.map(line => line.event);
  assert.deepEqual(keys, [
    'capability.received', 'capability.validated', 'artifact.resolved', 'advisory.settled',
    'capability.received', 'capability.validated', 'artifact.resolved', 'provider.mutation.confirmed', 'advisory.settled',
  ]);
  const confirmed = lines.find(line => line.event === 'provider.mutation.confirmed');
  assert.equal(confirmed.reasonCode, 'RECEIPT_CONFIRMED');
  assert.equal(confirmed.to, 'settled');
  assert.equal(confirmed.externalRef.startsWith('sel_'), true);
  assert.equal(confirmed.operationId, 'op-log-write');
  // Время в логе идёт от host clock: песочница не зависит от стенного времени.
  assert.ok(lines.every(line => line.at === '2026-10-03T10:00:00.000Z'), 'log timestamps come from the injected host clock');
});

test('P14: credential values never appear in the log, the result or the provider store', () => {
  const host = isolatedHost();
  const outcome = invoke(host, 'engineering.playbook.record_selection', { playbook_id: 'feature', reason: 'credential hygiene' }, { binding: WRITE_BINDING, operationId: 'op-secret' });
  const logText = fs.readFileSync(host.logFile, 'utf8');
  assert.ok(!logText.includes(BINDING_VALUE), 'binding value must not be logged');
  assert.ok(!JSON.stringify(outcome).includes(BINDING_VALUE), 'binding value must not be in the result');
  const stored = fs.readdirSync(host.provider.storeDir).map(file => fs.readFileSync(path.join(host.provider.storeDir, file), 'utf8')).join('\n');
  assert.ok(!stored.includes(BINDING_VALUE), 'binding value must not be persisted by the provider');
  assert.ok(stored.includes('sbx/playbooks#write'), 'only the binding ref/scope are recorded');
  // Ключи-кандидаты на секреты вычищаются даже если кто-то их передал.
  const { scrub } = require('../src/playbook-artifacts');
  assert.equal(scrub({ apiKey: 'x', authorization: 'Bearer y', note: 'ok' }).apiKey, '[redacted]');
});

// ── 7. Раздельность definitions и интерфейса ───────────────────────────────

test('P14: the pinned artifact is read from playbooks/, not from a copy inside the MCP layer', () => {
  const facadeDir = path.join(ROOT, 'src', 'mcp-skills');
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
      assert.ok(!source.includes(marker), `${path.relative(ROOT, file)} must not inline playbook definitions (${marker})`);
    }
  }
  // Одно определение — один источник: descriptor совпадает с файлом на диске.
  const { descriptor } = resolvePinnedPlaybook({ root: ROOT, playbookId: 'feature' });
  assert.equal(descriptor.artifactRef, 'playbooks/feature.json');
  assert.equal(descriptor.version, readJson('playbooks/feature.json').version);
});

test('P14: the catalog lists every pinned artifact of this checkout with its hash', () => {
  const host = isolatedHost();
  const catalog = listPinnedPlaybooks({ root: ROOT }).map(a => a.id);
  const outcome = invoke(host, 'engineering.playbook.list', {});
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.result.execution.kind, 'catalog_read');
  assert.equal(outcome.result.execution.planStarted, false);
  assert.deepEqual(outcome.result.artifacts.map(a => a.id), catalog);
  assert.ok(outcome.result.artifacts.every(a => /^sha256:[0-9a-f]{64}$/.test(a.artifactHash)));
  assert.deepEqual(validateAgainstSchema(outcome.result, artifactSchema), []);
});

test('P14: a broken definition is refused instead of being handed out as instructions', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-fixture-'));
  fs.mkdirSync(path.join(fixtureRoot, 'playbooks'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'contracts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'contracts', 'playbook.schema.json'), path.join(fixtureRoot, 'contracts', 'playbook.schema.json'));
  fs.writeFileSync(path.join(fixtureRoot, 'playbooks', 'broken.json'), JSON.stringify({ id: 'broken', version: 1, title: 'no stages' }));

  const host = isolatedHost({ root: fixtureRoot });
  const outcome = invoke(host, 'engineering.playbook.get', { playbook_id: 'broken' });
  assert.equal(outcome.kind, 'technical_error');
  assert.equal(outcome.code, 'ARTIFACT_SCHEMA_INVALID');
  assert.ok(Array.isArray(outcome.details.errors) && outcome.details.errors.length > 0);
});

test('P14: the fake provider is a stateful fixture, not a stub — it stores and reconciles', () => {
  const root = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'p14-provider-'));
  const fake = createFakeSelectionProvider({ root, clock: FIXED_CLOCK });
  const args = { operationId: 'op-1', profileId: 'profile-a', playbookId: 'feature', playbookVersion: 2, reason: 'r', bindingRef: 'r#w', bindingScope: WRITE_SCOPE, bindingValue: BINDING_VALUE };
  assert.equal(fake.recordSelection(args).status, 'applied');
  assert.equal(fake.recordSelection(args).status, 'replayed');
  assert.equal(fake.count(), 1);
  assert.equal(fake.lookup('op-unknown').found, false);
  assert.equal(fake.recordSelection({ ...args, operationId: 'op-2', bindingValue: '' }).status, 'blocked');
  assert.throws(() => createFakeSelectionProvider({}), /isolated root/);
});
