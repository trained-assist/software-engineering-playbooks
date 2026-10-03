'use strict';

// Синтетический облачный CI (SANDBOX · I07: «synthetic CI provider», «virtual
// clock + synthetic CI/events»). Это фикстура, а не GitHub: сетевых вызовов нет.
//
// Что она обязана доказывать (AC-143 «PR → CI → verify gates имеют evidence» и
// находка §3 REVIEW-WITH-REAL-PLAYBOOKS):
//
//   1. dispatch происходит ОДИН раз. Повторное чтение результата — это poll уже
//      существующего run'а, а не второй dispatch;
//   2. run_id внешнего сервиса — не платформенный runId: возвращается
//      externalOperationRef={provider, kind, id}, платформа своего runId не имеет;
//   3. потерянный ACK dispatch'а — это НЕ «повторить»: исход неизвестен, и
//      reconcile по operationId находит уже созданный run;
//   4. красный CI и вечно-красный CI — разные исходы: первый даёт структурный
//      outcome шага, второй исчерпывает попытки гейта и останавливает план.
//
// Состояние на диске под изолированным root: внешний эффект настоящий (файл
// запуска), поэтому «ровно один dispatch» — проверяемый факт, а не счётчик в RAM.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNS_DIR = 'ci-runs';
const FAULT_MODES = ['none', 'lost_dispatch_ack', 'never_green'];

// Порядок сценария CI задаётся снаружи, чтобы песочница была детерминированной:
// conclusions — по порядку вызовов poll для конкретного шага плана.
const DEFAULT_CONCLUSIONS = ['pending', 'red', 'pending', 'green'];

function runIdFor(operationId) {
  return `ci_${crypto.createHash('sha256').update(String(operationId)).digest('hex').slice(0, 12)}`;
}

function fileFor(root, runId) {
  return path.join(root, RUNS_DIR, `${runId}.json`);
}

function readRun(root, runId) {
  const file = fileFor(root, runId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeRun(root, run) {
  fs.mkdirSync(path.join(root, RUNS_DIR), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileFor(root, run.id), `${JSON.stringify(run)}\n`, { mode: 0o600 });
  return run;
}

function nextConclusion(script, { stepId, pollIndex }) {
  if (typeof script === 'function') return script({ stepId, pollIndex });
  const list = Array.isArray(script) ? script : DEFAULT_CONCLUSIONS;
  return list[Math.min(pollIndex, list.length - 1)];
}

/**
 * @param {object} options
 * @param {string} options.root изолированный каталог песочницы (обязателен)
 * @param {() => Date} [options.clock] виртуальные часы: песочница не ждёт реально
 * @param {Array|Function} [options.conclusions] сценарий исходов CI
 * @param {'none'|'lost_dispatch_ack'|'never_green'} [options.fault]
 */
function createCloudCiProvider({ root, clock = () => new Date(), conclusions, fault = 'none' } = {}) {
  if (!root) throw new Error('synthetic cloud CI requires an isolated root (never a production data root)');
  if (!FAULT_MODES.includes(fault)) throw new Error(`unknown fault "${fault}"; expected one of ${FAULT_MODES.join('|')}`);

  let dispatchCount = 0;
  const pollCounts = new Map();

  function index() {
    const dir = path.join(root, RUNS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => readRun(root, file.replace(/\.json$/, '')))
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    root,
    fault,
    storeDir: path.join(root, RUNS_DIR),
    dispatchCount: () => dispatchCount,
    pollCount: stepId => pollCounts.get(stepId) || 0,
    index,

    /**
     * Запуск тестов в облаке. Happens-once по operationId: повтор с тем же
     * operationId не создаёт второй run (эффект уже был), а потерянный ACK
     * возвращает unknown + reconcile-ссылку, а не «успех» и не «повторить».
     */
    dispatch({ operationId, planId, stepId, branch = 'sandbox-branch' }) {
      if (!operationId) throw new Error('cloud CI dispatch requires an operationId: an external mutation without one cannot be deduplicated');
      const existing = index().find(run => run.operationId === operationId);
      if (existing) {
        return { status: 'replayed', dispatchCount, run: publicRun(existing) };
      }
      const id = runIdFor(operationId);
      const run = {
        id,
        // Внешний идентификатор провайдера. Платформенным runId он не является.
        externalRef: { provider: 'github', kind: 'actions_run', id },
        operationId,
        planId,
        stepId,
        branch,
        pollIndex: 0,
        conclusion: null,
        createdAt: clock().toISOString(),
      };
      writeRun(root, run);
      dispatchCount += 1;

      if (fault === 'lost_dispatch_ack') {
        // Эффект произошёл, квитанция не дошла: состояние неизвестно.
        return { status: 'unknown', dispatchCount, run: publicRun(readRun(root, id)), reconcile: { operationId } };
      }
      return { status: 'dispatched', dispatchCount, run: publicRun(readRun(root, id)) };
    },

    /** Чтение состояния существующего run'а. Никогда не создаёт новый. */
    poll({ externalRef, stepId }) {
      const id = typeof externalRef === 'string' ? externalRef : externalRef && externalRef.id;
      if (!id) throw new Error('poll requires the external operation ref recorded at dispatch; dispatching again would be a second run');
      const run = readRun(root, id);
      if (!run) return { status: 'unknown_run', externalRef: externalRef || null, reconcile: { externalId: id } };
      const pollIndex = pollCounts.get(stepId || run.stepId) || 0;
      pollCounts.set(stepId || run.stepId, pollIndex + 1);
      run.pollIndex = pollIndex + 1;

      let conclusion = nextConclusion(conclusions, { stepId: run.stepId, pollIndex });
      if (fault === 'never_green') conclusion = conclusion === 'green' ? 'red' : conclusion;
      run.conclusion = conclusion;
      writeRun(root, run);

      if (conclusion === 'pending') {
        return { status: 'pending', run: publicRun(run) };
      }
      return { status: 'completed', conclusion, run: publicRun(run) };
    },

    /** Reconcile по operationId: найти уже созданный run после потерянного ACK. */
    reconcile({ operationId }) {
      const run = index().find(candidate => candidate.operationId === operationId);
      return run
        ? { found: true, run: publicRun(run) }
        : { found: false, run: null, hint: 'no run exists for this operationId; a fresh dispatch is safe only after this check' };
    },
  };
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    externalRef: run.externalRef,
    operationId: run.operationId,
    planId: run.planId,
    stepId: run.stepId,
    branch: run.branch,
    conclusion: run.conclusion,
    pollIndex: run.pollIndex,
    createdAt: run.createdAt,
  };
}

module.exports = { DEFAULT_CONCLUSIONS, FAULT_MODES, RUNS_DIR, createCloudCiProvider, runIdFor };