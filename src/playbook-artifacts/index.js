'use strict';

// Доменные capability playbook-артефактов (P14, эпик E5 #21, этап I04).
//
// Точка входа для обоих транспортных фасадов:
//   - внутренний API control plane: createCapabilityHost(...).invoke(...);
//   - MCP-тулы в src/mcp-skills/tools/70-playbook-artifacts.js.
//
// Фасады разные, обработчик один: доменная логика не дублируется в интерфейсе
// (TASK-ROUTER-AND-MCP §5 «Один domain handler имеет contract и разные transport
// facades»).

const errors = require('./errors');
const events = require('./events');
const artifact = require('./artifact');
const provider = require('./provider');
const capabilities = require('./capabilities');

/**
 * Собрать готовый host: capability-контракт + event log + фейковый провайдер выбора.
 *
 * @param {object} options
 * @param {string} [options.root] checkout с playbooks/ (по умолчанию — этот репозиторий)
 * @param {string} [options.dataRoot] изолированный корень данных песочницы (лог + store провайдера)
 * @param {string} [options.profileId] профиль для пути лога (только из trusted env, не из аргументов)
 * @param {() => Date} [options.clock]
 * @param {(ctx: {ref: string, scope: string}) => string|undefined} [options.bindingResolver] хостовый резолвер значения binding'а
 * @param {string} [options.providerFault] управляемый сбой фейкового провайдера
 * @param {string} [options.sourceRevision] зафиксированная ревизия источника для evidence
 */
function createPlaybookArtifactHost({
  root,
  dataRoot,
  profileId,
  clock = () => new Date(),
  bindingResolver,
  providerFault = 'none',
  sourceRevision = null,
} = {}) {
  const resolvedRoot = artifact.resolveRoot(root);
  const logFile = dataRoot ? `${dataRoot}/playbook-artifacts/events.jsonl` : null;
  const log = events.createEventLog({ file: logFile, clock });
  const selectionProvider = provider.createFakeSelectionProvider({ root: dataRoot || `${resolvedRoot}/.sandbox/provider-default`, clock, fault: providerFault });

  const host = capabilities.createCapabilityHost({
    root: resolvedRoot,
    provider: selectionProvider,
    log,
    bindingResolver,
    sourceRevision,
  });

  return {
    ...host,
    log,
    logFile,
    provider: selectionProvider,
    artifactRoot: resolvedRoot,
    profileId: profileId || null,
  };
}

module.exports = {
  ...errors,
  ...events,
  ...capabilities,
  ...artifact,
  ...provider,
  createPlaybookArtifactHost,
};
