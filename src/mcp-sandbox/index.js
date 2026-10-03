'use strict';

// Точка входа песочничного домена P15 (эпик E5 #21, этап I04, карточка #54).
//
// Собирает готовый host: capability-контракт + event log + эмулятор внешнего домена.
// Два транспортных фасада (MCP stdio и внутренний HTTP API) используют ровно этот
// host — фасады разные, обработчик один (TASK-ROUTER-AND-MCP §5).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const errors = require('./errors');
const events = require('./../playbook-artifacts/events');
const providerFixture = require('./provider-fixture');
const capabilities = require('./capabilities');
const callbackInbox = require('./callback-inbox');

// События и их вычистка берутся из P14: второй формат лога этапа I04 не заводим.

const BINDING_STORE_DIR = 'bindings';

/** Файл значения binding'а в store: имя — хеш ref, права 0600. */
function bindingStoreFile(storeDir, ref) {
  return path.join(storeDir, `${crypto.createHash('sha256').update(String(ref)).digest('hex').slice(0, 32)}.value`);
}

/** Хостовая запись значения binding'а в store (песочница: синтетическая фикстура). */
function writeBindingValue(storeDir, ref, value) {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(bindingStoreFile(storeDir, ref), `${value}\n`, { mode: 0o600 });
  return bindingStoreFile(storeDir, ref);
}

/**
 * Host-owned резолвер значений credential binding'ов.
 *
 * Значение binding'а не приходит ни из аргументов модели, ни из окружения
 * дочернего процесса: сервер-фасад читает его из файла в изолированном store,
 * как Credential Broker (эпик #21, #30) читал бы из Secret Manager. В песочнице
 * там лежит синтетическая фикстура — не секрет, а доказательство канала.
 */
function createBindingStoreResolver({ storeDir } = {}) {
  return function resolveBindingValue({ ref } = {}) {
    if (!ref || !storeDir) return undefined;
    try {
      const value = fs.readFileSync(bindingStoreFile(storeDir, ref), 'utf8').trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * @param {object} options
 * @param {string} options.dataRoot изолированный корень песочницы (лог, store эмулятора, store binding'ов, inbox)
 * @param {string} [options.bindingsDir] каталог store binding'ов (по умолчанию `${dataRoot}/bindings`)
 * @param {() => Date} [options.clock]
 * @param {string} [options.providerFault] сценарий сбоя внешнего сервиса
 * @param {number} [options.providerDelayMs] задержка ответа в сценарии delay
 * @param {string} [options.callbackUrl] база inbox'а для обратных вызовов внешнего сервиса
 * @param {string} [options.callbackToken] токен внешнего сервиса (не токен хоста)
 * @param {(ctx: {ref: string, scope: string}) => string|undefined} [options.bindingResolver] свой резолвер вместо store
 */
function createSandboxDomainHost({
  dataRoot,
  bindingsDir,
  clock = () => new Date(),
  providerFault = 'success',
  providerDelayMs,
  callbackUrl = '',
  callbackToken = '',
  bindingResolver,
} = {}) {
  if (!dataRoot) throw new Error('sandbox domain host requires an isolated dataRoot');

  const resolvedBindingsDir = bindingsDir || path.join(dataRoot, BINDING_STORE_DIR);
  fs.mkdirSync(resolvedBindingsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(dataRoot, 'sandbox-domain', 'events.jsonl');
  const log = events.createEventLog({ file: logFile, now: clock });

  const provider = providerFixture.createRecruitingProviderFixture({
    root: path.join(dataRoot, 'provider'),
    clock,
    fault: providerFault,
    ...(providerDelayMs ? { delayMs: providerDelayMs } : {}),
    callbackUrl,
    callbackToken,
  });

  const inbox = callbackInbox.createCallbackInbox({
    root: path.join(dataRoot, 'inbox'),
    log,
    clock,
  });

  const host = capabilities.createCapabilityHost({
    provider,
    log,
    bindingResolver: bindingResolver || createBindingStoreResolver({ storeDir: resolvedBindingsDir }),
  });

  return {
    ...host,
    log,
    logFile,
    provider,
    inbox,
    dataRoot,
    bindingsDir: resolvedBindingsDir,
  };
}

module.exports = {
  ...errors,
  ...providerFixture,
  ...capabilities,
  createSandboxDomainHost,
  callbackInbox,
  createBindingStoreResolver,
  writeBindingValue,
  bindingStoreFile,
  BINDING_STORE_DIR,
  events,
};
