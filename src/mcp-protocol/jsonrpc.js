'use strict';

// JSON-RPC 2.0 over stdio (newline-delimited JSON) — the frame every MCP server
// in this repository speaks, and the frame described in P13
// (ai-agent-runner src/mcp/jsonrpc.ts, PR #46).
//
// This module used to live at src/mcp-sandbox/transports/jsonrpc.js and was
// used by the sandbox client and the sandbox stdio server only. The other two
// MCP servers of this repository each had their own hand-written copy of the
// same frame, and they disagreed about details that matter: one answered
// without the "jsonrpc" field, one answered a request that had no id, one
// lost the answer of a cancelled request.
//
// Now there is ONE frame module for the whole stack, and the sandbox client
// and the sandbox stdio server share it — a divergence of the frame between
// the two sides would make the contract check meaningless.

const JSONRPC_VERSION = '2.0';

// Standard JSON-RPC codes plus the transport failures of this stack (the same
// names as in P13).
const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** A tool outside the scoped bindings of the run (acceptance AC-115: a foreign binding is unreachable). */
  toolNotInScope: -32001,
  /** Transport/timeout on the MCP server side. */
  transportTimeout: -32002,
  /** The server did not start: a binding is not declared/expired (P13: MCP_STARTUP_FAILED). */
  mcpStartupFailed: -32003,
};

class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

function decodeLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    throw new JsonRpcError(RPC_ERROR_CODES.parseError, `parse error: ${e.message}`);
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== JSONRPC_VERSION) {
    throw new JsonRpcError(RPC_ERROR_CODES.invalidRequest, 'invalid Request: jsonrpc must be "2.0"');
  }
  return message;
}

function isRequest(message) {
  return message && typeof message.id !== 'undefined' && typeof message.method === 'string';
}

function isNotification(message) {
  return message && typeof message.method === 'string' && typeof message.id === 'undefined';
}

function isResponse(message) {
  return message && (typeof message.result !== 'undefined' || message.error) && typeof message.method === 'undefined';
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error };
}

function resultResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, result };
}

module.exports = {
  JSONRPC_VERSION,
  RPC_ERROR_CODES,
  JsonRpcError,
  encode,
  decodeLine,
  isRequest,
  isNotification,
  isResponse,
  errorResponse,
  resultResponse,
};
