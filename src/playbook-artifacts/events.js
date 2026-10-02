'use strict';

// Event log домена playbook-артефактов (SANDBOX · I04, строка «Logs»).
//
// Каждая строка — JSON с обязательной коррефляцией (profileId / userTaskId / runId /
// operationId), ключом события и причиной перехода состояния. Значения credential
// binding'ов в лог не попадают: пишутся только ref и scope, а поля-кандидаты на
// секреты вычищаются по имени (см. FORBIDDEN_KEY).
//
// Формат совместим с общим Observability-контрактом: событие — плоский объект,
// `at` — ISO-время, лишних вложенных структур нет.

const fs = require('fs');
const path = require('path');

// Поля, которые нельзя писать в лог ни при каких условиях.
const FORBIDDEN_KEY = /(token|secret|password|passphrase|authorization|cookie|api_?key|binding_?value|credential_?value)/i;

const MAX_STRING = 512;

// Хостовые идентификаторы, которые есть в каждом событии. Отсутствие — это null,
// а не «не передали»: иначе в логе нельзя отличить headless-вызов от рана.
const CORRELATION_KEYS = ['profileId', 'userTaskId', 'runId', 'operationId'];

function scrubString(value) {
  if (typeof value !== 'string') return value;
  const home = process.env.HOME || '';
  let out = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (home && out.includes(home)) out = out.split(home).join('~');
  return out;
}

function scrub(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== 'object') return scrubString(String(value));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = scrub(item);
  }
  return out;
}

function eventLine(event, fields) {
  const line = { at: event.at, event: event.event };
  for (const key of CORRELATION_KEYS) line[key] = scrub(fields[key] ?? null);
  for (const [key, value] of Object.entries(fields)) {
    if (CORRELATION_KEYS.includes(key) || key === 'at' || key === 'event') continue;
    line[key] = scrub(value);
  }
  return line;
}

/**
 * Append-only JSONL лог. `file` отсутствует → только память (headless-вызов без
 * data root, тесты контракта). Писать в файл — только хостовая операция.
 */
function createEventLog({ file, now = () => new Date() } = {}) {
  const entries = [];
  let error = null;

  function write(name, fields = {}) {
    const line = eventLine({ at: now().toISOString(), event: name }, fields);
    entries.push(line);
    if (!file) return line;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (e) {
      error = e;
    }
    return line;
  }

  return {
    file: file || null,
    write,
    entries,
    /** Последняя ошибка записи — лог не должен ронять приёмку вызова, но должен быть виден. */
    writeError: () => (error ? error.message : null),
  };
}

function readEvents(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

module.exports = { createEventLog, readEvents, scrub, FORBIDDEN_KEY, CORRELATION_KEYS };
