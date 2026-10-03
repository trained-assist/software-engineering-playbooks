'use strict';

// Доменные capability песочничного внешнего домена для P15 (эпик E5 #21, этап I04,
// карточка #54).
//
// Контракт — P13 (ai-agent-runner src/mcp/capabilities.ts, PR #46) и P14
// (src/playbook-artifacts/capabilities.js): CapabilityHandler { capabilityId,
// capabilityVersion, requiredScopes, requiredArguments, effect, invoke } и outcome-kinds
// completed | missing_input | blocked | needs_agent | technical_error. Второго словаря
// capability не заводим; этот модуль — доменная половина контракта, транспорты — фасады.
//
// Отличие от домена P14 в одном пункте: внешний домен P15 — сервис БЕЗ provider
// sandbox, поэтому его приёмка идёт через эмулятор (src/mcp-sandbox/provider-fixture.js),
// а outcome каждого вызова несёт блок fidelity — какие свойства ещё требуют живого
// smoke. Эмулятор не выдаёт себя за живое доказательство.
//
// Инварианты, которые проверяет приёмка AC-117:
//   - outcome не зависит от транспорта: ни одного транспортного поля в теле ответа,
//     иначе «один результат по всем фасадам» превратился бы в сравнение двух разных
//     ответов; транспорт пишется только в лог;
//   - trusted envelope (profileId / userTaskId / runId / operationId / replyContext)
//     приходит от хоста; аргументы модели этими полями не подменяются;
//   - event ids внешнего сервиса (providerEventId, callbackIds) доезжают в ответе и в лог;
//   - write обязан вернуть effectReceipt; «ок» без квитанции наружу не выходит (PR-16);
//   - неизвестный исход внешнего эффекта — EFFECT_STATE_UNKNOWN с reconcile, а не
//     повтор вслепую (PR-04).

const { CapabilityError } = require('./errors');

const CAPABILITY_OUTCOME_KINDS = ['completed', 'missing_input', 'blocked', 'needs_agent', 'technical_error'];
const CAPABILITY_VERSION = 1;
const SCHEMA_VERSION = 1;

const READ_SCOPE = 'sandbox:recruiting:read';
const WRITE_SCOPE = 'sandbox:recruiting:write';

const READ_ONLY_NO_PLAN = 'READ_ONLY_NO_PLAN';
const RECORDED_NOT_EXECUTED = 'RECORDED_NOT_EXECUTED';

// Поля, которые принадлежат trusted envelope хоста. Если модель присылает их в
// аргументах, хост их выбрасывает и пишет причину в лог: подмена контекста не молчит.
const RESERVED_ARGUMENTS = [
  'profileId', 'profile_id', 'userId', 'user_id', 'userTaskId', 'user_task_id',
  'runId', 'run_id', 'operationId', 'operation_id', 'gtdId', 'gtd_id',
  'replyContext', 'reply_context', 'binding', 'bindings', 'credential', 'credentialValue',
];

const CAPABILITIES = [
  {
    capabilityId: 'sandbox.recruiting.search_status',
    capabilityVersion: CAPABILITY_VERSION,
    effect: 'read',
    requiredScopes: [READ_SCOPE],
    requiredArguments: ['search_id'],
    description:
      'Read the status of one search in the external recruiting service: funnel by stage, vacancy header, updatedAt and the source of the data. Read capability, effect=read, requires the sandbox:recruiting:read binding. The sandbox provider is an emulator of a service without a provider sandbox, so the answer always carries a fidelity block: which properties still need a live test-account smoke.',
    permissions: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: ['user', 'system', 'cron'] },
    advisory: { requiresGtdId: false, mode: 'advisory' },
    transports: ['mcp:sandbox_recruiting_search_status', 'internal-api'],
    execution: 'external_read',
    mcp: {
      toolName: 'sandbox_recruiting_search_status',
      inputSchema: {
        type: 'object',
        required: ['search_id'],
        properties: {
          search_id: { type: 'string', description: 'Search id in the external service (sanitized sample: search-demo-1).' },
        },
      },
    },
  },
  {
    capabilityId: 'sandbox.recruiting.decide_application',
    capabilityVersion: CAPABILITY_VERSION,
    effect: 'write',
    requiredScopes: [WRITE_SCOPE],
    requiredArguments: ['application_id', 'decision'],
    description:
      'Record a decision on one application in the external recruiting service and return a verifiable effect receipt. Write capability, effect=write, requires the sandbox:recruiting:write binding, idempotent by operationId: a repeat returns the same receipt instead of repeating the effect. The external service confirms through a callback; a redelivered callback is ignored, not applied twice.',
    permissions: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: ['user', 'system'] },
    advisory: { requiresGtdId: false, mode: 'advisory' },
    transports: ['mcp:sandbox_recruiting_decide_application', 'internal-api'],
    execution: 'external_mutation',
    mcp: {
      toolName: 'sandbox_recruiting_decide_application',
      inputSchema: {
        type: 'object',
        required: ['application_id', 'decision'],
        properties: {
          application_id: { type: 'string', description: 'Application id in the external service (sanitized sample: app-demo-1).' },
          decision: { type: 'string', description: 'Decision to record, e.g. advance | reject | hold.' },
        },
      },
    },
  },
];

const BY_ID = new Map(CAPABILITIES.map(capability => [capability.capabilityId, capability]));

function listCapabilities() {
  return CAPABILITIES.map(capability => ({ ...capability }));
}

function getCapability(capabilityId, capabilityVersion) {
  const capability = BY_ID.get(capabilityId);
  if (!capability) {
    throw new CapabilityError('CAPABILITY_NOT_FOUND', `capability "${capabilityId}" is not registered in this domain`, { capabilityId });
  }
  if (capabilityVersion !== undefined && capabilityVersion !== null && Number(capabilityVersion) !== capability.capabilityVersion) {
    throw new CapabilityError('CAPABILITY_VERSION_UNKNOWN', `capability "${capabilityId}" is registered at version ${capability.capabilityVersion}, requested ${capabilityVersion}`, {
      capabilityId,
      registeredVersion: capability.capabilityVersion,
      requestedVersion: Number(capabilityVersion),
    });
  }
  return capability;
}

function splitReservedArguments(args = {}) {
  const clean = {};
  const dropped = [];
  for (const [key, value] of Object.entries(args)) {
    if (RESERVED_ARGUMENTS.includes(key)) dropped.push(key);
    else clean[key] = value;
  }
  return { clean, dropped };
}

/** Общий блок ответа. Ни одного транспортного поля — ради паритета фасадов AC-117. */
function envelope(capability, { caller, binding, replyContext, detail }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    permissions: { ...capability.permissions },
    bindings: {
      requiredScopes: [...capability.requiredScopes],
      providedBinding: binding ? { ref: binding.ref, scope: binding.scope } : null,
      valueDelivery: 'host-only: the binding value never reaches the model surface',
    },
    execution: {
      kind: capability.execution,
      planStarted: false,
      planId: null,
      reason: capability.effect === 'read' ? READ_ONLY_NO_PLAN : RECORDED_NOT_EXECUTED,
      detail: detail || null,
    },
    advisory: { requiresGtdId: false, createsGtdId: false, gtdId: caller.gtdId ?? null, mode: capability.advisory.mode },
    correlation: {
      profileId: caller.profileId,
      userTaskId: caller.userTaskId ?? null,
      runId: caller.runId ?? null,
      operationId: caller.operationId ?? null,
    },
    replyContext: replyContext || null,
  };
}

function technicalError(code, extra = {}) {
  return { kind: 'technical_error', code, ...extra };
}

/**
 * Отказ хоста до handler'а. Код P13 сохранён, наружу — outcome, а не исключение:
 * иначе каждый транспорт рисовал бы свой отказ и паритет фасадов AC-117 стал бы
 * недостижимым. Исключениями остаются только ошибки самого хоста (CapabilityError на
 * неизвестную capability/версию) — их транспорт переводит сам.
 */
function refusal(code, reason) {
  return { kind: 'blocked', code, reason };
}

function createCapabilityHost({ provider, log, bindingResolver } = {}) {
  if (!provider) throw new Error('sandbox capability host requires a provider fixture');

  async function invoke({ capabilityId, capabilityVersion, arguments: rawArgs = {}, caller = {}, binding, operationId, resolveBinding } = {}) {
    const capability = getCapability(capabilityId, capabilityVersion);

    const correlation = {
      profileId: caller.profileId ?? null,
      userTaskId: caller.userTaskId ?? null,
      runId: caller.runId ?? null,
      operationId: operationId || caller.operationId || null,
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.capabilityVersion,
      bindingRef: binding ? binding.ref : null,
      bindingScope: binding ? binding.scope : null,
    };

    const { clean: args, dropped } = splitReservedArguments(rawArgs);
    if (dropped.length > 0) {
      log?.write('envelope.spoof_ignored', { ...correlation, from: null, to: 'received', reasonCode: 'RESERVED_ARGUMENT_DROPPED', droppedFields: dropped });
    }

    const replyContext = caller.replyContext || null;
    const channel = replyContext ? replyContext.channel : null;
    log?.write('capability.received', { ...correlation, effect: capability.effect, requiredScopes: capability.requiredScopes, replyChannel: channel, from: null, to: 'received', reasonCode: 'REQUEST_ACCEPTED' });

    const missing = capability.requiredArguments.filter(name => args[name] === undefined || args[name] === null || args[name] === '');
    if (missing.length > 0) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'MISSING_INPUT', missingFields: missing });
      return { kind: 'missing_input', fields: [...missing] };
    }

    if (!caller.profileId) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'NO_TRUSTED_CALLER' });
      return refusal('NO_TRUSTED_CALLER', 'no profile in the trusted caller envelope; a capability is never invoked on behalf of an unidentified principal');
    }

    if (capability.requiredScopes.length > 0 && !binding) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'BINDING_REQUIRED', requiredScopes: capability.requiredScopes });
      return refusal('BINDING_REQUIRED', `capability "${capability.capabilityId}" requires a credential binding with scope ${capability.requiredScopes.join('|')} and the caller has none`);
    }
    if (binding && !capability.requiredScopes.includes(binding.scope)) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'BINDING_SCOPE_MISSING', requiredScopes: capability.requiredScopes });
      return refusal('BINDING_SCOPE_MISSING', `credential binding "${binding.ref}" has scope "${binding.scope}", capability "${capability.capabilityId}" requires ${capability.requiredScopes.join('|')}`);
    }

    // Значение binding'а резолвит хост. Оно не приходит ни из аргументов модели, ни из
    // окружения дочернего процесса — только из host-owned резолвера, и дальше живёт
    // ровно в одном аргументе вызова провайдера: ни в ответ, ни в лог оно не попадает.
    const resolver = typeof resolveBinding === 'function' ? resolveBinding : bindingResolver;
    const bindingValue = binding && typeof resolver === 'function'
      ? resolver({ ref: binding.ref, scope: binding.scope, profileId: caller.profileId, capabilityId: capability.capabilityId })
      : undefined;
    if (binding && !bindingValue) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'BINDING_VALUE_UNRESOLVED' });
      return refusal('BINDING_VALUE_UNRESOLVED', `credential binding "${binding.ref}" could not be resolved by the host for scope ${binding.scope}`);
    }

    log?.write('capability.validated', { ...correlation, from: 'received', to: 'validated', reasonCode: 'ARGS_AND_SCOPE_OK' });

    // operationId — часть trusted envelope этого вызова: и провайдер, и ответ обязаны
    // нести один и тот же идентификатор, иначе квитанция и ответ разъедутся.
    const callCaller = { ...caller, operationId: correlation.operationId };
    const ctx = { args, caller: callCaller, binding, bindingValue, correlation, replyContext };
    const outcome = capability.effect === 'read' ? await dispatchRead(capability, ctx) : await dispatchWrite(capability, ctx);
    return finish(capability, outcome, correlation);
  }

  function dispatchRead(capability, { args, caller, binding, bindingValue, correlation, replyContext }) {
    const answer = provider.readSearchStatus({ searchId: args.search_id, bindingValue });
    if (answer.status === 'ok' || answer.status === 'late') {
      log?.write(answer.status === 'late' ? 'provider.read.late' : 'provider.read.confirmed', {
        ...correlation,
        providerEventId: answer.eventId || null,
        replyChannel: replyContext ? replyContext.channel : null,
        from: 'validated',
        to: 'settled',
        reasonCode: answer.status === 'late' ? 'READ_RESPONSE_AFTER_DEADLINE' : 'READ_CONFIRMED',
      });
      return {
        kind: 'completed',
        result: {
          ...envelope(capability, { caller, binding, replyContext, detail: 'external_read' }),
          eventIds: { providerEventId: answer.eventId || null },
          read: { ...answer.data, afterDeadline: answer.status === 'late' },
          fidelity: provider.fidelity,
        },
      };
    }
    if (answer.status === 'blocked') {
      log?.write('capability.refused', { ...correlation, from: 'validated', to: 'refused', reasonCode: 'PROVIDER_AUTH_EXPIRED', detail: answer.reason });
      return refusal('PROVIDER_AUTH_EXPIRED', answer.reason);
    }
    if (answer.status === 'unreachable') {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_UNREACHABLE' });
      return technicalError('PROVIDER_UNREACHABLE');
    }
    log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: answer.code || 'PROVIDER_ERROR', detail: answer.detail || null });
    return technicalError(answer.code || 'PROVIDER_ERROR');
  }

  async function dispatchWrite(capability, { args, caller, binding, bindingValue, correlation, replyContext }) {
    const applied = await provider.decideApplication({
      operationId: correlation.operationId,
      profileId: caller.profileId,
      applicationId: args.application_id,
      decision: args.decision,
      bindingRef: binding ? binding.ref : null,
      bindingScope: binding ? binding.scope : null,
      bindingValue,
      replyContext,
    });

    if (applied.status === 'applied' || applied.status === 'applied_late' || applied.status === 'replayed') {
      if (!applied.receipt || !applied.receipt.receiptId) {
        log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_RECEIPT_MISSING', detail: 'provider reported success without a receipt' });
        return technicalError('PROVIDER_RECEIPT_MISSING');
      }
      const replayed = applied.status === 'replayed';
      const late = applied.status === 'applied_late';
      const callbackIds = applied.delivery ? applied.delivery.callbackIds : [];
      log?.write(replayed ? 'provider.replay.confirmed' : late ? 'provider.mutation.late' : 'provider.mutation.confirmed', {
        ...correlation,
        externalRef: applied.receipt.externalRef,
        providerEventId: applied.eventId || null,
        receiptId: applied.receipt.receiptId,
        callbackIds,
        replyChannel: replyContext ? replyContext.channel : null,
        from: 'validated',
        to: 'settled',
        reasonCode: replayed ? 'REPLAY_SAME_RECEIPT_NO_SECOND_EFFECT' : late ? 'RECEIPT_LATE_AFTER_DEADLINE' : 'RECEIPT_CONFIRMED',
      });
      return {
        kind: 'completed',
        result: {
          ...envelope(capability, { caller, binding, replyContext, detail: 'external_mutation' }),
          eventIds: { providerEventId: applied.eventId || null, callbackIds },
          action: {
            applicationId: String(args.application_id),
            decision: String(args.decision),
            recordedAt: applied.receipt.at,
            replayed,
            receiptLate: late,
          },
          delivery: applied.delivery || null,
          receipt: { ...applied.receipt },
          external: applied.lookup || null,
          fidelity: provider.fidelity,
        },
        effectReceipt: {
          receiptId: applied.receipt.receiptId,
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.capabilityVersion,
          operationId: correlation.operationId,
          bindingRef: binding ? binding.ref : null,
          at: applied.receipt.at,
          externalRef: applied.receipt.externalRef,
        },
      };
    }

    if (applied.status === 'pending') {
      log?.write('effect.unknown', { ...correlation, from: 'validated', to: 'unknown', reasonCode: 'EFFECT_STATE_UNKNOWN', detail: 'effect recorded, receipt not issued yet; do not retry blindly' });
      return technicalError('EFFECT_STATE_UNKNOWN', {
        effectStateUnknown: true,
        reconcile: { operationId: correlation.operationId, hint: 'resolve the outcome by operationId before any retry' },
      });
    }
    if (applied.status === 'blocked') {
      log?.write('capability.refused', { ...correlation, from: 'validated', to: 'refused', reasonCode: 'PROVIDER_AUTH_EXPIRED', detail: applied.reason });
      return refusal('PROVIDER_AUTH_EXPIRED', applied.reason);
    }
    if (applied.status === 'conflict') {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'REPLAY_CONFLICT', detail: 'operationId already recorded a different decision; no second effect was produced' });
      return technicalError('REPLAY_CONFLICT', { effectStateUnknown: false, reconcile: { operationId: correlation.operationId } });
    }
    if (applied.status === 'unreachable') {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_UNREACHABLE' });
      return technicalError('PROVIDER_UNREACHABLE');
    }
    log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: applied.code || 'PROVIDER_ERROR', detail: applied.detail || null });
    return technicalError(applied.code || 'PROVIDER_ERROR');
  }

  // Хостовая проверка write-handler'а: completed без effectReceipt наружу не выходит.
  function finish(capability, outcome, correlation) {
    if (capability.effect === 'write' && outcome.kind === 'completed' && !outcome.effectReceipt) {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'EFFECT_RECEIPT_MISSING' });
      return technicalError('EFFECT_RECEIPT_MISSING');
    }
    if (outcome.kind === 'completed' && outcome.result && outcome.result.advisory && outcome.result.advisory.requiresGtdId === false) {
      log?.write('advisory.settled', { ...correlation, from: 'settled', to: 'settled', reasonCode: 'ADVISORY_NO_GTD', gtdId: (outcome.result.advisory && outcome.result.advisory.gtdId) ?? null });
    }
    return outcome;
  }

  return { invoke, listCapabilities, getCapability };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_OUTCOME_KINDS,
  CAPABILITY_VERSION,
  READ_SCOPE,
  WRITE_SCOPE,
  RESERVED_ARGUMENTS,
  createCapabilityHost,
  getCapability,
  listCapabilities,
  splitReservedArguments,
};
