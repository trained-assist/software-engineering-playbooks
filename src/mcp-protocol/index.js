'use strict';

// The protocol layer of this repository: one JSON-RPC frame and one stdio
// transport, shared by every MCP server it ships.
//
//   src/mcp-skills/index.js                    — the entry point
//   src/mcp-sandbox/transports/stdio-server.js — the sandbox server
//   src/mcp-sandbox/client.js                  — the sandbox client

const jsonrpc = require('./jsonrpc');
const stdio = require('./stdio');

module.exports = {
  ...jsonrpc,
  ...stdio,
  jsonrpc,
  stdio,
};
