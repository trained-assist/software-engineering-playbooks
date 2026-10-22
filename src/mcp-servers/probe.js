'use strict';

// Ask a stdio MCP server for its tool list.
//
// The servers in this stack speak line-delimited JSON-RPC over stdin/stdout:
// one JSON object per line in, one per line out. A probe is therefore
// "write initialize, wait for its answer, write tools/list, read the tools".
//
// The point of the probe is to see the catalog as the HOST sees it — a tool
// name that two servers both publish is a silent shadowing bug in the agent
// context, and no static file in the repo can prove it is gone.

const { spawn } = require('child_process');

function parseMessages(buffer, onMessage) {
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    onMessage(message);
  }
  return buffer;
}

// `command` is the argv the host uses to start the server (node + entrypoint).
// Resolves to { ok, tools: string[], error } — never throws.
function probeTools(command, { timeoutMs = 30000, env } = {}) {
  return new Promise(resolve => {
    if (!Array.isArray(command) || command.length === 0) {
      resolve({ ok: false, tools: [], error: 'no command' });
      return;
    }
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...env },
      });
    } catch (error) {
      resolve({ ok: false, tools: [], error: error.message });
      return;
    }

    let buffer = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, tools: [], error: `no answer within ${timeoutMs}ms` }),
      timeoutMs,
    );

    const write = message => {
      try { child.stdin.write(JSON.stringify(message) + '\n'); } catch (error) {
        finish({ ok: false, tools: [], error: error.message });
      }
    };

    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      buffer = parseMessages(buffer, message => {
        if (message.id === 1 && message.result && Array.isArray(message.result.tools)) {
          finish({ ok: true, tools: message.result.tools.map(t => t && t.name).filter(Boolean), error: null });
        }
      });
    });
    child.on('error', error => finish({ ok: false, tools: [], error: error.message }));
    child.on('exit', code => finish({ ok: false, tools: [], error: `exited with code ${code}` }));

    // initialize first: a server that enforces the MCP handshake rejects
    // tools/list before it has answered initialize.
    write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-mcp-servers', version: '1.0.0' } } });
    setTimeout(() => {
      if (settled) return;
      write({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    }, 50);
  });
}

module.exports = { probeTools };
