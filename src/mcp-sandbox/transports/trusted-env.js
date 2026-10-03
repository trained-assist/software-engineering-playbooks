'use strict';

// Trusted envelope хоста для транспортных фасадов P15 (эпик E5 #21, этап I04).
//
// Правило то же, что в P13 (ai-agent-runner src/mcp/scope.ts): дочерний процесс и
// HTTP-фасад не могут выбрать, под каким binding'ом и от чьего имени исполнить
// действие. Поэтому profileId / userTaskId / runId / operationId / replyContext /
// bindings приходят ТОЛЬКО из окружения, которое внедряет хост (env allowlist), и
// никогда из аргументов модели и никогда из тела запроса.
//
// Значения binding'ов здесь не читаются: их резолвит host-owned резолвер
// (createBindingStoreResolver), а сюда попадают только ref/scope/status — как в P13,
// где значения живут только в процессе хоста.

const BINDING_STATUSES = ['ok', 'missing', 'expired'];

function parseJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseList(value) {
  const parsed = parseJson(value, null);
  if (Array.isArray(parsed)) return parsed;
  if (typeof value === 'string' && value.trim().length > 0) return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

function parseClock(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return () => new Date(date.getTime());
}

/**
 * @param {object} [env] окружение хоста (по умолчанию process.env)
 * @returns {{profileId: string|null, userTaskId: string|null, runId: string|null, gtdId: string|null, operationId: string|null, replyContext: object|null, bindings: Array, allowedTools: string[], hostToken: string, callbackToken: string, dataRoot: string|null, providerFault: string, providerDelayMs: number|null, callbackUrl: string, clock: (() => Date)|null}}
 */
function readTrustedEnv(env = process.env) {
  const bindings = parseList(env.SANDBOX_BINDINGS).map(entry => ({
    ref: typeof entry === 'string' ? entry : entry.ref,
    scope: typeof entry === 'string' ? null : entry.scope,
    status: typeof entry === 'string' ? 'ok' : (entry.status || 'ok'),
  })).filter(entry => entry.ref);

  return {
    profileId: env.SANDBOX_PROFILE_ID || null,
    userTaskId: env.SANDBOX_USER_TASK_ID || null,
    runId: env.SANDBOX_RUN_ID || null,
    gtdId: env.SANDBOX_GTD_ID || null,
    operationId: env.SANDBOX_OPERATION_ID || null,
    replyContext: parseJson(env.SANDBOX_REPLY_CONTEXT, null),
    bindings,
    allowedTools: parseList(env.SANDBOX_ALLOWED_TOOLS),
    hostToken: env.SANDBOX_HOST_TOKEN || '',
    callbackToken: env.SANDBOX_CALLBACK_TOKEN || '',
    dataRoot: env.SANDBOX_DATA_ROOT || null,
    providerFault: env.SANDBOX_PROVIDER_FAULT || 'success',
    providerDelayMs: env.SANDBOX_PROVIDER_DELAY_MS ? Number(env.SANDBOX_PROVIDER_DELAY_MS) : null,
    callbackUrl: env.SANDBOX_CALLBACK_URL || '',
    clock: parseClock(env.SANDBOX_CLOCK),
  };
}

function callerFrom(trusted) {
  return {
    profileId: trusted.profileId,
    userTaskId: trusted.userTaskId,
    runId: trusted.runId,
    gtdId: trusted.gtdId,
    operationId: trusted.operationId,
    replyContext: trusted.replyContext,
  };
}

/**
 * Выбор binding'а: сначала подходящий по scope, иначе первый объявленный — чтобы чужой
 * scope дал явный отказ хоста (BINDING_SCOPE_MISSING), а не «binding'а нет».
 */
function bindingFor(trusted, requiredScopes) {
  const provided = (trusted.bindings || []).filter(Boolean);
  return provided.find(binding => requiredScopes.includes(binding.scope)) || provided[0] || null;
}

/** Статус объявленного binding'а: missing/expired — отказ до спавна (P13, слой 1). */
function bindingStatus(trusted, ref) {
  const declared = (trusted.bindings || []).find(binding => binding && binding.ref === ref);
  if (!declared) return 'missing';
  return declared.status === 'ok' ? 'ok' : declared.status;
}

function hasExpiredOrMissingBinding(trusted) {
  return (trusted.bindings || []).some(binding => binding && binding.status !== 'ok');
}

module.exports = {
  BINDING_STATUSES,
  readTrustedEnv,
  callerFrom,
  bindingFor,
  bindingStatus,
  hasExpiredOrMissingBinding,
};
