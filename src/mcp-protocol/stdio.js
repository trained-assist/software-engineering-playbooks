'use strict';

// The ONE stdio transport of this repository.
//
// Before this module there were three hand-written implementations of the same
// thing — src/mcp-skills/index.js, src/mcp-checklists/index.js and
// src/mcp-sandbox/transports/stdio-server.js — each with its own line framing,
// its own idea of what an answer looks like and its own way of reporting a
// broken request. They drifted: one of them answered a request that carried no
// id, one of them answered an unknown method with a different message, and
// only one of them understood notifications.
//
// The transport owns everything that is transport:
//   - the frame: one JSON object per line, \r\n tolerated;
//   - the envelope: jsonrpc / id / result / error;
//   - notifications (answered with silence, as the protocol requires);
//   - the error codes.
//
// The server owns everything that is server: which tools exist and what they
// do. It plugs in through `handlers`.

const jsonrpc = require('./jsonrpc');

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

// A handler returns the RESULT of the call. Throwing is the way to answer with
// an error: a JsonRpcError carries its own code, any other error becomes
// -32603. Returning null/undefined means "answer nothing" (a notification, or
// a request the server deliberately drops).
function defaultOnError(id, error) {
  const code = error && typeof error.code === 'number'
    ? error.code
    : jsonrpc.RPC_ERROR_CODES.internalError;
  const message = error && error.message ? error.message : 'internal error';
  const data = error && error.data !== undefined ? error.data : undefined;
  return jsonrpc.errorResponse(id, code, message, data);
}

/**
 * Create the transport.
 *
 * @param {object} options
 * @param {Record<string, (params: object, message: object) => any>} options.handlers
 *        method name → handler. A handler receives the request params and the
 *        whole request message.
 * @param {(message: object) => void} [options.onNotification] called for every
 *        notification (requests without an id).
 * @param {(id: any, error: Error) => object} [options.onError] builds the
 *        answer for a failed call.
 */
function createTransport({ handlers = {}, onNotification = null, onError = defaultOnError } = {}) {
  return {
    async handle(message) {
      if (!message || typeof message !== 'object') return null;

      if (jsonrpc.isNotification(message)) {
        if (typeof onNotification === 'function') await onNotification(message);
        return null;
      }
      if (!jsonrpc.isRequest(message)) return null;

      const { id, method, params } = message;
      const handler = handlers[method];
      if (typeof handler !== 'function') {
        return jsonrpc.errorResponse(id, jsonrpc.RPC_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
      }

      try {
        const result = await handler(params || {}, message);
        if (result === undefined || result === null) return null;
        return jsonrpc.resultResponse(id, result);
      } catch (error) {
        return onError(id, error);
      }
    },
  };
}

/**
 * Serve MCP over stdio until stdin closes.
 *
 * @param {object} options
 * @param {Record<string, Function>} options.handlers method name → handler
 * @param {(message: object) => void} [options.onNotification]
 * @param {(id: any, error: Error) => object} [options.onError]
 * @param {() => void} [options.onEnd] called when stdin closes
 * @param {NodeJS.ReadableStream} [options.input] defaults to stdin
 * @param {NodeJS.WritableStream} [options.output] defaults to stdout
 * @returns {{ transport: object, stop: () => void }}
 */
function serveStdio({ handlers, onNotification, onError, onEnd, input = process.stdin, output = process.stdout } = {}) {
  const transport = createTransport({ handlers, onNotification, onError });
  let buffer = '';
  let stopped = false;

  const write = message => {
    try {
      output.write(jsonrpc.encode(message));
    } catch {
      /* the pipe is gone — nothing to answer on */
    }
  };

  const handleLine = async line => {
    if (!line || line.trim().length === 0) return;
    let message;
    try {
      message = jsonrpc.decodeLine(line);
    } catch (e) {
      write(jsonrpc.errorResponse(null, e.code || jsonrpc.RPC_ERROR_CODES.parseError, e.message));
      return;
    }
    try {
      const response = await transport.handle(message);
      if (response) write(response);
    } catch (e) {
      write(jsonrpc.errorResponse(null, jsonrpc.RPC_ERROR_CODES.internalError, e.message || 'internal error'));
    }
  };

  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      handleLine(line);
    }
  });
  input.on('end', () => {
    stopped = true;
    input.removeAllListeners('data');
    if (typeof onEnd === 'function') {
      try {
        onEnd();
      } catch {
        /* the log of a dying process is not worth a crash */
      }
    }
    // Give the answers that are already in flight a chance to be written.
    setImmediate(() => process.exit(0));
  });
  input.on('error', () => process.exit(0));
  input.resume();

  return {
    transport,
    stop() {
      stopped = true;
      input.removeAllListeners('data');
    },
    get stopped() {
      return stopped;
    },
  };
}

// The result of an initialize call, in the shape every MCP client expects.
function initializeResult({ protocolVersion = DEFAULT_PROTOCOL_VERSION, name, version, capabilities = { tools: {} } } = {}) {
  return {
    protocolVersion,
    capabilities,
    serverInfo: { name, version },
  };
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  createTransport,
  serveStdio,
  initializeResult,
  defaultOnError,
  jsonrpc,
};
