'use strict';

// Доменные capability этого репозитория для P14 (эпик E5 #21, этап I04).
//
// Контракт — тот же, что в P13 (ai-agent-runner src/mcp/capabilities.ts, PR #46):
// CapabilityHandler { capabilityId, capabilityVersion, requiredScopes,
// requiredArguments, effect, invoke } и outcome-kinds
// completed | missing_input | blocked | needs_agent | technical_error. Второй
// словарь capability не заводим: этот модуль — доменная половина контракта, а
// runner — транспортная.
//
// Три capability, и это весь срез P14:
//   engineering.playbook.list            read  — каталог pinned-артефактов как данные;
//   engineering.playbook.get             read  — сам pinned-артефакт (summary|full);
//   engineering.playbook.record_selection write — мутация фейкового провайдера с receipt.
//
// Инварианты, которые проверяет приёмка AC-116 и этот файл:
//   - версия / bindings / permissions объявлены явно в дескрипторе до вызова;
//   - read не запускает план: у read-handler'ов нет ни плана, ни рана, ни очереди, а
//     ответ несёт execution.planStarted=false с причиной;
//   - write обязан вернуть effectReceipt; «ок» без квитанции наружу не выходит (PR-16);
//   - advisory-вызов не требует gtdId и не создаёт его;
//   - caller envelope (profile/userTask/run/operation/binding) приходит от хоста и
//     никогда из аргументов модели.

const { CapabilityError } = require('./errors');
const { resolvePinnedPlaybook, listPinnedPlaybooks, resolveRoot } = require('./artifact');

const CAPABILITY_OUTCOME_KINDS = ['completed', 'missing_input', 'blocked', 'needs_agent', 'technical_error'];
const CAPABILITY_VERSION = 1;
const SCHEMA_VERSION = 1;

const READ_SCOPE = 'playbooks:read';
const WRITE_SCOPE = 'playbooks:write';

const READ_TRIGGERS = ['user', 'system', 'cron'];
const WRITE_TRIGGERS = ['user', 'system'];

const READ_ONLY_NO_PLAN = 'READ_ONLY_NO_PLAN';

// Публичные дескрипторы: то, что хост показывает до вызова. Ничего исполняемого.
const CAPABILITIES = [
  {
    capabilityId: 'engineering.playbook.list',
    capabilityVersion: CAPABILITY_VERSION,
    effect: 'read',
    requiredScopes: [READ_SCOPE],
    requiredArguments: [],
    description: 'List pinned playbook artifacts of this checkout (id, version, title, scope, artifact ref + hash). Data only — returns no instructions to run and starts nothing.',
    permissions: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_TRIGGERS },
    advisory: { requiresGtdId: false, mode: 'advisory' },
    transports: ['mcp:engineering_playbook_list', 'internal-api'],
    execution: 'catalog_read',
  },
  {
    capabilityId: 'engineering.playbook.get',
    capabilityVersion: CAPABILITY_VERSION,
    effect: 'read',
    requiredScopes: [READ_SCOPE],
    requiredArguments: ['playbook_id'],
    description: 'Fetch one pinned playbook artifact as a resource: explicit version, artifact ref + sha256, declared inputs, stage/step inventory. detail=full additionally returns the definition body. Reading a playbook never starts its plan.',
    permissions: { effect: 'read', requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_TRIGGERS },
    advisory: { requiresGtdId: false, mode: 'advisory' },
    transports: ['mcp:engineering_playbook_get', 'internal-api'],
    execution: 'retrieval_only',
  },
  {
    capabilityId: 'engineering.playbook.record_selection',
    capabilityVersion: CAPABILITY_VERSION,
    effect: 'write',
    requiredScopes: [WRITE_SCOPE],
    requiredArguments: ['playbook_id', 'reason'],
    description: 'Record that a pinned playbook was selected for a task, in the (sandbox) external provider. Returns a verifiable effect receipt; a repeated operationId replays the same receipt instead of repeating the effect. Advisory: no GTD item is created.',
    permissions: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: WRITE_TRIGGERS },
    advisory: { requiresGtdId: false, mode: 'advisory' },
    transports: ['mcp:engineering_playbook_record_selection', 'internal-api'],
    execution: 'external_mutation',
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

/** Общий блок ответа: явные permissions/bindings, курсор корреляции, advisory-марк. */
function envelope(capability, { caller, binding, root, detail }) {
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
      reason: READ_ONLY_NO_PLAN,
      detail: detail || null,
    },
    advisory: { requiresGtdId: false, createsGtdId: false, gtdId: caller.gtdId ?? null, mode: capability.advisory.mode },
    correlation: {
      profileId: caller.profileId,
      userTaskId: caller.userTaskId ?? null,
      runId: caller.runId ?? null,
      operationId: caller.operationId ?? null,
    },
    provenance: {
      host: 'software-engineering-playbooks',
      definitionSource: 'playbooks/<id>.json',
      interface: capability.transports[0],
      artifactRoot: root,
      templatesVsInterface: 'playbooks/*.json are definitions; MCP tools and the internal API are only facades over these handlers',
    },
  };
}

function readOutcome(capability, { caller, binding, root, detail, body }) {
  return {
    kind: 'completed',
    result: { ...envelope(capability, { caller, binding, root, detail }), ...body },
  };
}

function technicalError(code, extra = {}) {
  return { kind: 'technical_error', code, ...extra };
}

/**
 * Хостовый gate: версия → обязательные аргументы → trusted envelope → scope binding'а.
 * Значение binding'а резолвит хост (bindingResolver) и в capability не попадает.
 */
function createCapabilityHost({ root, provider, log, bindingResolver, sourceRevision } = {}) {
  const resolvedRoot = resolveRoot(root);

  function invoke({ capabilityId, capabilityVersion, arguments: args = {}, caller = {}, binding, operationId, resolveBinding } = {}) {
    const envelopeFields = {
      profileId: caller.profileId ?? null,
      userTaskId: caller.userTaskId ?? null,
      runId: caller.runId ?? null,
      operationId: operationId || caller.operationId || null,
    };

    let capability;
    try {
      capability = getCapability(capabilityId, capabilityVersion);
    } catch (e) {
      log?.write('capability.rejected', { ...envelopeFields, capabilityId: String(capabilityId || null), capabilityVersion: capabilityVersion ?? null, from: null, to: 'refused', reasonCode: e.code, detail: e.message, details: e.details });
      throw e;
    }

    const correlation = { ...envelopeFields, capabilityId: capability.capabilityId, capabilityVersion: capability.capabilityVersion, bindingRef: binding ? binding.ref : null, bindingScope: binding ? binding.scope : null };
    log?.write('capability.received', { ...correlation, effect: capability.effect, requiredScopes: capability.requiredScopes, from: null, to: 'received', reasonCode: 'REQUEST_ACCEPTED' });

    const missing = capability.requiredArguments.filter(name => args[name] === undefined || args[name] === null || args[name] === '');
    if (missing.length > 0) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'MISSING_INPUT', missingFields: missing });
      return { kind: 'missing_input', fields: [...missing] };
    }

    if (!caller.profileId) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'NO_TRUSTED_CALLER', detail: 'profileId is missing in the trusted caller envelope' });
      return { kind: 'blocked', reason: 'no profile in the trusted caller envelope; a capability is never invoked on behalf of an unidentified principal' };
    }

    if (capability.requiredScopes.length > 0) {
      if (!binding) {
        log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'BINDING_REQUIRED', requiredScopes: capability.requiredScopes });
        return { kind: 'blocked', reason: `capability "${capability.capabilityId}" requires a credential binding with scope ${capability.requiredScopes.join('|')} and the caller has none` };
      }
      if (!capability.requiredScopes.includes(binding.scope)) {
        const error = new CapabilityError('BINDING_SCOPE_MISSING', `credential binding "${binding.ref}" has scope "${binding.scope}", capability "${capability.capabilityId}" requires ${capability.requiredScopes.join('|')}`, {
          capabilityId: capability.capabilityId,
          bindingRef: binding.ref,
          bindingScope: binding.scope,
          requiredScopes: [...capability.requiredScopes],
        });
        log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: error.code });
        throw error;
      }
    }

    // Зна binding'а резолвит хост: либо переданный на этот вызов resolveBinding
    // (фасад MCP), либо host-wide bindingResolver (внутренний API). Ни один из путей
    // не берёт значение из аргументов модели.
    const resolver = typeof resolveBinding === 'function' ? resolveBinding : bindingResolver;
    const bindingValue = binding && typeof resolver === 'function'
      ? resolver({ ref: binding.ref, scope: binding.scope, profileId: caller.profileId, capabilityId: capability.capabilityId })
      : undefined;
    if (capability.requiredScopes.length > 0 && !bindingValue) {
      log?.write('capability.refused', { ...correlation, from: 'received', to: 'refused', reasonCode: 'BINDING_VALUE_UNRESOLVED', detail: 'host could not resolve a value for this binding ref' });
      return { kind: 'blocked', reason: `credential binding "${binding.ref}" could not be resolved by the host for scope ${binding.scope}` };
    }

    log?.write('capability.validated', { ...correlation, from: 'received', to: 'validated', reasonCode: 'ARGS_AND_SCOPE_OK' });
    const outcome = dispatch(capability, { args, caller: { ...caller, operationId: envelopeFields.operationId }, binding, bindingValue, correlation });
    return finish(capability, outcome, correlation);
  }

  function dispatch(capability, { args, caller, binding, bindingValue, correlation }) {
    if (capability.capabilityId === 'engineering.playbook.list') {
      const artifacts = listPinnedPlaybooks({ root: resolvedRoot });
      log?.write('artifact.listed', { ...correlation, artifactCount: artifacts.length, from: 'validated', to: 'settled', reasonCode: 'CATALOG_RESOLVED' });
      return readOutcome(capability, {
        caller,
        binding,
        root: resolvedRoot,
        detail: 'catalog',
        body: { artifacts, counts: { artifacts: artifacts.length } },
      });
    }

    if (capability.capabilityId === 'engineering.playbook.get') {
      const detail = args.detail === 'full' ? 'full' : 'summary';
      try {
        const { descriptor, definition } = resolvePinnedPlaybook({
          root: resolvedRoot,
          playbookId: String(args.playbook_id),
          playbookVersion: args.playbook_version,
          expectedHash: args.expected_artifact_hash,
          detail,
          sourceRevision,
        });
        log?.write('artifact.resolved', { ...correlation, playbookId: descriptor.id, playbookVersion: descriptor.version, artifactRef: descriptor.artifactRef, artifactHash: descriptor.artifactHash, detail, from: 'validated', to: 'settled', reasonCode: 'ARTIFACT_PINNED' });
        return readOutcome(capability, {
          caller,
          binding,
          root: resolvedRoot,
          detail,
          body: { playbook: descriptor, definition },
        });
      } catch (e) {
        if (!(e instanceof CapabilityError)) throw e;
        log?.write('capability.failed', { ...correlation, playbookId: String(args.playbook_id), from: 'validated', to: 'failed', reasonCode: e.code, detail: e.message, details: e.details });
        return technicalError(e.code, { details: e.details });
      }
    }

    // engineering.playbook.record_selection
    const playbookId = String(args.playbook_id);
    try {
      const { descriptor } = resolvePinnedPlaybook({ root: resolvedRoot, playbookId, playbookVersion: args.playbook_version, sourceRevision });
      log?.write('artifact.resolved', { ...correlation, playbookId: descriptor.id, playbookVersion: descriptor.version, artifactRef: descriptor.artifactRef, artifactHash: descriptor.artifactHash, from: 'validated', to: 'settled', reasonCode: 'ARTIFACT_PINNED' });
      correlation.playbookId = descriptor.id;
      correlation.playbookVersion = descriptor.version;
    } catch (e) {
      if (!(e instanceof CapabilityError)) throw e;
      log?.write('capability.failed', { ...correlation, playbookId, from: 'validated', to: 'failed', reasonCode: e.code, detail: e.message, details: e.details });
      return technicalError(e.code, { details: e.details });
    }

    if (!provider) {
      log?.write('capability.refused', { ...correlation, from: 'validated', to: 'refused', reasonCode: 'PROVIDER_NOT_CONFIGURED' });
      return { kind: 'blocked', reason: 'no external provider is configured for this host; selection recording is unavailable' };
    }

    const applied = provider.recordSelection({
      operationId: correlation.operationId,
      profileId: caller.profileId,
      playbookId: correlation.playbookId,
      playbookVersion: correlation.playbookVersion,
      reason: args.reason,
      bindingRef: binding ? binding.ref : null,
      bindingScope: binding ? binding.scope : null,
      bindingValue,
    });

    if (applied.status === 'applied' || applied.status === 'replayed') {
      if (!applied.receipt || !applied.receipt.receiptId) {
        // «Ок» без проверяемой квитанции наружу не выходит (ловушка PR-16).
        log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_RECEIPT_MISSING', detail: 'provider reported success without a receipt' });
        return technicalError('PROVIDER_RECEIPT_MISSING');
      }
      log?.write(applied.status === 'replayed' ? 'provider.replay.confirmed' : 'provider.mutation.confirmed', {
        ...correlation,
        externalRef: applied.receipt.externalRef,
        receiptId: applied.receipt.receiptId,
        from: 'validated',
        to: 'settled',
        reasonCode: applied.status === 'replayed' ? 'REPLAY_SAME_RECEIPT_NO_SECOND_EFFECT' : 'RECEIPT_CONFIRMED',
      });
      return {
        kind: 'completed',
        result: {
          ...envelope(capability, { caller, binding, root: resolvedRoot, detail: 'external_mutation' }),
          execution: { kind: 'external_mutation', planStarted: false, planId: null, reason: 'SELECTION_RECORDED_NOT_EXECUTED', detail: 'recording a selection does not run the playbook' },
          selection: {
            playbookId: correlation.playbookId,
            playbookVersion: correlation.playbookVersion,
            reason: String(args.reason),
            recordedAt: applied.receipt.at,
            replayed: applied.status === 'replayed',
          },
          receipt: { ...applied.receipt },
          external: applied.externalRecord,
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

    if (applied.status === 'blocked') {
      log?.write('capability.refused', { ...correlation, from: 'validated', to: 'refused', reasonCode: 'PROVIDER_BLOCKED', detail: applied.reason });
      return { kind: 'blocked', reason: applied.reason };
    }
    if (applied.status === 'conflict') {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'REPLAY_CONFLICT', detail: 'operationId already recorded a different selection; no second effect was produced' });
      return technicalError('REPLAY_CONFLICT', { effectStateUnknown: false, reconcile: { operationId: correlation.operationId } });
    }
    if (applied.status === 'unknown') {
      log?.write('effect.unknown', { ...correlation, externalRef: applied.externalRecord.externalRef, from: 'validated', to: 'unknown', reasonCode: 'EFFECT_STATE_UNKNOWN', detail: 'provider applied the write but returned no receipt; do not retry blindly' });
      return technicalError('EFFECT_STATE_UNKNOWN', {
        effectStateUnknown: true,
        reconcile: { operationId: correlation.operationId, hint: 'resolve the outcome by operationId before any retry' },
      });
    }
    if (applied.status === 'acknowledged_without_receipt') {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_RECEIPT_MISSING', detail: 'provider acknowledged the call without a receipt' });
      return technicalError('PROVIDER_RECEIPT_MISSING');
    }
    log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'PROVIDER_UNREACHABLE' });
    return technicalError('PROVIDER_UNREACHABLE');
  }

  // Хостовая проверка write-handler'а: completed без effectReceipt наружу не выходит.
  function finish(capability, outcome, correlation) {
    if (capability.effect === 'write' && outcome.kind === 'completed' && !outcome.effectReceipt) {
      log?.write('capability.failed', { ...correlation, from: 'validated', to: 'failed', reasonCode: 'EFFECT_RECEIPT_MISSING', detail: 'write capability returned completed without a verifiable receipt' });
      return technicalError('EFFECT_RECEIPT_MISSING');
    }
    if (outcome.kind === 'completed' && outcome.result && outcome.result.advisory && outcome.result.advisory.requiresGtdId === false) {
      log?.write('advisory.settled', { ...correlation, from: 'settled', to: 'settled', reasonCode: 'ADVISORY_NO_GTD', gtdId: (outcome.result.advisory && outcome.result.advisory.gtdId) ?? null });
    }
    return outcome;
  }

  return {
    root: resolvedRoot,
    listCapabilities,
    invoke,
    describe: () => ({ root: resolvedRoot, capabilities: listCapabilities(), artifactCount: listPinnedPlaybooks({ root: resolvedRoot }).length, logFile: log ? log.file : null }),
  };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_OUTCOME_KINDS,
  CAPABILITY_VERSION,
  READ_SCOPE,
  WRITE_SCOPE,
  READ_ONLY_NO_PLAN,
  createCapabilityHost,
  getCapability,
  listCapabilities,
};
