'use strict';

// Поверхность инструментов для транспортных фасадов P15 (эпик E5 #21, этап I04).
//
// Один и тот же набор инструментов обслуживает MCP-вызов рана (per-run stdio процесс)
// и внутренний API control plane: фасады разные, обработчик один
// (TASK-ROUTER-AND-MCP §5). Здесь — только контракт инструмента (имя, описание,
// схема входа) и вызов общей capability-логики; доменной логики тут нет и быть не
// должно, иначе определение и интерфейс начнут расходиться.
//
// Что приходит от модели (args) и что только от хоста (trusted):
//   args:      search_id, application_id, decision.
//   trusted:  profileId/userTaskId/runId/gtdId/operationId/replyContext/bindings.
// Значение credential binding'а приходит только от хоста: у модели его нет и быть не
// может, поэтому «придумать» binding или подменить scope нельзя.

const crypto = require('crypto');

const { CapabilityError } = require('../errors');
const { bindingFor, callerFrom } = require('./trusted-env');

function toolNameFor(capability) {
  return capability.mcp.toolName;
}

/**
 * Детерминированный operationId для вызова, когда trusted envelope его не несёт.
 * Идентификатор операции — это тождество действия (профиль + capability + аргументы),
 * поэтому один и тот же вызов через разные транспорты получает один и тот же
 * operationId: именно это делает проверку паритета фасадов значимой, а повтор —
 * идемпотентным, а не вторым эффектом.
 */
function deriveOperationId(profileId, capabilityId, args) {
  return `op_${crypto.createHash('sha256').update(JSON.stringify([profileId || null, capabilityId, args || {}])).digest('hex').slice(0, 16)}`;
}

/**
 * @param {object} options
 * @param {object} options.host capability-host домена (createCapabilityHost)
 * @param {object} options.trusted trusted envelope хоста (readTrustedEnv)
 * @param {string[]} [options.allowedTools] инструменты, которые ран вообще может использовать (P13: allowedTools)
 */
function createToolSurface({ host, trusted, allowedTools } = {}) {
  const capabilities = host.listCapabilities();
  const byName = new Map(capabilities.map(capability => [toolNameFor(capability), capability]));
  // Пустой allowedTools — не «ничего нельзя», а «ограничений нет»: иначе сервер без
  // явного списка инструментов отдавал бы пустой каталог.
  const allowed = Array.isArray(allowedTools) && allowedTools.length > 0 ? allowedTools : null;

  function listTools() {
    return capabilities
      .filter(capability => !allowed || allowed.includes(toolNameFor(capability)))
      .map(capability => ({
        name: toolNameFor(capability),
        description: capability.description,
        inputSchema: capability.mcp.inputSchema,
      }));
  }

  function has(name) {
    return byName.has(name) && (!allowed || allowed.includes(name));
  }

  async function callTool(name, args = {}) {
    const capability = byName.get(name);
    if (!capability) {
      // Инструмент вне scoped bindings рана: отказ до похода в домен (P13, слой 2).
      throw new CapabilityError('TOOL_NOT_IN_SCOPE', `tool "${name}" is not in the allowed tools of this run`, { tool: name });
    }
    return host.invoke({
      capabilityId: capability.capabilityId,
      arguments: args || {},
      caller: callerFrom(trusted),
      binding: bindingFor(trusted, capability.requiredScopes),
      operationId: trusted.operationId || deriveOperationId(trusted.profileId, capability.capabilityId, args || {}),
    });
  }

  return { listTools, callTool, has, names: () => listTools().map(tool => tool.name) };
}

module.exports = { createToolSurface, toolNameFor, deriveOperationId };
