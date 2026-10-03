'use strict';

// MCP-сервер по stdio для песочничного домена P15 (эпик E5 #21, этап I04).
//
// Первый транспортный фасад того же capability-контракта, что и внутренний HTTP API
// (src/mcp-sandbox/transports/http-server.js): один handler, два транспорта
// (TASK-ROUTER-AND-MCP §5). Запускается как per-run дочерний процесс хостом — как в P13
// (ai-agent-runner src/mcp/session.ts, PR #46).
//
// Границы, которые процесс обойти не может:
//   - trusted envelope (profile/userTask/run/operation/replyContext/bindings) приходит
//     из окружения, которое внедрил хост; из аргументов модели — никогда;
//   - инструмент вне allowedTools отклоняется до похода в домен (-32001, P13);
//   - binding не объявлен/просрочен — отказ на старте (-32003, P13: MCP_STARTUP_FAILED);
//   - значения binding'ов процесс не видит: их резолвит host-owned резолвер домена.
//
// stdout — только протокол. Всё остальное (готовность, вызовы, отказы) пишется в
// stderr одной JSON-строкой на событие: stdout засорять нельзя, иначе кадр ломается.

const { createSandboxDomainHost } = require('../index');
const { readTrustedEnv, bindingStatus, hasExpiredOrMissingBinding } = require('./trusted-env');
const { createToolSurface } = require('./tool-surface');
const jsonrpc = require('./jsonrpc');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVICE_NAME = 'software-engineering-playbooks-sandbox';

function stderrLine(event, fields) {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

function createStdioMcpServer({ trusted, env, host, surface, log } = {}) {
  const resolvedTrusted = trusted || readTrustedEnv(env);
  const resolvedHost = host || createSandboxDomainHost({
    dataRoot: resolvedTrusted.dataRoot,
    clock: resolvedTrusted.clock || (() => new Date()),
    providerFault: resolvedTrusted.providerFault,
    ...(resolvedTrusted.providerDelayMs ? { providerDelayMs: resolvedTrusted.providerDelayMs } : {}),
    callbackUrl: resolvedTrusted.callbackUrl,
    callbackToken: resolvedTrusted.callbackToken,
  });
  const resolvedSurface = surface || createToolSurface({ host: resolvedHost, trusted: resolvedTrusted, allowedTools: resolvedTrusted.allowedTools });
  const resolvedLog = log || resolvedHost.log;

  // Слой 1 приёмки P13: binding обязан быть объявлен и не просрочен — иначе старт
  // падает до обслуживания любого вызова.
  const startupFailure = (() => {
    for (const binding of resolvedTrusted.bindings || []) {
      const status = bindingStatus(resolvedTrusted, binding.ref);
      if (status === 'missing') return { code: 'MCP_BINDING_MISSING', bindingRef: binding.ref };
      if (status === 'expired') return { code: 'MCP_BINDING_EXPIRED', bindingRef: binding.ref };
    }
    return null;
  })();

  function handle(message) {
    if (jsonrpc.isNotification(message)) {
      if (message.method === 'notifications/initialized') return null;
      return null;
    }
    if (!jsonrpc.isRequest(message)) return null;

    const { id, method, params } = message;

    if (method === 'initialize') {
      if (startupFailure) {
        stderrLine('mcp.server_start_failed', { reason: 'binding_not_usable', code: startupFailure.code, bindingRef: startupFailure.bindingRef });
        return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.mcpStartupFailed, `mcp server cannot start: ${startupFailure.code}`, { code: startupFailure.code, bindingRef: startupFailure.bindingRef });
      }
      stderrLine('mcp.server_ready', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: SERVICE_NAME, version: '1.0.0' },
        scopedTools: resolvedSurface.names(),
        bindingRefs: (resolvedTrusted.bindings || []).map(binding => binding.ref),
        isolation: 'same_service_uid_not_os_isolated',
      });
      return jsonrpc.resultResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVICE_NAME, version: '1.0.0' },
      });
    }

    if (method === 'ping') return jsonrpc.resultResponse(id, { ok: true });

    if (method === 'tools/list') {
      return jsonrpc.resultResponse(id, { tools: resolvedSurface.listTools() });
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (typeof name !== 'string' || !resolvedSurface.has(name)) {
        return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.toolNotInScope, `tool "${name}" is not in the allowed tools of this run`, { code: 'TOOL_NOT_IN_SCOPE', tool: name });
      }
      return resolvedSurface.callTool(name, args)
        .then(outcome => {
          stderrLine('mcp.tool_result', {
            tool: name,
            outcome: outcome.kind,
            profileId: resolvedTrusted.profileId,
            operationId: resolvedTrusted.operationId,
            replyChannel: resolvedTrusted.replyContext ? resolvedTrusted.replyContext.channel : null,
            ...(outcome.effectReceipt ? { effectReceiptId: outcome.effectReceipt.receiptId } : {}),
            ...(outcome.result && outcome.result.delivery ? { callbackDelivery: outcome.result.delivery } : {}),
          });
          return jsonrpc.resultResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(outcome) }],
            structuredContent: outcome,
          });
        })
        .catch(error => {
          if (error && error.code === 'TOOL_NOT_IN_SCOPE') {
            return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.toolNotInScope, error.message, { code: error.code, tool: name });
          }
          if (error && error.code) {
            // Отказ хоста до handler'а: наружу — тот же код, что в логе (P13).
            return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.invalidParams, error.message, { code: error.code });
          }
          return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.internalError, 'internal error', { code: 'INTERNAL_ERROR' });
        });
    }

    return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.methodNotFound, `method "${method}" not found`, { code: 'METHOD_NOT_FOUND', method });
  }

  return { handle, trusted: resolvedTrusted, host: resolvedHost, surface: resolvedSurface, startupFailure };
}

/** Точка входа дочернего процесса: читает stdin, отвечает по stdout, умирает по EOF. */
function run() {
  const server = createStdioMcpServer();
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = jsonrpc.decodeLine(line);
      } catch (e) {
        process.stdout.write(jsonrpc.encode(jsonrpc.errorResponse(null, e.code, e.message)));
        continue;
      }
      try {
        const response = await server.handle(message);
        if (response) process.stdout.write(jsonrpc.encode(response));
      } catch (e) {
        process.stdout.write(jsonrpc.encode(jsonrpc.errorResponse(null, jsonrpc.RPC_ERROR_CODES.internalError, 'internal error', { code: 'INTERNAL_ERROR' })));
      }
    }
  });

  process.stdin.on('end', () => {
    stderrLine('mcp.server_cleanup', { signal: 'stdin_closed', outcome: 'exited' });
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

module.exports = { createStdioMcpServer, run, MCP_PROTOCOL_VERSION, SERVICE_NAME, hasExpiredOrMissingBinding };

if (require.main === module) run();
