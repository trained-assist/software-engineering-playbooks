'use strict';

// Внутренний API control plane для песочничного домена P15 (эпик E5 #21, этап I04).
//
// Второй транспортный фасад того же capability-контракта, что и MCP-сервер по stdio
// (src/mcp-sandbox/transports/stdio-server.js): один handler, два транспорта
// (TASK-ROUTER-AND-MCP §5). Здесь же живёт inbox обратных вызовов внешнего сервиса —
// тот самый случай, когда внешний сервис доставляет подтверждение повторно.
//
// Правила границы:
//   - trusted envelope берётся из окружения хоста (env allowlist), НЕ из тела запроса:
//     модель не может подменить профиль, задачу или контекст ответа;
//   - токен хоста проверяется на каждый запрос и в логи не пишется;
//   - значения binding'ов здесь не видны: их резолвит host-owned резолвер домена.

const http = require('http');
const { URL } = require('url');

const { createSandboxDomainHost } = require('../index');
const { readTrustedEnv, bindingFor } = require('./trusted-env');
const { deriveOperationId } = require('./tool-surface');

const SERVICE_NAME = 'software-engineering-playbooks-sandbox';
const MCP_PROTOCOL_VERSION = '2025-06-18';

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function outcomeStatus(outcome) {
  if (outcome.kind === 'completed') return 200;
  if (outcome.kind === 'missing_input') return 422;
  if (outcome.kind === 'blocked') return 403;
  if (outcome.kind === 'needs_agent') return 409;
  return 502;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {object} [options.host] готовый capability-host (иначе собирается из trusted/dataRoot)
 * @param {object} [options.trusted] trusted envelope хоста
 * @param {object} [options.env] окружение хоста, если trusted не передан явно
 * @param {object} [options.inbox] inbox обратных вызовов
 * @param {object} [options.log] event log домена
 * @param {number} [options.port] 0 = свободный порт
 * @param {string} [options.hostToken] токен хоста для внутреннего API
 * @param {string} [options.callbackToken] токен внешнего сервиса для /v1/callbacks
 */
function createHttpApiServer({ host, trusted, env, inbox, log, port = 0, hostToken, callbackToken } = {}) {
  const resolvedTrusted = trusted || readTrustedEnv(env);
  const resolvedHostToken = hostToken !== undefined && hostToken !== '' ? hostToken : resolvedTrusted.hostToken;
  const resolvedCallbackToken = callbackToken !== undefined && callbackToken !== '' ? callbackToken : resolvedTrusted.callbackToken;
  const resolvedHost = host || createSandboxDomainHost({
    dataRoot: resolvedTrusted.dataRoot,
    clock: resolvedTrusted.clock || (() => new Date()),
    providerFault: resolvedTrusted.providerFault,
    ...(resolvedTrusted.providerDelayMs ? { providerDelayMs: resolvedTrusted.providerDelayMs } : {}),
    callbackUrl: resolvedTrusted.callbackUrl,
    callbackToken: resolvedTrusted.callbackToken,
  });
  const resolvedInbox = inbox || resolvedHost.inbox;
  const resolvedLog = log || resolvedHost.log;

  const requests = [];
  const sockets = new Set();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const startedAt = Date.now();

    const record = (status, extra = {}) => {
      const entry = {
        at: new Date().toISOString(),
        event: 'http.request',
        method: request.method,
        path,
        status,
        elapsedMs: Date.now() - startedAt,
        transport: 'internal_api_http',
        ...extra,
      };
      requests.push(entry);
      resolvedLog?.write('http.request', {
        method: request.method,
        path,
        status,
        elapsedMs: entry.elapsedMs,
        transport: 'internal_api_http',
        profileId: resolvedTrusted.profileId,
        replyChannel: resolvedTrusted.replyContext ? resolvedTrusted.replyContext.channel : null,
        from: 'received',
        to: status < 400 ? 'settled' : 'refused',
        reasonCode: status < 400 ? 'REQUEST_SETTLED' : 'REQUEST_REFUSED',
      });
      return entry;
    };

    if (path === '/healthz' && request.method === 'GET') {
      record(200);
      sendJson(response, 200, { ok: true, service: SERVICE_NAME, pid: process.pid, transports: ['internal-api-http', 'mcp-stdio'] });
      return;
    }

    if (path === '/v1/capabilities' && request.method === 'GET') {
      record(200);
      sendJson(response, 200, {
        schemaVersion: 1,
        providerId: 'engineering-sandbox',
        service: SERVICE_NAME,
        capabilities: resolvedHost.listCapabilities(),
        mcp: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          osIsolation: 'not_proven_service_uid_only',
          note: 'P13: per-run MCP processes share the service UID; scoped bindings are the acceptance boundary, not the UID',
        },
      });
      return;
    }

    if (path === '/v1/callbacks' && request.method === 'POST') {
      // Токен внешнего сервиса — не токен хоста: у двух сторон разные учётные данные.
      if (!resolvedCallbackToken || request.headers.authorization !== `Bearer ${resolvedCallbackToken}`) {
        record(401);
        sendJson(response, 401, { code: 'CALLBACK_UNAUTHORIZED', reason: 'a callback must carry the external service token' });
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(await readBody(request));
      } catch (e) {
        record(400);
        sendJson(response, 400, { code: 'CALLBACK_MALFORMED', reason: e.message });
        return;
      }
      const result = resolvedInbox.apply(envelope);
      record(result.applied ? 200 : result.duplicate ? 200 : 400);
      sendJson(response, result.applied || result.duplicate ? 200 : 400, result);
      return;
    }

    if (path === '/v1/capabilities/invoke' && request.method === 'POST') {
      if (!resolvedHostToken || request.headers.authorization !== `Bearer ${resolvedHostToken}`) {
        record(401);
        sendJson(response, 401, { code: 'UNAUTHORIZED', reason: 'the internal API requires the host token' });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(request));
      } catch (e) {
        record(400);
        sendJson(response, 400, { code: 'INVOKE_MALFORMED', reason: e.message });
        return;
      }
      if (!body || typeof body.capabilityId !== 'string') {
        record(400);
        sendJson(response, 400, { code: 'INVOKE_MALFORMED', reason: 'capabilityId is required' });
        return;
      }
      let capability;
      try {
        capability = resolvedHost.getCapability(body.capabilityId, body.capabilityVersion);
      } catch (e) {
        const code = e && e.code ? e.code : 'CAPABILITY_NOT_FOUND';
        record(404, { capabilityId: body.capabilityId, code });
        sendJson(response, 404, { code, reason: e.message });
        return;
      }
      try {
        const outcome = await resolvedHost.invoke({
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.capabilityVersion,
          arguments: body.arguments || {},
          caller: {
            profileId: resolvedTrusted.profileId,
            userTaskId: resolvedTrusted.userTaskId,
            runId: resolvedTrusted.runId,
            gtdId: resolvedTrusted.gtdId,
            operationId: body.operationId || resolvedTrusted.operationId || deriveOperationId(resolvedTrusted.profileId, capability.capabilityId, body.arguments || {}),
            replyContext: resolvedTrusted.replyContext,
          },
          binding: bindingFor(resolvedTrusted, capability.requiredScopes),
        });
        const status = outcomeStatus(outcome);
        record(status, { capabilityId: body.capabilityId, outcome: outcome.kind });
        sendJson(response, status, outcome);
      } catch (e) {
        const code = e && e.code ? e.code : 'INTERNAL_ERROR';
        record(e && e.code ? 404 : 500, { capabilityId: body.capabilityId, code });
        sendJson(response, e && e.code ? 404 : 500, { code, reason: e.message });
      }
      return;
    }

    record(404);
    sendJson(response, 404, { code: 'ROUTE_NOT_FOUND', reason: `no route for ${request.method} ${path}` });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  function close() {
    return new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      const timer = setTimeout(() => resolve(), 250);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    server,
    listen,
    close,
    requests,
    host: resolvedHost,
    inbox: resolvedInbox,
    url: null,
    get port() {
      return server.address() ? server.address().port : null;
    },
  };
}

/**
 * Зарезервировать свободный loopback-порт ДО старта сервера.
 *
 * Нужно, чтобы адрес inbox'а обратных вызовов был известен до создания домена:
 * внешний сервис шлёт callback именно туда, и сам сервер свой будущий порт знать не
 * может. Песочница живёт на loopback, поэтому окно между close и listen ничтожно.
 */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { createHttpApiServer, reserveLoopbackPort, SERVICE_NAME, MCP_PROTOCOL_VERSION, outcomeStatus };
