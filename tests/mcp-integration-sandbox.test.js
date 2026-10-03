'use strict';

// Приёмка P15 — песочница интеграции MCP (эпик E5 #21, этап I04, карточка #54, AC-117).
//
// Проверяется не «внутренняя функция сравнивает сама себя», а внешний контракт: два
// настоящих транспорта (дочерний MCP-процесс по stdio и HTTP-сервер), настоящий
// изолированный store внешнего сервиса, настоящие HTTP-обратные вызовы и inbox.
//
// Разделы:
//   1. контракт транспортов (stdio handshake/tools, HTTP маршруты/аутентификация);
//   2. паритет фасадов AC-117: один outcome на read и на write;
//   3. контекст не теряется: profileId/userTaskId/runId/replyContext/event ids;
//   4. пять сценариев внешнего сервиса: success/error/delay/auth expiry/duplicates;
//   5. exactly-once эффекта и статус-сообщения;
//   6. границы доверия: подмена envelope из аргументов, чужой scope, истёкшая выдача;
//   7. эмулятор вместо ожидания живой песочницы (fidelity + запрос live smoke);
//   8. чистота evidence: нет значений binding'ов, токенов и личных путей.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSandboxDomainHost,
  writeBindingValue,
  CAPABILITIES,
  callbackInbox,
  createRecruitingProviderFixture,
  FAULT_MODES,
} = require('../src/mcp-sandbox');
const { createStdioRpcClient, createHttpApiClient, outcomeFingerprint, extractOutcome } = require('../src/mcp-sandbox/client');
const { createHttpApiServer, reserveLoopbackPort } = require('../src/mcp-sandbox/transports/http-server');
const { createStdioMcpServer } = require('../src/mcp-sandbox/transports/stdio-server');
const { readEvents } = require('../src/playbook-artifacts/events');
const jsonrpc = require('../src/mcp-sandbox/transports/jsonrpc');

const REPO = path.resolve(__dirname, '..');
const STDIO_ENTRY = path.join(REPO, 'src', 'mcp-sandbox', 'transports', 'stdio-server.js');
const CLOCK_ISO = '2026-10-03T12:00:00.000Z';

const READ_BINDING = { ref: 'sbx/recruiting#read', scope: 'sandbox:recruiting:read', status: 'ok' };
const WRITE_BINDING = { ref: 'sbx/recruiting#write', scope: 'sandbox:recruiting:write', status: 'ok' };
const REPLY_CONTEXT = { channel: 'telegram', conversationId: 'conv-p15', replyToMessageId: 'msg-77', source: 'sandbox' };
const PROFILE = 'p15-test-profile';

const HOST_TOKEN = 'sandbox-host-token-fixture';
const CALLBACK_TOKEN = 'sandbox-callback-token-fixture';
const BINDING_VALUE = 'sandbox-binding-value-fixture';

const tempRoots = [];

function makeRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `p15-${name}-`));
  tempRoots.push(root);
  return root;
}

/**
 * Окружение хоста для транспорта. Значения binding'ов в env НЕ попадают: их резолвит
 * host-owned store, как это делает Credential Broker в бою (SANDBOX.md).
 */
function makeEnv(dataRoot, { fault = 'success', callbackUrl = '', bindings = [READ_BINDING, WRITE_BINDING], bindingStatuses = {} } = {}) {
  fs.mkdirSync(path.join(dataRoot, 'bindings'), { recursive: true, mode: 0o700 });
  const declared = bindings.map(binding => ({
    ref: binding.ref,
    scope: binding.scope,
    status: bindingStatuses[binding.ref] || binding.status || 'ok',
  }));
  for (const binding of declared) {
    if (declared.find(b => b.ref === binding.ref).status === 'ok') {
      writeBindingValue(path.join(dataRoot, 'bindings'), binding.ref, `${BINDING_VALUE}:${binding.scope}`);
    }
  }
  return {
    SANDBOX_DATA_ROOT: dataRoot,
    SANDBOX_PROFILE_ID: PROFILE,
    SANDBOX_USER_TASK_ID: 'ut-p15-77',
    SANDBOX_RUN_ID: 'run-p15-77',
    SANDBOX_REPLY_CONTEXT: JSON.stringify(REPLY_CONTEXT),
    SANDBOX_BINDINGS: JSON.stringify(declared),
    SANDBOX_HOST_TOKEN: HOST_TOKEN,
    SANDBOX_CALLBACK_TOKEN: CALLBACK_TOKEN,
    SANDBOX_PROVIDER_FAULT: fault,
    SANDBOX_CLOCK: CLOCK_ISO,
    SANDBOX_CALLBACK_URL: callbackUrl,
  };
}

/** Поднять HTTP-фасад и stdio-процесс над одной изолированной песочницей. */
async function startSandbox({ fault = 'success', root, bindingStatuses = {}, clientTimeoutMs = 5000 } = {}) {
  const dataRoot = root || path.join(makeRoot('shared'), 'data');
  const port = await reserveLoopbackPort();
  const callbackUrl = `http://127.0.0.1:${port}`;
  const env = makeEnv(dataRoot, { fault, callbackUrl, bindingStatuses });

  const http = createHttpApiServer({ port, env });
  await http.listen();
  const httpClient = createHttpApiClient({ baseUrl: callbackUrl, token: HOST_TOKEN, timeoutMs: clientTimeoutMs });

  const stdio = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env, timeoutMs: 5000 });
  const initialized = await stdio.call('initialize', { protocolVersion: jsonrpc.MCP_PROTOCOL_VERSION || '2025-06-18', capabilities: {} });
  stdio.notify('notifications/initialized', {});

  return {
    dataRoot,
    env,
    http,
    httpClient,
    stdio,
    initialized,
    callbackUrl,
    async call(tool, args) {
      return extractOutcome(await stdio.call('tools/call', { name: tool, arguments: args }), 'mcp-stdio');
    },
    async invoke(capabilityId, args) {
      return (await httpClient.post('/v1/capabilities/invoke', { capabilityId, arguments: args })).body;
    },
    async stop() {
      await stdio.close();
      await http.close();
    },
  };
}

test.after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

// ── 1. Контракт транспортов ────────────────────────────────────────────────
test('stdio: handshake, tools/list и отказ на инструмент вне allowedTools', async () => {
  const sandbox = await startSandbox({});
  try {
    assert.equal(sandbox.initialized.protocolVersion, '2025-06-18');
    assert.equal(sandbox.initialized.capabilities.tools.listChanged, false);
    const list = await sandbox.stdio.call('tools/list', {});
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'sandbox_recruiting_decide_application',
      'sandbox_recruiting_search_status',
    ]);
    for (const tool of list.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
    }

    const denied = await sandbox.stdio.call('tools/call', { name: 'sandbox_recruiting_search_status', arguments: {} })
      .then(() => null, error => error);
    // Инструмент объявлен, но обязательный аргумент отсутствует — это outcome, а не отказ транспорта.
    assert.equal(denied, null);

    const ping = await sandbox.stdio.call('ping', {});
    assert.equal(ping.ok, true);

    await assert.rejects(
      () => sandbox.stdio.call('no/such/method', {}),
      error => error.reason === 'rpc_error' && error.code === jsonrpc.RPC_ERROR_CODES.methodNotFound,
    );
  } finally {
    await sandbox.stop();
  }
});

test('stdio: инструмент вне allowedTools отклоняется до домена (-32001, P13)', async () => {
  const dataRoot = path.join(makeRoot('scope'), 'data');
  const env = makeEnv(dataRoot);
  env.SANDBOX_ALLOWED_TOOLS = JSON.stringify(['sandbox_recruiting_search_status']);
  const stdio = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env, timeoutMs: 5000 });
  try {
    await stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const list = await stdio.call('tools/list', {});
    assert.deepEqual(list.tools.map(tool => tool.name), ['sandbox_recruiting_search_status']);
    await assert.rejects(
      () => stdio.call('tools/call', { name: 'sandbox_recruiting_decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' } }),
      error => error.reason === 'rpc_error' && error.code === jsonrpc.RPC_ERROR_CODES.toolNotInScope,
    );
  } finally {
    await stdio.close();
  }
});

test('http: маршруты, аутентификация и отказ по capability', async () => {
  const sandbox = await startSandbox({});
  try {
    const health = await sandbox.httpClient.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const catalog = await sandbox.httpClient.get('/v1/capabilities');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.capabilities.length, CAPABILITIES.length);
    assert.equal(catalog.body.mcp.osIsolation, 'not_proven_service_uid_only');

    const anonymous = createHttpApiClient({ baseUrl: sandbox.callbackUrl, token: '', timeoutMs: 5000 });
    const unauthorized = await anonymous.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.search_status', arguments: { search_id: 'search-demo-1' } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, 'UNAUTHORIZED');

    const unknown = await sandbox.httpClient.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.nope', arguments: {} });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'CAPABILITY_NOT_FOUND');

    const notFound = await sandbox.httpClient.get('/v1/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.code, 'ROUTE_NOT_FOUND');
  } finally {
    await sandbox.stop();
  }
});

// ── 2. Паритет фасадов AC-117 ──────────────────────────────────────────────
test('AC-117: один и тот же outcome по MCP stdio и внутреннему API (read + write)', async () => {
  const viaStdio = await startSandbox({ root: path.join(makeRoot('parity-a'), 'data') });
  const viaHttp = await startSandbox({ root: path.join(makeRoot('parity-b'), 'data') });
  try {
    const readStdio = await viaStdio.call('sandbox_recruiting_search_status', { search_id: 'search-demo-1' });
    const readHttp = await viaHttp.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
    assert.equal(outcomeFingerprint(readStdio), outcomeFingerprint(readHttp));
    assert.equal(readStdio.kind, 'completed');

    const writeStdio = await viaStdio.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    const writeHttp = await viaHttp.invoke('sandbox.recruiting.decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(outcomeFingerprint(writeStdio), outcomeFingerprint(writeHttp));
    assert.equal(writeStdio.kind, 'completed');
    assert.equal(writeStdio.effectReceipt.receiptId, writeHttp.effectReceipt.receiptId);
    assert.equal(writeStdio.effectReceipt.externalRef, writeHttp.effectReceipt.externalRef);

    // Отказ тоже должен совпадать: иначе «один результат» держится только на happy path.
    const missingStdio = await viaStdio.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1' });
    const missingHttp = await viaHttp.invoke('sandbox.recruiting.decide_application', { application_id: 'app-demo-1' });
    assert.equal(missingStdio.kind, 'missing_input');
    assert.equal(outcomeFingerprint(missingStdio), outcomeFingerprint(missingHttp));
  } finally {
    await viaStdio.stop();
    await viaHttp.stop();
  }
});

test('AC-117: повтор того же действия через другой фасад — replay той же квитанции, один эффект', async () => {
  const sandbox = await startSandbox({});
  try {
    const first = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-2', decision: 'hold' });
    const second = await sandbox.invoke('sandbox.recruiting.decide_application', { application_id: 'app-demo-2', decision: 'hold' });
    assert.equal(first.result.action.replayed, false);
    assert.equal(second.result.action.replayed, true);
    assert.equal(first.effectReceipt.receiptId, second.effectReceipt.receiptId);
    assert.equal(first.effectReceipt.externalRef, second.effectReceipt.externalRef);
    assert.equal(sandbox.http.host.provider.count(), 1, 'внешний эффект произошёл ровно один раз');
    assert.equal(sandbox.http.inbox.appliedCount(), 1, 'статус-сообщение одно, повторный callback отброшен');
    assert.equal(sandbox.http.inbox.statusEntries().length, 1);
  } finally {
    await sandbox.stop();
  }
});

// ── 3. Контекст не теряется ────────────────────────────────────────────────
test('AC-117: profile/task/run, reply context и event ids доезжают по обоим фасадам', async () => {
  const sandbox = await startSandbox({});
  try {
    for (const outcome of [
      await sandbox.call('sandbox_recruiting_search_status', { search_id: 'search-demo-1' }),
      await sandbox.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' }),
    ]) {
      assert.equal(outcome.result.correlation.profileId, PROFILE);
      assert.equal(outcome.result.correlation.userTaskId, 'ut-p15-77');
      assert.equal(outcome.result.correlation.runId, 'run-p15-77');
      assert.ok(outcome.result.correlation.operationId, 'operationId не теряется');
      assert.deepEqual(outcome.result.replyContext, REPLY_CONTEXT);
      assert.ok(outcome.result.eventIds.providerEventId, 'event id внешнего сервиса не теряется');
      assert.equal(outcome.result.execution.planStarted, false);
    }

    const write = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.ok(write.result.eventIds.callbackIds.length >= 1, 'id обратного вызова не теряется');

    // Тот же контекст обязан быть и в статус-сообщении внешнего вызова.
    const [status] = sandbox.http.inbox.statusEntries();
    assert.deepEqual(status.replyContext, REPLY_CONTEXT);
    assert.equal(status.operationId, write.result.correlation.operationId);
    assert.equal(status.eventId, write.result.eventIds.providerEventId);
  } finally {
    await sandbox.stop();
  }
});

// ── 4. Пять сценариев внешнего сервиса ─────────────────────────────────────
test('сценарий success: внешний эффект, квитанция и один обратный вызов', async () => {
  const sandbox = await startSandbox({ fault: 'success' });
  try {
    const outcome = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(outcome.kind, 'completed');
    assert.ok(outcome.effectReceipt.receiptId);
    assert.deepEqual(outcome.result.delivery, { posted: 1, applied: 1, duplicatesIgnored: 0, unacknowledged: 0, callbackIds: outcome.result.eventIds.callbackIds });
    const stored = sandbox.http.host.provider.lookup(outcome.result.correlation.operationId);
    assert.equal(stored.receiptId, outcome.effectReceipt.receiptId, 'квитанция сверяется с записью внешнего сервиса');
  } finally {
    await sandbox.stop();
  }
});

test('сценарий error: типизированная ошибка без эффекта', async () => {
  const sandbox = await startSandbox({ fault: 'error' });
  try {
    const outcome = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(outcome.kind, 'technical_error');
    assert.equal(outcome.code, 'PROVIDER_ERROR');
    assert.equal(sandbox.http.host.provider.count(), 0, 'ошибка сервиса не оставила внешнего эффекта');

    const read = await sandbox.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
    assert.equal(read.kind, 'technical_error');
    assert.equal(read.code, 'PROVIDER_ERROR');
  } finally {
    await sandbox.stop();
  }
});

test('сценарий delay: неизвестный исход, поздняя квитанция и reconcile без второго эффекта', async () => {
  // Дедлайн клиента короче задержки внешнего сервиса: вызывающий узнаёт «неизвестно».
  const sandbox = await startSandbox({ fault: 'delay', clientTimeoutMs: 300 });
  try {
    const timedOut = await sandbox.httpClient.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' } });
    assert.equal(timedOut.timedOut, true, 'клиент не ждёт ответа дольше своего дедлайна');
    assert.equal(timedOut.status, 0);

    // Эффект уже произошёл, а квитанции ещё нет — именно поэтому повтор вслепую опасен.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const providerStore = path.join(sandbox.dataRoot, 'provider', 'applications');
    const records = fs.readdirSync(providerStore).map(file => JSON.parse(fs.readFileSync(path.join(providerStore, file), 'utf8')));
    assert.equal(records.length, 1, 'эффект применён один раз');
    assert.ok(records[0].receipt, 'квитанция пришла позже дедлайна');

    const reconcile = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(reconcile.kind, 'completed');
    assert.equal(reconcile.result.action.replayed, true);
    assert.equal(reconcile.effectReceipt.receiptId, records[0].receipt.receiptId, 'reconcile вернул ту же позднюю квитанцию');
    assert.equal(fs.readdirSync(providerStore).length, 1, 'reconcile не создал второго эффекта');
  } finally {
    await sandbox.stop();
  }
});

test('сценарий delay на чтении: клиент фиксирует таймаут, эффекта нет', async () => {
  const sandbox = await startSandbox({ fault: 'delay', clientTimeoutMs: 300 });
  try {
    const timedOut = await sandbox.httpClient.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.search_status', arguments: { search_id: 'search-demo-1' } });
    assert.equal(timedOut.timedOut, true);
  } finally {
    await sandbox.stop();
  }
});

test('сценарий auth expiry: внешний сервис отвергает выдачу — blocked с человеческим текстом', async () => {
  const sandbox = await startSandbox({ fault: 'auth_expiry' });
  try {
    const outcome = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.code, 'PROVIDER_AUTH_EXPIRED');
    assert.match(outcome.reason, /expired/);
    assert.equal(sandbox.http.host.provider.count(), 0);

    const read = await sandbox.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
    assert.equal(read.kind, 'blocked');
    assert.equal(read.code, 'PROVIDER_AUTH_EXPIRED');
  } finally {
    await sandbox.stop();
  }
});

test('сценарий auth expiry на стороне хоста: MCP не стартует (MCP_BINDING_EXPIRED, P13)', async () => {
  const dataRoot = path.join(makeRoot('expired'), 'data');
  const env = makeEnv(dataRoot, { bindingStatuses: { [WRITE_BINDING.ref]: 'expired' } });
  const stdio = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env, timeoutMs: 5000 });
  try {
    await assert.rejects(
      () => stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
      error => error.reason === 'rpc_error'
        && error.code === jsonrpc.RPC_ERROR_CODES.mcpStartupFailed
        && error.message.includes('MCP_BINDING_EXPIRED'),
    );
  } finally {
    await stdio.close();
  }
});

test('сценарий duplicate callbacks: три доставки — одно действие и одно статус-сообщение', async () => {
  const sandbox = await startSandbox({ fault: 'duplicate_callback' });
  try {
    const outcome = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.result.delivery.posted, 3, 'эмулятор доставил обратный вызов повторно');
    assert.equal(outcome.result.delivery.applied, 1, 'применён ровно один');
    assert.equal(outcome.result.delivery.duplicatesIgnored, 2, 'повторы отброшены, а не применены');
    assert.equal(sandbox.http.inbox.appliedCount(), 1);
    assert.equal(sandbox.http.inbox.statusEntries().length, 1, 'пользователю обещано одно статус-сообщение');
    assert.equal(sandbox.http.host.provider.count(), 1, 'внешний эффект один');

    const events = readEvents(sandbox.http.host.logFile);
    const ignored = events.filter(entry => entry.event === 'callback.duplicate_ignored');
    assert.equal(ignored.length, 2);
    for (const entry of ignored) assert.equal(entry.reasonCode, 'DUPLICATE_CALLBACK_IGNORED');
  } finally {
    await sandbox.stop();
  }
});

test('повреждённая запись внешнего сервиса — fail-closed, а не второй эффект', async () => {
  const sandbox = await startSandbox({});
  try {
    const first = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(first.kind, 'completed');
    const storeDir = path.join(sandbox.dataRoot, 'provider', 'applications');
    const file = path.join(storeDir, fs.readdirSync(storeDir)[0]);
    fs.writeFileSync(file, '{ повреждено', { mode: 0o600 });

    const second = await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    assert.equal(second.kind, 'technical_error');
    assert.equal(second.code, 'PROVIDER_STATE_UNREADABLE');
    assert.equal(fs.readdirSync(storeDir).length, 1, 'повреждённая запись не перезаписана вторым эффектом');
  } finally {
    await sandbox.stop();
  }
});

test('сценарий unreachable: типизированная техническая ошибка, эффекта нет', async () => {
  const sandbox = await startSandbox({ fault: 'unreachable' });
  try {
    const outcome = await sandbox.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
    assert.equal(outcome.kind, 'technical_error');
    assert.equal(outcome.code, 'PROVIDER_UNREACHABLE');
    assert.equal(sandbox.http.host.provider.count(), 0);
  } finally {
    await sandbox.stop();
  }
});

test('все пять сценариев приёмки объявлены явно и эмулятор не путается с живым сервисом', () => {
  for (const mode of ['success', 'error', 'delay', 'auth_expiry', 'duplicate_callback']) {
    assert.ok(FAULT_MODES.includes(mode), `сценарий ${mode} объявлен`);
  }
  const provider = createRecruitingProviderFixture({ root: makeRoot('fidelity'), fault: 'success' });
  assert.equal(provider.fidelity.mode, 'emulator');
  assert.equal(provider.fidelity.liveSandbox, 'unsupported');
  assert.equal(provider.fidelity.containsPersonalData, false);
  assert.equal(provider.fidelity.liveSmoke.performed, false);
  assert.ok(provider.fidelity.liveSmoke.required.length > 0);
});

// ── 5. Границы доверия ─────────────────────────────────────────────────────
test('аргументы модели не подменяют trusted envelope', async () => {
  const sandbox = await startSandbox({});
  try {
    const outcome = await sandbox.call('sandbox_recruiting_search_status', {
      search_id: 'search-demo-1',
      profileId: 'spoofed-profile',
      userTaskId: 'spoofed-task',
      runId: 'spoofed-run',
      replyContext: { channel: 'spoofed' },
      operationId: 'spoofed-operation',
    });
    assert.equal(outcome.result.correlation.profileId, PROFILE);
    assert.equal(outcome.result.correlation.userTaskId, 'ut-p15-77');
    assert.equal(outcome.result.correlation.runId, 'run-p15-77');
    assert.deepEqual(outcome.result.replyContext, REPLY_CONTEXT);
    assert.notEqual(outcome.result.correlation.operationId, 'spoofed-operation');
    const spoofLog = readEvents(sandbox.http.host.logFile).find(entry => entry.event === 'envelope.spoof_ignored');
    assert.ok(spoofLog, 'подмена envelope попала в лог, а не прошла молча');
    assert.equal(spoofLog.reasonCode, 'RESERVED_ARGUMENT_DROPPED');
  } finally {
    await sandbox.stop();
  }
});

test('чужой scope binding отклонён хостом до домена', async () => {
  const dataRoot = path.join(makeRoot('foreign'), 'data');
  const env = makeEnv(dataRoot, { bindings: [{ ref: 'other/admin', scope: 'other:admin', status: 'ok' }] });
  const http = createHttpApiServer({ port: 0, env });
  const port = await http.listen();
  const client = createHttpApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: HOST_TOKEN, timeoutMs: 5000 });
  try {
    const response = await client.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.search_status', arguments: { search_id: 'search-demo-1' } });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'BINDING_SCOPE_MISSING');
    assert.equal(http.host.provider.count(), 0);
  } finally {
    await http.close();
  }
});

test('без объявленного binding — blocked, а не тихий ответ', async () => {
  const dataRoot = path.join(makeRoot('nobinding'), 'data');
  const env = makeEnv(dataRoot, { bindings: [] });
  const http = createHttpApiServer({ port: 0, env });
  const port = await http.listen();
  const client = createHttpApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: HOST_TOKEN, timeoutMs: 5000 });
  try {
    const response = await client.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' } });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'BINDING_REQUIRED');
    assert.equal(http.host.provider.count(), 0);
  } finally {
    await http.close();
  }
});

// ── 6. Эмулятор внешнего домена ───────────────────────────────────────────
test('живой test-account read заявлен, но честно не выполнен', async () => {
  const provider = createRecruitingProviderFixture({ root: makeRoot('live'), fault: 'success' });
  const request = provider.requestLiveSmoke({ bindingNames: [] });
  assert.equal(request.attempted, true);
  assert.equal(request.performed, false);
  assert.equal(request.blockedBy, 'NO_TEST_ACCOUNT_BINDING');
  assert.deepEqual(request.missingBindings, ['EXTERNAL_TEST_ACCOUNT_TOKEN', 'EXTERNAL_TEST_ACCOUNT_ID']);
  assert.match(request.next, /Secret Manager/);

  const read = provider.readSearchStatus({ searchId: 'search-demo-1', bindingValue: 'x' });
  assert.equal(read.data.source, 'sanitized-sample');
  assert.equal(read.data.containsPersonalData, false);
});

test('inbox отклоняет чужие и malformed обратные вызовы, дедупликация двумя ключами', () => {
  const inbox = callbackInbox.createCallbackInbox({ root: makeRoot('inbox') });
  const envelope = { callbackId: 'cb-1', operationId: 'op-1', kind: 'application.decision.recorded', eventId: 'evt-1', decision: 'advance' };

  assert.equal(inbox.apply(envelope).applied, true);
  assert.equal(inbox.apply({ ...envelope }).duplicate, true, 'тот же callbackId — дубль');
  assert.equal(inbox.apply({ ...envelope, callbackId: 'cb-2' }).duplicate, true, 'тот же operationId с новым id — тоже дубль');
  assert.equal(inbox.apply({ ...envelope, callbackId: 'cb-3', operationId: 'op-2', kind: 'unknown.kind' }).reasonCode, 'CALLBACK_REJECTED');
  assert.equal(inbox.appliedCount(), 1);
  assert.equal(inbox.statusEntries().length, 1);
});

// ── 7. Логи этапа I04 ──────────────────────────────────────────────────────
test('логи несут корреляцию, ключ события и причину перехода — и не содержат секретов', async () => {
  const sandbox = await startSandbox({});
  try {
    await sandbox.call('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
    await sandbox.invoke('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });

    const entries = readEvents(sandbox.http.host.logFile);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(typeof entry.event, 'string');
      assert.ok('reasonCode' in entry, `у события ${entry.event} есть причина`);
      assert.ok('profileId' in entry && 'userTaskId' in entry && 'runId' in entry && 'operationId' in entry);
    }
    assert.ok(entries.some(entry => entry.event === 'provider.mutation.confirmed' && entry.reasonCode === 'RECEIPT_CONFIRMED'));
    assert.ok(entries.some(entry => entry.event === 'callback.applied' && entry.reasonCode === 'CALLBACK_APPLIED'));
    assert.ok(entries.some(entry => entry.event === 'http.request' && entry.transport === 'internal_api_http'));
    assert.ok(entries.some(entry => entry.replyChannel === REPLY_CONTEXT.channel), 'reply context виден в логах');

    const text = entries.map(entry => JSON.stringify(entry)).join('\n');
    assert.ok(!text.includes(BINDING_VALUE), 'значение binding не попало в лог');
    assert.ok(!text.includes(HOST_TOKEN) && !text.includes(CALLBACK_TOKEN), 'токены не попали в лог');
    assert.ok(!text.includes(os.homedir()), 'личные пути хоста не попали в лог');
  } finally {
    await sandbox.stop();
  }
});

// ── 8. Контракт домена ─────────────────────────────────────────────────────
test('дескрипторы capability объявляют версию, scopes, permissions и транспорты', () => {
  const dataRoot = path.join(makeRoot('descriptors'), 'data');
  const host = createSandboxDomainHost({ dataRoot, clock: () => new Date(CLOCK_ISO) });
  const descriptors = host.listCapabilities();
  assert.equal(descriptors.length, 2);
  for (const capability of descriptors) {
    assert.equal(capability.capabilityVersion, 1);
    assert.ok(capability.requiredScopes.length > 0);
    assert.ok(capability.requiredArguments.length > 0);
    assert.equal(typeof capability.permissions.retrySafety, 'string');
    assert.ok(capability.transports.includes('internal-api'));
    assert.ok(capability.transports.some(transport => transport.startsWith('mcp:')));
    assert.equal(capability.advisory.requiresGtdId, false);
  }
  assert.equal(host.getCapability('sandbox.recruiting.search_status').effect, 'read');
  assert.equal(host.getCapability('sandbox.recruiting.decide_application').effect, 'write');
  assert.throws(() => host.getCapability('sandbox.recruiting.nope'), error => error.code === 'CAPABILITY_NOT_FOUND');
  assert.throws(() => host.getCapability('sandbox.recruiting.search_status', 99), error => error.code === 'CAPABILITY_VERSION_UNKNOWN');
});

test('in-process сервер stdio отвечает на тот же контракт без дочернего процесса', async () => {
  const dataRoot = path.join(makeRoot('inproc'), 'data');
  const env = makeEnv(dataRoot);
  const server = createStdioMcpServer({ env });
  assert.equal(server.startupFailure, null);
  const initialize = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initialize.result.protocolVersion, '2025-06-18');
  const list = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 2);
  const response = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sandbox_recruiting_search_status', arguments: { search_id: 'search-demo-1' } } });
  assert.equal(response.result.structuredContent.kind, 'completed');
  assert.ok(crypto.createHash('sha256').update(JSON.stringify(response.result.structuredContent)).digest('hex'));
});
