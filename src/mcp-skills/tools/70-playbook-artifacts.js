'use strict';

// MCP-фасад доменных capability playbook-артефактов (P14, эпик E5 #21, I04).
//
// Фасад, а не реализация: здесь только контракт инструмента (имя, описание, схема
// входа) и вызов общей capability-логики из src/playbook-artifacts. Templates
// (definitions) лежат в playbooks/; этот файл про их содержимое ничего не знает и
// не должен знать — иначе определение и интерфейс начнут расходиться
// (docs/DOMAIN-TOOLS-AND-PLAYBOOK-ARTIFACTS.md, тест на раздельность слоёв).
//
// Что приходит от модели (args) и что только от хоста (ctx):
//   args: playbook_id, playbook_version, detail, expected_artifact_hash, reason.
//   ctx:  trusted envelope — userId/profileId, userTaskId, runId, gtdId, operationId,
//         bindings[{scope, ref}] и опциональный resolveBinding({ref, scope, profileId}).
// Значение credential binding'а приходит только из ctx: у модели его нет и быть не
// может, поэтому «придумать» binding или подменить scope нельзя.

const path = require('path');

const { createPlaybookArtifactHost, getCapability, isCapabilityError, listCapabilities } = require('../../playbook-artifacts');

// Значение binding'а по умолчанию — синтетическая фикстура песочницы, не секрет: она
// показывает, что значение идёт по хостовому каналу и не попадает ни в результат,
// ни в лог. Боевой хост подставляет своё (Credential Broker, #30).
const SANDBOX_BINDING_VALUE = 'sandbox-fixture-binding-value';

const DEFAULT_DATA_ROOT = process.env.AGENT_DATA_DIR || path.resolve(__dirname, '..', '..', '..', '.sandbox');

let host = null;

function artifactHost() {
  if (!host) {
    host = createPlaybookArtifactHost({
      dataRoot: process.env.PLAYBOOK_ARTIFACTS_DATA_ROOT || `${DEFAULT_DATA_ROOT}/playbook-artifacts`,
      providerFault: process.env.PLAYBOOK_ARTIFACTS_FAULT || 'none',
      bindingResolver: () => process.env.PLAYBOOK_ARTIFACTS_BINDING_VALUE || SANDBOX_BINDING_VALUE,
      sourceRevision: process.env.PLAYBOOK_ARTIFACTS_SOURCE_REVISION || null,
    });
  }
  return host;
}

/** Сброс кеша host'а — только для тестов/песочницы со сменой fault/dataRoot. */
function resetArtifactHost() {
  host = null;
}

/**
 * Trusted envelope из ctx. Ничего не додумывается: чего нет — null, а не «случайный»
 * профиль (тот же случай, что P13 закрыл для MCP-процессов рана).
 */
function trustedEnvelope(ctx = {}) {
  const profileId = ctx.profileId || ctx.userId || process.env.USER_ID || null;
  return {
    principalId: ctx.principalId || profileId,
    profileId,
    userTaskId: ctx.userTaskId || null,
    runId: ctx.runId || null,
    gtdId: ctx.gtdId || null,
    operationId: ctx.operationId || null,
  };
}

/**
 * Выбор binding'а: сначала подходящий по scope, иначе первый объявленный — чтобы
 * чужой scope дал явный отказ хоста (BINDING_SCOPE_MISSING), а не «binding'а нет».
 */
function bindingFor(ctx, requiredScopes) {
  const provided = (Array.isArray(ctx.bindings) ? ctx.bindings : []).filter(Boolean);
  return provided.find(binding => requiredScopes.includes(binding.scope)) || provided[0] || null;
}

/**
 * MCP-поверхность: outcome-kind наружу не отдаём (модель не должна рассуждать о
 * внутренних состояниях хоста) — наружу уходит понятный результат или явная ошибка с
 * кодом. Пустой результат запрещён: инструмент, которому нечего показать, говорит
 * об этом словами (src/mcp-skills/tool-result.js, trained-assist-agent#1481).
 */
function shapeForMcp(outcome) {
  if (outcome.kind === 'completed') {
    return {
      ok: true,
      outcome: outcome.kind,
      ...outcome.result,
      ...(outcome.effectReceipt ? { effectReceipt: outcome.effectReceipt } : {}),
    };
  }
  if (outcome.kind === 'missing_input') {
    return { ok: false, outcome: outcome.kind, missingInput: outcome.fields, hint: 'These fields are required by the capability definition; the host will not invent them.' };
  }
  return {
    ok: false,
    outcome: outcome.kind,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.effectStateUnknown ? { effectStateUnknown: true } : {}),
    ...(outcome.reconcile ? { reconcile: outcome.reconcile } : {}),
  };
}

function invokeCapability(capabilityId, args, ctx = {}) {
  const capability = getCapability(capabilityId);
  const caller = trustedEnvelope(ctx);
  try {
    const outcome = artifactHost().invoke({
      capabilityId,
      capabilityVersion: capability.capabilityVersion,
      arguments: args || {},
      caller,
      binding: bindingFor(ctx, capability.requiredScopes),
      operationId: caller.operationId,
      resolveBinding: typeof ctx.resolveBinding === 'function' ? ctx.resolveBinding : undefined,
    });
    return shapeForMcp(outcome);
  } catch (e) {
    // Отказ хоста до исполнения handler'а (P13): наружу — тот же код, что в логе.
    if (!isCapabilityError(e)) throw e;
    return {
      ok: false,
      outcome: 'refused',
      code: e.code,
      reason: e.message,
      ...(e.details && Object.keys(e.details).length > 0 ? { details: e.details } : {}),
    };
  }
}

const TOOLS = [
  {
    name: 'engineering_playbook_list',
    capabilityId: 'engineering.playbook.list',
    description:
      'List the pinned playbook artifacts of the engineering playbooks checkout: id, version, title, scope, artifact path and sha256. Read capability, effect=read, requires the playbooks:read binding; returns data only, runs nothing, needs no GTD id. Use it to know WHICH playbook versions exist before fetching one.',
    inputSchema: { type: 'object', required: [], properties: {} },
  },
  {
    name: 'engineering_playbook_get',
    capabilityId: 'engineering.playbook.get',
    description:
      'Fetch ONE pinned playbook artifact as a resource: explicit version, artifact path + sha256, declared inputs and stage/step inventory (detail=full also returns the definition body). Reading a playbook NEVER starts its plan — the answer states planStarted=false with the reason. Requires the playbooks:read binding; works without any GTD id.',
    inputSchema: {
      type: 'object',
      required: ['playbook_id'],
      properties: {
        playbook_id: { type: 'string', description: 'Playbook id as published by engineering_playbook_list (e.g. feature, debugging, new-software).' },
        playbook_version: { type: 'number', description: 'Expected version. If the pinned artifact has another version the call is refused (ARTIFACT_VERSION_MISMATCH) instead of returning the nearest one.' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) = descriptor; full = descriptor + definition body as data.' },
        expected_artifact_hash: { type: 'string', description: 'Expected sha256 of the artifact (sha256:<hex>). A changed artifact is refused, not silently returned.' },
      },
    },
  },
  {
    name: 'engineering_playbook_record_selection',
    capabilityId: 'engineering.playbook.record_selection',
    description:
      'Record in the external (sandbox) provider that a pinned playbook was selected for this task, and return a verifiable effect receipt. Write capability, effect=write, requires the playbooks:write binding; idempotent by operationId — a repeat returns the same receipt instead of repeating the effect. Advisory: recording a selection does NOT create a GTD item and does not start the playbook.',
    inputSchema: {
      type: 'object',
      required: ['playbook_id', 'reason'],
      properties: {
        playbook_id: { type: 'string', description: 'Pinned playbook id whose artifact was actually read first.' },
        reason: { type: 'string', description: 'Why this playbook was selected — stored with the receipt as the audit trail.' },
        playbook_version: { type: 'number', description: 'Version that was read; recorded next to the id so the receipt pins a definition, not just a name.' },
      },
    },
  },
];

const tools = {};
for (const tool of TOOLS) {
  tools[tool.name] = {
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: async (args = {}, ctx = {}) => invokeCapability(tool.capabilityId, args, ctx),
  };
}

module.exports = {
  isReady: () => true,
  tools,
  // Служебное для песочницы/тестов, не MCP-инструмент.
  internals: { artifactHost, resetArtifactHost, trustedEnvelope, shapeForMcp, invokeCapability, capabilityDocs: listCapabilities },
};
