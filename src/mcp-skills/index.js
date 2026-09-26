#!/usr/bin/env node
'use strict';

const readline = require('readline');
const registry = require('./registry');
const { toolResultText } = require('./tool-result');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

rl.on('line', async line => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trained-assist-engineering', version: '0.2.0' } });
    } else if (method === 'tools/list') {
      result(id, { tools: registry.listTools() });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const value = await registry.callTool(name, args || {});
      result(id, { content: [{ type: 'text', text: toolResultText(name, value) }] });
    } else {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    error(id, -32603, e.message);
  }
});
process.stdin.resume();
