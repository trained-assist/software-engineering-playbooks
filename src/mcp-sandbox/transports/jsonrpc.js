'use strict';

// JSON-RPC 2.0 по stdio (newline-delimited JSON) — тот же кадр, что используют
// MCP-серверы и что описан в P13 (ai-agent-runner src/mcp/jsonrpc.ts, PR #46).
// Клиент и сервер песочницы делят этот модуль: расхождение кадра между сторонами
// сделало бы проверку контракта бессмысленной.

const JSONRPC_VERSION = '2.0';

// Стандартные коды JSON-RPC + наши для транспортных отказов (те же имена, что в P13).
const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Инструмент вне scoped bindings рана (приёмка AC-115: чужой binding недоступен). */
  toolNotInScope: -32001,
  /** Транспорт/таймаут на стороне MCP-сервера. */
  transportTimeout: -32002,
  /** Старт сервера не удался: binding не объявлен/просрочен (P13: MCP_STARTUP_FAILED). */
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
