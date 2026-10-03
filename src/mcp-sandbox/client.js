'use strict';

// Клиенты транспортных фасадов P15 (эпик E5 #21, этап I04) — сторона хоста, которая
// дёргает MCP-сервер по stdio и внутренний API по HTTP точно так, как это делал бы
// runner в бою (P13: per-run stdio процесс + POST /v1/capabilities/invoke).
//
// Паритет фасадов (AC-117) проверяется не «на глаз», а канонической формой outcome:
// один и тот же вызов через оба транспорта обязан дать побайтово одинаковый outcome.
// Транспортные обёртки (content/structuredContent у MCP, HTTP-статусы) снимаются
// здесь же — иначе сравнивались бы два разных представления одного результата.

const { spawn } = require('child_process');
const jsonrpc = require('./transports/jsonrpc');

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Каноническая форма outcome — то, что сравнивается между транспортами. */
function outcomeFingerprint(outcome) {
  return stableStringify(outcome || {});
}

/** Извлечь outcome из ответа транспорта: обёртки разные, outcome один. */
function extractOutcome(response, transport) {
  if (transport === 'mcp-stdio') {
    if (response && response.structuredContent) return response.structuredContent;
    if (response && Array.isArray(response.content)) {
      const text = response.content.find(item => item && item.type === 'text');
      if (text) {
        try {
          return JSON.parse(text.text);
        } catch {
          return { kind: 'unparsable', text: String(text.text).slice(0, 200) };
        }
      }
    }
    return { kind: 'unknown_response', response };
  }
  return response;
}

class TransportFailure extends Error {
  constructor(reason, message, code = null) {
    super(message);
    this.name = 'TransportFailure';
    this.reason = reason;
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.command исполняемый файл (node)
 * @param {string[]} options.args аргументы процесса
 * @param {object} options.env окружение, которое внедряет хост (allowlist)
 * @param {number} [options.timeoutMs] дедлайн вызова
 * @param {(line: string) => void} [options.onStderr]
 */
function createStdioRpcClient({ command, args = [], env = {}, timeoutMs = 5000, onStderr } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const stderrLines = [];
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message.id !== 'undefined' && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        clearTimeout(timer);
        pending.delete(message.id);
        if (message.error) {
          reject(new TransportFailure('rpc_error', message.error.message, message.error.code));
        } else {
          resolve(message.result);
        }
      }
    }
  });
  child.stdout.on('end', () => failAll(new TransportFailure('transport_closed', 'mcp server closed its stdout')));
  child.stdout.on('error', () => failAll(new TransportFailure('transport_closed', 'mcp server stdout failed')));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) continue;
      stderrLines.push(line);
      if (typeof onStderr === 'function') onStderr(line);
    }
  });

  function failAll(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    closed = true;
  }

  function call(method, params) {
    if (closed) return Promise.reject(new TransportFailure('transport_closed', 'this client is closed (fail-closed after a timeout)'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Зависший инструмент: клиент больше не ждёт и не пускает новые вызовы.
        failAll(new TransportFailure('timeout', `no response from the mcp server within ${timeoutMs}ms`, jsonrpc.RPC_ERROR_CODES.transportTimeout));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(jsonrpc.encode({ jsonrpc: jsonrpc.JSONRPC_VERSION, id, method, params }));
    });
  }

  function notify(method, params) {
    if (closed) return false;
    child.stdin.write(jsonrpc.encode({ jsonrpc: jsonrpc.JSONRPC_VERSION, method, params }));
    return true;
  }

  function close({ graceMs = 200 } = {}) {
    return new Promise(resolve => {
      if (closed || child.exitCode !== null || child.killed) {
        resolve({ signal: null, exited: true });
        return;
      }
      let settled = false;
      const finish = signal => {
        if (settled) return;
        settled = true;
        resolve({ signal, exited: true });
      };
      child.once('exit', () => finish('SIGTERM'));
      try {
        child.kill('SIGTERM');
      } catch {
        finish('SIGTERM');
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* уже мёртв */
        }
        finish('SIGKILL');
      }, graceMs);
    });
  }

  return {
    child,
    call,
    notify,
    close,
    stderrLines,
    get closed() {
      return closed;
    },
    get pid() {
      return child.pid;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.baseUrl например http://127.0.0.1:41234
 * @param {string} [options.token] токен хоста
 * @param {number} [options.timeoutMs]
 */
function createHttpApiClient({ baseUrl, token = '', timeoutMs = 5000 } = {}) {
  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { kind: 'unparsable', text: text.slice(0, 200) };
      }
      return { status: response.status, body: parsed };
    } catch (e) {
      // undici при прерывании может бросить и AbortError, и TypeError с cause —
      // надёжный признак нашего собственного дедлайна это сам signal.
      if (controller.signal.aborted || (e && (e.name === 'AbortError' || (e.cause && e.cause.name === 'AbortError')))) {
        return { status: 0, body: { kind: 'transport_timeout', reason: `no response within ${timeoutMs}ms` }, timedOut: true };
      }
      return { status: 0, body: { kind: 'transport_failed', reason: e.message } };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: path => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

module.exports = {
  createStdioRpcClient,
  createHttpApiClient,
  outcomeFingerprint,
  extractOutcome,
  TransportFailure,
  stableStringify,
};
