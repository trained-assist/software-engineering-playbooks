#!/usr/bin/env node
// Sandbox loop для P15 — «MCP integration sandbox» (эпик E5 #21, карточка #54,
// этап I04, AC-117). Одна команда, детерминированный PASS/FAIL, sanitized transcript.
//
// Сценарий приёмки AC-117, разложенный на наблюдаемые шаги:
//   1. контракт MCP stdio: handshake (protocolVersion 2025-06-18), tools/list, ping,
//      отказ -32601 на неизвестный метод, отказ -32001 на инструмент вне allowedTools;
//   2. контракт внутреннего API: healthz, каталог capability, 401 без токена хоста,
//      404 на неизвестный маршрут и на неизвестную capability;
//   3. ПАРИТЕТ ФАСАДОВ: один и тот же outcome по MCP и по внутреннему API — на read и на
//      write, побайтово (канонический fingerprint), в изолированных песочницах;
//   4. контекст не теряется: profileId / userTaskId / runId / operationId / replyContext /
//      event ids внешнего сервиса доезжают по обоим фасадам и в статус-сообщение;
//   5. пять сценариев внешнего сервиса: success / error / delay / auth expiry /
//      duplicate callbacks (плюс unreachable);
//   6. ровно один эффект и одно статус-сообщение: повтор по operationId через другой
//      фасад = та же квитанция, дубликаты обратных вызовов отброшены;
//   7. границы доверия: подмена envelope из аргументов, чужой scope, отсутствие binding,
//      истёкшая выдача на стороне хоста (сервер не стартует);
//   8. эмулятор внешнего домена: fidelity-блок и честно невыполненный живой smoke —
//      не ждём production testing, но и не называем эмулятор живым доказательством;
//   9. логи I04: корреляция + ключ события + причина перехода, и ни одного значения
//      binding'а/токена/личного пути в evidence;
//  10. приёмка репозитория: tests/mcp-integration-sandbox.test.js зелёные.
//
// Уровень: S3 — реальные модули этого репозитория, настоящий дочерний процесс и
// настоящий HTTP-сервер на loopback, сеть наружу не нужна, движок не нужен.
// Внешние зависимости: эмулятор внешнего домена пишет состояние на диск изолированного
// .sandbox/p15-<pid>/ и доставляет обратные вызовы настоящим HTTP POST в inbox хоста.
// Прод-данные, секреты и реальные провайдеры не используются.
//
// Run:   npm run test:sandbox:mcp-integration
//        node scripts/sandbox/mcp-integration-sandbox.mjs
//        node scripts/sandbox/mcp-integration-sandbox.mjs --out docs/evidence/p15-mcp-integration-sandbox

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const {
  createSandboxDomainHost,
  writeBindingValue,
  callbackInbox,
  createRecruitingProviderFixture,
  FAULT_MODES,
  CAPABILITIES,
} = require(path.join(REPO, 'src', 'mcp-sandbox'));
const { createStdioRpcClient, createHttpApiClient, outcomeFingerprint, extractOutcome } = require(path.join(REPO, 'src', 'mcp-sandbox', 'client.js'));
const { createHttpApiServer, reserveLoopbackPort } = require(path.join(REPO, 'src', 'mcp-sandbox', 'transports', 'http-server.js'));
const jsonrpc = require(path.join(REPO, 'src', 'mcp-sandbox', 'transports', 'jsonrpc.js'));
const { readEvents } = require(path.join(REPO, 'src', 'playbook-artifacts', 'events.js'));

const STDIO_ENTRY = path.join(REPO, 'src', 'mcp-sandbox', 'transports', 'stdio-server.js');
const CLOCK_ISO = '2026-10-03T12:00:00.000Z';
const READ_BINDING = { ref: 'sbx/recruiting#read', scope: 'sandbox:recruiting:read', status: 'ok' };
const WRITE_BINDING = { ref: 'sbx/recruiting#write', scope: 'sandbox:recruiting:write', status: 'ok' };
const REPLY_CONTEXT = { channel: 'telegram', conversationId: 'conv-p15-demo', replyToMessageId: 'msg-77', source: 'sandbox' };
const PROFILE = 'p15-sandbox-profile';
const HOST_TOKEN = 'sandbox-host-token-fixture';
const CALLBACK_TOKEN = 'sandbox-callback-token-fixture';
const BINDING_VALUE = 'sandbox-binding-value-fixture';

// Изолированная песочница этого прогона: свой dataRoot на сценарий, никаких общих путей.
const SANDBOX_ROOT = path.join(REPO, '.sandbox', `p15-${process.pid}`);
fs.mkdirSync(SANDBOX_ROOT, { recursive: true, mode: 0o700 });

const outFlagIndex = process.argv.indexOf('--out');
const OUT_DIR = outFlagIndex >= 0 ? path.resolve(REPO, process.argv[outFlagIndex + 1]) : null;

const failures = [];
const transcript = [];
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '   ok  -' : '   FAIL-'} ${label}${extra ? ` — ${extra}` : ''}`);
  transcript.push(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(label);
};
const note = line => {
  console.log(`          ${line}`);
  transcript.push(`     ·  ${line}`);
};
const section = title => {
  console.log(`\n${title}`);
  transcript.push(title);
};

function makeEnv(dataRoot, { fault = 'success', callbackUrl = '', bindings = [READ_BINDING, WRITE_BINDING], statuses = {} } = {}) {
  const bindingsDir = path.join(dataRoot, 'bindings');
  fs.mkdirSync(bindingsDir, { recursive: true, mode: 0o700 });
  const declared = bindings.map(binding => ({ ref: binding.ref, scope: binding.scope, status: statuses[binding.ref] || binding.status || 'ok' }));
  for (const binding of declared) {
    if (binding.status === 'ok') writeBindingValue(bindingsDir, binding.ref, `${BINDING_VALUE}:${binding.scope}`);
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

const running = [];
async function startSandbox({ name, fault = 'success', root, statuses = {}, clientTimeoutMs = 5000 } = {}) {
  const dataRoot = root || path.join(SANDBOX_ROOT, name, 'data');
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = makeEnv(dataRoot, { fault, callbackUrl: baseUrl, statuses });
  const http = createHttpApiServer({ port, env });
  await http.listen();
  const httpClient = createHttpApiClient({ baseUrl, token: HOST_TOKEN, timeoutMs: clientTimeoutMs });
  const stdio = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env, timeoutMs: clientTimeoutMs });
  const sandbox = {
    name,
    dataRoot,
    env,
    http,
    httpClient,
    stdio,
    baseUrl,
    async mcp(tool, args) {
      return extractOutcome(await stdio.call('tools/call', { name: tool, arguments: args }), 'mcp-stdio');
    },
    async api(capabilityId, args, extra = {}) {
      return (await httpClient.post('/v1/capabilities/invoke', { capabilityId, arguments: args, ...extra })).body;
    },
  };
  running.push(sandbox);
  return sandbox;
}

async function stopAll() {
  for (const sandbox of running.splice(0)) {
    await sandbox.stdio.close();
    await sandbox.http.close();
  }
}

console.log('[sandbox] P15 · MCP integration sandbox (issue #54, stage I04, AC-117)');
console.log(`[sandbox] isolated sandbox: ${path.relative(REPO, SANDBOX_ROOT)} (loopback only, no engine, no production data, no real provider)`);

// ── 1. Контракт MCP stdio ──────────────────────────────────────────────────
section('[1] MCP stdio contract smoke');
{
  const sandbox = await startSandbox({ name: 'contract' });
  const initialized = await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  note(`initialize: protocolVersion=${initialized.protocolVersion} serverInfo=${initialized.serverInfo.name} tools.listChanged=${initialized.capabilities.tools.listChanged}`);
  check(initialized.protocolVersion === '2025-06-18', 'handshake: та же версия протокола, что в P13');
  check(initialized.capabilities && initialized.capabilities.tools && initialized.capabilities.tools.listChanged === false, 'сервер объявил tools capability');

  const list = await sandbox.stdio.call('tools/list', {});
  for (const tool of list.tools) note(`tool ${tool.name} required=[${(tool.inputSchema.required || []).join(',')}] schema=${tool.inputSchema.type}`);
  check(list.tools.length === CAPABILITIES.length, 'tools/list отдал весь объявленный набор инструментов', `${list.tools.length} шт.`);
  check(list.tools.every(tool => typeof tool.description === 'string' && tool.inputSchema.type === 'object'), 'у каждого инструмента есть описание и схема входа');

  const ping = await sandbox.stdio.call('ping', {});
  check(ping.ok === true, 'ping отвечает');

  const unknownMethod = await sandbox.stdio.call('no/such/method', {}).then(() => null, error => error);
  check(unknownMethod && unknownMethod.code === jsonrpc.RPC_ERROR_CODES.methodNotFound, 'неизвестный метод — отказ -32601, а не молчание', String(unknownMethod && unknownMethod.code));

  const readyLine = sandbox.stdio.stderrLines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry && entry.event === 'mcp.server_ready');
  check(readyLine.length === 1, 'готовность сервера объявлена в логе (mcp.server_ready)');
  if (readyLine[0]) {
    note(`isolation=${readyLine[0].isolation} bindingRefs=${readyLine[0].bindingRefs.join('|')}`);
    check(readyLine[0].isolation === 'same_service_uid_not_os_isolated', 'UID сервиса не выдан за OS-изоляцию (P13)');
  }

  const scopedEnv = { ...sandbox.env, SANDBOX_ALLOWED_TOOLS: JSON.stringify(['sandbox_recruiting_search_status']) };
  const scopedRoot = path.join(SANDBOX_ROOT, 'contract', 'data-scoped');
  fs.cpSync(sandbox.dataRoot, scopedRoot, { recursive: true });
  const scoped = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env: { ...scopedEnv, SANDBOX_DATA_ROOT: scopedRoot }, timeoutMs: 5000 });
  running.push({ ...sandbox, stdio: scoped, http: { close: async () => {} } });
  await scoped.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const scopedList = await scoped.call('tools/list', {});
  const denied = await scoped.call('tools/call', { name: 'sandbox_recruiting_decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' } }).then(() => null, error => error);
  check(scopedList.tools.length === 1 && scopedList.tools[0].name === 'sandbox_recruiting_search_status', 'инструмент вне allowedTools не виден в каталоге');
  check(denied && denied.code === jsonrpc.RPC_ERROR_CODES.toolNotInScope, 'вызов инструмента вне allowedTools отклонён до домена (-32001)', String(denied && denied.code));
}

// ── 2. Контракт внутреннего API ────────────────────────────────────────────
section('[2] internal API contract smoke');
{
  const sandbox = await startSandbox({ name: 'http' });
  const health = await sandbox.httpClient.get('/healthz');
  check(health.status === 200 && health.body.ok === true, 'healthz отвечает', JSON.stringify(health.body.transports));
  const catalog = await sandbox.httpClient.get('/v1/capabilities');
  check(catalog.status === 200 && catalog.body.capabilities.length === CAPABILITIES.length, 'каталог capability доступен по HTTP');
  note(`mcp.osIsolation=${catalog.body.mcp.osIsolation}`);
  check(catalog.body.mcp.osIsolation === 'not_proven_service_uid_only', 'HTTP-каталог не заявляет OS-изоляцию');

  const anonymous = createHttpApiClient({ baseUrl: sandbox.baseUrl, token: '', timeoutMs: 5000 });
  const unauthorized = await anonymous.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.search_status', arguments: { search_id: 'search-demo-1' } });
  check(unauthorized.status === 401 && unauthorized.body.code === 'UNAUTHORIZED', 'внутренний API без токена хоста — 401');

  const unknownCapability = await sandbox.httpClient.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.nope', arguments: {} });
  check(unknownCapability.status === 404 && unknownCapability.body.code === 'CAPABILITY_NOT_FOUND', 'неизвестная capability — 404 с кодом P13');
  const unknownRoute = await sandbox.httpClient.get('/v1/nope');
  check(unknownRoute.status === 404 && unknownRoute.body.code === 'ROUTE_NOT_FOUND', 'неизвестный маршрут — 404');
}

// ── 3. Паритет фасадов AC-117 ──────────────────────────────────────────────
section('[3] AC-117: одинаковый outcome по всем транспортным фасадам');
{
  const viaStdio = await startSandbox({ name: 'parity-stdio' });
  const viaHttp = await startSandbox({ name: 'parity-http' });
  await viaStdio.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  viaStdio.stdio.notify('notifications/initialized', {});

  for (const [label, tool, capabilityId, args] of [
    ['read', 'sandbox_recruiting_search_status', 'sandbox.recruiting.search_status', { search_id: 'search-demo-1' }],
    ['write', 'sandbox_recruiting_decide_application', 'sandbox.recruiting.decide_application', { application_id: 'app-demo-1', decision: 'advance' }],
  ]) {
    const viaMcp = await viaStdio.mcp(tool, args);
    const viaApi = await viaHttp.api(capabilityId, args);
    const same = outcomeFingerprint(viaMcp) === outcomeFingerprint(viaApi);
    check(same, `${label}: MCP stdio и внутренний API дают побайтово одинаковый outcome`);
    if (!same) {
      const a = JSON.stringify(viaMcp);
      const b = JSON.stringify(viaApi);
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
          note(`первое расхождение на позиции ${i}: …${a.slice(Math.max(0, i - 60), i + 60)}… vs …${b.slice(Math.max(0, i - 60), i + 60)}…`);
          break;
        }
      }
    }
    note(`${label}: kind=${viaMcp.kind} operationId=${viaMcp.result ? viaMcp.result.correlation.operationId : '-'} providerEventId=${viaMcp.result ? viaMcp.result.eventIds.providerEventId : '-'}${viaMcp.effectReceipt ? ` receiptId=${viaMcp.effectReceipt.receiptId}` : ''}`);
  }

  const refusedMcp = await viaStdio.mcp('sandbox_recruiting_decide_application', { application_id: 'app-demo-1' });
  const refusedApi = await viaHttp.api('sandbox.recruiting.decide_application', { application_id: 'app-demo-1' });
  check(refusedMcp.kind === 'missing_input' && outcomeFingerprint(refusedMcp) === outcomeFingerprint(refusedApi), 'отказ (missing_input) тоже совпадает по обоим фасадам, а не только успех');
}

// ── 4. Контекст не теряется ────────────────────────────────────────────────
section('[4] event ids / профиль / reply context не потеряны');
{
  const sandbox = await startSandbox({ name: 'context' });
  await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  const viaMcp = await sandbox.mcp('sandbox_recruiting_search_status', { search_id: 'search-demo-1' });
  const viaApi = await sandbox.api('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
  for (const [label, outcome] of [['mcp', viaMcp], ['api', viaApi]]) {
    note(`${label}: profile=${outcome.result.correlation.profileId} task=${outcome.result.correlation.userTaskId} run=${outcome.result.correlation.runId} op=${outcome.result.correlation.operationId} reply=${outcome.result.replyContext.channel}/${outcome.result.replyContext.conversationId} event=${outcome.result.eventIds.providerEventId}`);
    check(outcome.result.correlation.profileId === PROFILE, `${label}: trusted profileId дошёл до ответа`);
    check(outcome.result.correlation.userTaskId === 'ut-p15-77' && outcome.result.correlation.runId === 'run-p15-77', `${label}: userTaskId и runId не потеряны`);
    check(outcome.result.replyContext.conversationId === REPLY_CONTEXT.conversationId, `${label}: reply context не потерян`);
    check(Boolean(outcome.result.eventIds.providerEventId), `${label}: event id внешнего сервиса не потерян`);
  }

  const spoofed = await sandbox.mcp('sandbox_recruiting_search_status', {
    search_id: 'search-demo-1',
    profileId: 'spoofed',
    userTaskId: 'spoofed',
    replyContext: { channel: 'spoofed' },
    operationId: 'spoofed',
  });
  check(spoofed.result.correlation.profileId === PROFILE && spoofed.result.correlation.operationId !== 'spoofed', 'аргументы модели не подменили trusted envelope');

  const write = await sandbox.mcp('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  const [status] = sandbox.http.inbox.statusEntries();
  note(`callback: id=${status.callbackId} event=${status.eventId} op=${status.operationId} reply=${status.replyContext.channel}/${status.replyContext.conversationId}`);
  check(status.eventId === write.result.eventIds.providerEventId && status.operationId === write.result.correlation.operationId, 'обратный вызов несёт те же event ids и operationId');
  check(status.replyContext.conversationId === REPLY_CONTEXT.conversationId, 'обратный вызов несёт исходный reply context — ответ уйдёт в тот же диалог');
}

// ── 5. Пять сценариев внешнего сервиса ──────────────────────────────────────
section('[5] provider fixtures: success / error / delay / auth expiry / duplicate callbacks');
for (const mode of ['success', 'error', 'delay', 'auth_expiry', 'duplicate_callback']) {
  check(FAULT_MODES.includes(mode), `сценарий объявлен: ${mode}`);
}

{
  const sandbox = await startSandbox({ name: 'success' });
  await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  const outcome = await sandbox.mcp('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  note(`success: kind=${outcome.kind} receipt=${outcome.effectReceipt.receiptId} externalRef=${outcome.effectReceipt.externalRef} delivery=${JSON.stringify(outcome.result.delivery)}`);
  check(outcome.kind === 'completed' && Boolean(outcome.effectReceipt.receiptId), 'success: проверяемая квитанция внешнего эффекта');
  check(outcome.result.delivery.posted === 1 && outcome.result.delivery.applied === 1, 'success: один обратный вызов применён');
  const stored = sandbox.http.host.provider.lookup(outcome.result.correlation.operationId);
  check(stored.receiptId === outcome.effectReceipt.receiptId, 'success: квитанция сверяется с записью эмулятора на диске');
  check(sandbox.http.host.provider.count() === 1, 'success: внешний эффект ровно один');
}

{
  const sandbox = await startSandbox({ name: 'error', fault: 'error' });
  const outcome = await sandbox.api('sandbox.recruiting.decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  note(`error: kind=${outcome.kind} code=${outcome.code} provider records=${sandbox.http.host.provider.count()}`);
  check(outcome.kind === 'technical_error' && outcome.code === 'PROVIDER_ERROR', 'error: типизированная техническая ошибка');
  check(sandbox.http.host.provider.count() === 0, 'error: внешнего эффекта не осталось');
  const read = await sandbox.api('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
  check(read.kind === 'technical_error' && read.code === 'PROVIDER_ERROR', 'error: то же на read-операции');
}

{
  const sandbox = await startSandbox({ name: 'delay', fault: 'delay', clientTimeoutMs: 300 });
  const started = Date.now();
  const timedOut = await sandbox.httpClient.post('/v1/capabilities/invoke', { capabilityId: 'sandbox.recruiting.decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' } });
  note(`delay: elapsedMs=${Date.now() - started} timedOut=${timedOut.timedOut} reason=${timedOut.body.reason || '-'}`);
  check(timedOut.timedOut === true, 'delay: вызывающий фиксирует таймаут, а не «успех»');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const storeDir = path.join(sandbox.dataRoot, 'provider', 'applications');
  const records = fs.readdirSync(storeDir).map(file => JSON.parse(fs.readFileSync(path.join(storeDir, file), 'utf8')));
  check(records.length === 1, 'delay: эффект у внешнего сервиса уже произошёл (именно поэтому повтор вслепую опасен)');
  check(Boolean(records[0].receipt), 'delay: квитанция пришла позже дедлайна');
  const reconcile = await sandbox.api('sandbox.recruiting.decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  note(`delay: reconcile kind=${reconcile.kind} replayed=${reconcile.result.action.replayed} receipt=${reconcile.effectReceipt.receiptId}`);
  check(reconcile.kind === 'completed' && reconcile.result.action.replayed === true, 'delay: reconcile по operationId вернул ту же квитанцию');
  check(reconcile.effectReceipt.receiptId === records[0].receipt.receiptId, 'delay: reconcile не выдал новую квитанцию');
  check(fs.readdirSync(storeDir).length === 1, 'delay: reconcile не создал второго эффекта');
}

{
  const sandbox = await startSandbox({ name: 'auth-expiry-provider', fault: 'auth_expiry' });
  const outcome = await sandbox.api('sandbox.recruiting.decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  note(`auth expiry (сервис): kind=${outcome.kind} code=${outcome.code} reason=${outcome.reason}`);
  check(outcome.kind === 'blocked' && outcome.code === 'PROVIDER_AUTH_EXPIRED', 'auth expiry: истёкшая выдача внешнего сервиса — blocked, а не машинный шум');
  check(sandbox.http.host.provider.count() === 0, 'auth expiry: эффекта нет');
}

{
  const dataRoot = path.join(SANDBOX_ROOT, 'auth-expiry-host', 'data');
  const env = makeEnv(dataRoot, { statuses: { [WRITE_BINDING.ref]: 'expired' } });
  const stdio = createStdioRpcClient({ command: process.execPath, args: [STDIO_ENTRY], env, timeoutMs: 5000 });
  running.push({ stdio, http: { close: async () => {} } });
  const failure = await stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} }).then(() => null, error => error);
  note(`auth expiry (хост): code=${failure && failure.code} message=${failure && failure.message}`);
  check(failure && failure.code === jsonrpc.RPC_ERROR_CODES.mcpStartupFailed && failure.message.includes('MCP_BINDING_EXPIRED'), 'auth expiry: MCP-сервер не стартует с просроченным binding (-32003, P13)');
  check(failure === null || !String(failure.message).includes(BINDING_VALUE), 'auth expiry: значение binding не утёкло в текст отказа');
}

{
  const sandbox = await startSandbox({ name: 'duplicate-callbacks', fault: 'duplicate_callback' });
  await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  const outcome = await sandbox.mcp('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  const delivery = outcome.result.delivery;
  note(`duplicate callbacks: posted=${delivery.posted} applied=${delivery.applied} duplicatesIgnored=${delivery.duplicatesIgnored} ids=${delivery.callbackIds.join(',')}`);
  check(delivery.posted === 3, 'duplicate callbacks: внешний сервис доставил вызов повторно (тот же id и новый id)');
  check(delivery.applied === 1 && delivery.duplicatesIgnored === 2, 'duplicate callbacks: применён один, два повтора отброшены');
  check(sandbox.http.inbox.appliedCount() === 1 && sandbox.http.inbox.statusEntries().length === 1, 'duplicate callbacks: одно действие и одно статус-сообщение');
  check(sandbox.http.host.provider.count() === 1, 'duplicate callbacks: внешний эффект один');
  const ignored = readEvents(sandbox.http.host.logFile).filter(entry => entry.event === 'callback.duplicate_ignored');
  check(ignored.length === 2 && ignored.every(entry => entry.reasonCode === 'DUPLICATE_CALLBACK_IGNORED'), 'duplicate callbacks: каждый отброшенный повтор виден в логе с причиной');
}

{
  const sandbox = await startSandbox({ name: 'unreachable', fault: 'unreachable' });
  const outcome = await sandbox.api('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
  check(outcome.kind === 'technical_error' && outcome.code === 'PROVIDER_UNREACHABLE', 'unreachable: недоступный сервис — типизированная ошибка');
  check(sandbox.http.host.provider.count() === 0, 'unreachable: эффекта нет');
}

// ── 6. Exactly-once через два фасада ───────────────────────────────────────
section('[6] happens-once: один эффект на действие при двух транспортах');
{
  const dataRoot = path.join(SANDBOX_ROOT, 'happens-once', 'data');
  const sandbox = await startSandbox({ name: 'happens-once', root: dataRoot });
  await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  const args = { application_id: 'app-demo-2', decision: 'hold' };
  const viaMcp = await sandbox.mcp('sandbox_recruiting_decide_application', args);
  const viaApi = await sandbox.api('sandbox.recruiting.decide_application', args);
  note(`happens-once: mcp replayed=${viaMcp.result.action.replayed} api replayed=${viaApi.result.action.replayed} receipt=${viaMcp.effectReceipt.receiptId}`);
  check(viaMcp.result.action.replayed === false && viaApi.result.action.replayed === true, 'повтор того же действия другим фасадом — replay, а не новая запись');
  check(viaMcp.effectReceipt.receiptId === viaApi.effectReceipt.receiptId && viaMcp.effectReceipt.externalRef === viaApi.effectReceipt.externalRef, 'оба фасада вернули одну и ту же квитанцию');
  check(sandbox.http.host.provider.count() === 1, 'внешний эффект произошёл ровно один раз');
  check(sandbox.http.inbox.statusEntries().length === 1, 'пользователю обещано одно статус-сообщение, а не два');
}

// ── 7. Границы доверия ─────────────────────────────────────────────────────
section('[7] границы доверия: чужой scope, отсутствие binding, подмена envelope');
{
  const foreign = await startSandbox({ name: 'foreign-scope', statuses: {} });
  const sandbox = createSandboxDomainHost({
    dataRoot: path.join(SANDBOX_ROOT, 'foreign-scope', 'store'),
    clock: () => new Date(CLOCK_ISO),
    bindingResolver: () => BINDING_VALUE,
  });
  const outcome = await sandbox.invoke({
    capabilityId: 'sandbox.recruiting.search_status',
    arguments: { search_id: 'search-demo-1' },
    caller: { profileId: PROFILE },
    binding: { ref: 'other/admin', scope: 'other:admin' },
  });
  note(`foreign scope: kind=${outcome.kind} code=${outcome.code} reason=${outcome.reason}`);
  check(outcome.kind === 'blocked' && outcome.code === 'BINDING_SCOPE_MISSING', 'чужой scope binding отклонён хостом до домена');
  check(!sandbox.log.entries.some(entry => entry.event === 'provider.read.confirmed'), 'при чужом scope внешний сервис не вызывался');
  check(!JSON.stringify(sandbox.log.entries).includes(BINDING_VALUE), 'значение binding не попало в лог');
  void foreign;

  const noBinding = createSandboxDomainHost({
    dataRoot: path.join(SANDBOX_ROOT, 'no-binding', 'store'),
    clock: () => new Date(CLOCK_ISO),
  });
  const refused = await noBinding.invoke({ capabilityId: 'sandbox.recruiting.decide_application', arguments: { application_id: 'app-demo-1', decision: 'advance' }, caller: { profileId: PROFILE } });
  check(refused.kind === 'blocked' && refused.code === 'BINDING_REQUIRED', 'без объявленного binding — blocked, а не тихий ответ');
  check(noBinding.provider.count() === 0, 'без binding внешнего эффекта нет');
}

// ── 8. Эмулятор внешнего домена вместо ожидания живой песочницы ────────────
section('[8] эмулятор внешнего домена: fidelity и честный статус живого smoke');
{
  const provider = createRecruitingProviderFixture({ root: path.join(SANDBOX_ROOT, 'fidelity', 'store'), fault: 'success' });
  note(`provider=${provider.fidelity.provider} mode=${provider.fidelity.mode} liveSandbox=${provider.fidelity.liveSandbox} containsPersonalData=${provider.fidelity.containsPersonalData}`);
  note(`emulated: ${provider.fidelity.emulatedProperties.join(', ')}`);
  for (const item of provider.fidelity.liveSmoke.required) note(`live smoke требует: ${item}`);
  check(provider.fidelity.mode === 'emulator' && provider.fidelity.liveSandbox === 'unsupported', 'внешний домен без provider sandbox проверяется эмулятором, а не ожиданием прода');
  check(provider.fidelity.containsPersonalData === false && provider.fidelity.sanitizedSample === true, 'контрактный сэмпл очищен от персональных данных');
  check(provider.fidelity.liveSmoke.performed === false, 'живой provider test не выполнен и не объявлен выполненным');
  check(provider.fidelity.liveSmoke.bindingNames.length === 2 && /Secret Manager/.test(provider.fidelity.liveSmoke.bindingSource), 'живой smoke привязан к именам переменных в GCP SM / GitHub Secrets');

  const request = provider.requestLiveSmoke({ bindingNames: [] });
  note(`live smoke request: blockedBy=${request.blockedBy} missing=[${request.missingBindings.join(', ')}]`);
  check(request.performed === false && request.blockedBy === 'NO_TEST_ACCOUNT_BINDING', 'запрос живого read честно заблокирован отсутствием тестового аккаунта');

  const read = provider.readSearchStatus({ searchId: 'search-demo-1', bindingValue: 'x' });
  check(read.status === 'ok' && read.data.source === 'sanitized-sample', 'эмулятор отдаёт очищенный сэмпл внешнего контракта');
  const missing = provider.readSearchStatus({ searchId: 'search-unknown', bindingValue: 'x' });
  check(missing.code === 'PROVIDER_NOT_FOUND', 'неизвестный ресурс внешнего сервиса — типизированная ошибка, а не пустой успех');

  const inbox = callbackInbox.createCallbackInbox({ root: path.join(SANDBOX_ROOT, 'fidelity', 'inbox') });
  const envelope = { callbackId: 'cb-1', operationId: 'op-1', kind: 'application.decision.recorded', eventId: 'evt-1' };
  check(inbox.apply(envelope).applied === true, 'inbox применяет первый обратный вызов');
  check(inbox.apply({ ...envelope }).duplicate === true, 'тот же callbackId — дубль');
  check(inbox.apply({ ...envelope, callbackId: 'cb-2' }).duplicate === true, 'тот же operationId с новым id — тоже дубль');
  check(inbox.apply({ ...envelope, callbackId: 'cb-3', operationId: 'op-2', kind: 'stranger' }).reasonCode === 'CALLBACK_REJECTED', 'чужой kind обратного вызова отклонён');
  check(inbox.appliedCount() === 1 && inbox.statusEntries().length === 1, 'дедупликация двумя ключами: ровно одно действие и одно сообщение');
}

// ── 9. Логи I04 и чистота evidence ─────────────────────────────────────────
section('[9] logs I04 и чистота evidence');
{
  const sandbox = await startSandbox({ name: 'logs' });
  await sandbox.stdio.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  sandbox.stdio.notify('notifications/initialized', {});
  await sandbox.mcp('sandbox_recruiting_decide_application', { application_id: 'app-demo-1', decision: 'advance' });
  await sandbox.api('sandbox.recruiting.search_status', { search_id: 'search-demo-1' });
  await sandbox.api('sandbox.recruiting.decide_application', { application_id: 'app-demo-1' });

  const lines = readEvents(sandbox.http.host.logFile);
  for (const line of lines.slice(-12)) note(`${line.at} ${line.event} ${line.from ?? '∅'}→${line.to} reason=${line.reasonCode} profile=${line.profileId} task=${String(line.userTaskId)} run=${String(line.runId)} op=${String(line.operationId)} reply=${String(line.replyChannel)}`);
  check(lines.length > 0, 'лог этапа I04 непуст');
  check(lines.every(line => typeof line.event === 'string' && 'reasonCode' in line), 'у каждой строки есть ключ события и причина перехода');
  check(lines.every(line => 'profileId' in line && 'userTaskId' in line && 'runId' in line && 'operationId' in line), 'у каждой строки есть trusted-корреляция');
  check(lines.some(line => line.event === 'provider.mutation.confirmed' && line.reasonCode === 'RECEIPT_CONFIRMED' && line.receiptId), 'effect receipt попал в лог с причиной RECEIPT_CONFIRMED');
  check(lines.some(line => line.event === 'callback.applied' && line.replyChannel === REPLY_CONTEXT.channel), 'обратный вызов и reply context видны в логе');
  check(lines.some(line => line.event === 'envelope.spoof_ignored' || line.reasonCode === 'MISSING_INPUT'), 'причины отказов читаются построчно');

  const evidenceText = lines.map(line => JSON.stringify(line)).join('\n');
  const transcriptText = transcript.join('\n');
  check(!evidenceText.includes(BINDING_VALUE) && !transcriptText.includes(BINDING_VALUE), 'значение credential binding не попало ни в лог, ни в transcript');
  check(!evidenceText.includes(HOST_TOKEN) && !evidenceText.includes(CALLBACK_TOKEN), 'токены хоста и внешнего сервиса не попали в evidence');
  check(!evidenceText.includes(process.env.HOME || '/Users/') && !/\/Users\//.test(transcriptText), 'личные пути хоста не попали в evidence');
  check(!/\/var\/folders\//.test(evidenceText) && !/node_modules/.test(evidenceText), 'системные пути и пути зависимостей не попали в evidence');
}

// ── 10. Приёмка репозитория ────────────────────────────────────────────────
section('[10] repo acceptance tests');
{
  const run = spawnSync(process.execPath, ['--test', 'tests/mcp-integration-sandbox.test.js'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  const pass = (out.match(/^ℹ pass (\d+)$/m) || [])[1];
  const fail = (out.match(/^ℹ fail (\d+)$/m) || [])[1];
  check(run.status === 0 && fail === '0', 'tests/mcp-integration-sandbox.test.js зелёные', `pass=${pass} fail=${fail}`);
}

// ── Cleanup и transcript ───────────────────────────────────────────────────
await stopAll();

section('[cleanup]');
const leftovers = fs.existsSync(SANDBOX_ROOT) ? fs.readdirSync(SANDBOX_ROOT).length : 0;
check(running.length === 0, 'все процессы песочницы остановлены');
note(`песочница прогона: ${path.relative(REPO, SANDBOX_ROOT)} (${leftovers} каталогов, изолированный data root, файлы не коммитятся)`);

console.log('\n=== TRANSCRIPT (sanitized) ===');
for (const line of transcript) console.log(line);
console.log('=== END TRANSCRIPT ===');

const transcriptBody = `${transcript.join('\n')}\n`;
if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    card: 'P15 — MCP integration sandbox',
    epic: 'E5 · trained-assist/trained-agent-architecture#21',
    issue: 'trained-assist/trained-agent-architecture#54',
    acceptance: 'AC-117',
    stage: 'I04',
    fixture: 'emulator of an external domain service without a provider sandbox (recruiting-external), sanitized contract sample',
    generatedAt: new Date().toISOString(),
    sourceRevision: process.env.P15_SOURCE_REVISION || null,
    node: process.version,
    failures,
    transcript: transcriptBody.split('\n').filter(Boolean),
  };
  const file = path.join(OUT_DIR, 'transcript.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(OUT_DIR, 'transcript.sha256'), `${sha}  transcript.json\n`);
  console.log(`\n[sandbox] transcript: ${path.relative(REPO, file)} (sha256 ${sha.slice(0, 16)}…)`);
}

if (failures.length > 0) {
  console.error(`\n[sandbox] FAIL — ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n[sandbox] PASS — все проверки P15 зелёные; песочница: ${path.relative(REPO, SANDBOX_ROOT)}`);
process.exit(0);
