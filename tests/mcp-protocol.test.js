'use strict';

// The stack used to speak three different JSON-RPC frames (issue #164,
// finding 6): one per server, each written by hand, each disagreeing about
// the details. These tests are the guard against that coming back.
//
// They are architectural tests, not behaviour tests: they look at the SOURCE
// of the repository and assert that there is exactly one frame, exactly one
// entry point, and that everything that speaks MCP uses them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createTransport, initializeResult, jsonrpc, serveStdio } = require('../src/mcp-protocol');

const ROOT = path.join(__dirname, '..');

function sourceFiles(dir, filter = () => true) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full, filter));
    else if (filter(full)) found.push(full);
  }
  return found;
}

const repoSourceFiles = () => sourceFiles(path.join(ROOT, 'src'), file => file.endsWith('.js'));

test('the JSON-RPC frame exists exactly once in the repository', () => {
  const frames = repoSourceFiles().filter(file => /JSONRPC_VERSION\s*=|function\s+resultResponse|function\s+errorResponse/.test(
    fs.readFileSync(file, 'utf8'),
  ));
  const relative = frames.map(file => path.relative(ROOT, file)).sort();
  assert.deepEqual(relative, ['src/mcp-protocol/jsonrpc.js'],
    `the frame must be written once — found: ${relative.join(', ')}`);
});

test('every MCP server and client of the repository uses the shared protocol layer', () => {
  const users = [
    'src/mcp-skills/index.js',
    'src/mcp-skills/providers/checklists.js',
    'src/mcp-sandbox/transports/stdio-server.js',
    'src/mcp-sandbox/client.js',
  ];
  for (const file of users) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /require\((['"])[^'"]*mcp-protocol\1\)/, `${file} must use the shared protocol layer`);
  }
});

test('there is exactly one stdio entry point of the engineering stack', () => {
  const entrypoints = repoSourceFiles().filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return /require\.main\s*===\s*module/.test(source) && /serveStdio/.test(source);
  });
  const relative = entrypoints.map(file => path.relative(ROOT, file)).sort();

  // The sandbox server is a per-run child process of the sandbox domain, not a
  // server of the host composition — it is declared nowhere in mcp-servers.json
  // on purpose.
  assert.deepEqual(relative.filter(file => !file.startsWith('src/mcp-sandbox/')), ['src/mcp-skills/index.js'],
    `one entry point, one process — found: ${relative.join(', ')}`);
  assert.deepEqual(relative.filter(file => file.startsWith('src/mcp-sandbox/')), ['src/mcp-sandbox/transports/stdio-server.js']);

  const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-servers.json'), 'utf8'));
  for (const server of Object.values(declaration.servers)) {
    assert.notEqual(server.source && server.source.entrypoint, 'src/mcp-sandbox/transports/stdio-server.js',
      'the sandbox server is not part of the host composition');
  }

  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'mcp-checklists', 'index.js')), false,
    'the checklist surface is a provider of the entry point, not a server of its own');
});

test('the frame answers a request with the JSON-RPC envelope', () => {
  const transport = createTransport({
    handlers: {
      initialize: () => initializeResult({ name: 'test-server', version: '1.0.0' }),
      'tools/list': () => ({ tools: [{ name: 'a_tool' }] }),
    },
  });
  return transport.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }).then(response => {
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'test-server');
    assert.equal(response.result.protocolVersion, '2024-11-05');
  });
});

test('an unknown method is an explicit refusal, not silence', () => {
  const transport = createTransport({ handlers: {} });
  return transport.handle({ jsonrpc: '2.0', id: 7, method: 'nope' }).then(response => {
    assert.equal(response.error.code, jsonrpc.RPC_ERROR_CODES.methodNotFound);
    assert.match(response.error.message, /Method not found: nope/);
  });
});

test('a notification is answered with silence', () => {
  const seen = [];
  const transport = createTransport({
    handlers: { 'tools/list': () => ({ tools: [] }) },
    onNotification: message => seen.push(message.method),
  });
  return transport.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }).then(response => {
    assert.equal(response, null);
    assert.deepEqual(seen, ['notifications/cancelled']);
  });
});

test('a failed call keeps its own code and never leaks a stack trace', () => {
  const transport = createTransport({
    handlers: {
      'tools/call': () => {
        throw new jsonrpc.JsonRpcError(jsonrpc.RPC_ERROR_CODES.invalidParams, 'Unknown tool: nope', { code: 'TOOL_NOT_IN_SCOPE' });
      },
    },
  });
  return transport.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }).then(response => {
    assert.equal(response.error.code, jsonrpc.RPC_ERROR_CODES.invalidParams);
    assert.equal(response.error.message, 'Unknown tool: nope');
    assert.deepEqual(response.error.data, { code: 'TOOL_NOT_IN_SCOPE' });
    assert.doesNotMatch(JSON.stringify(response), /at .*\.js:\d+/, 'the answer does not carry a stack trace');
  });
});

test('the transport frames a stream of lines and answers each of them', async () => {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', chunk => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)));

  serveStdio({
    handlers: { 'tools/list': () => ({ tools: [{ name: 'a_tool' }] }) },
    input,
    output,
  });

  input.write(`${jsonrpc.encode({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\r`);
  input.write('\n');
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(lines.length, 1, 'one answer per request');
  const answer = JSON.parse(lines[0]);
  assert.equal(answer.id, 1);
  assert.deepEqual(answer.result.tools, [{ name: 'a_tool' }]);
});
