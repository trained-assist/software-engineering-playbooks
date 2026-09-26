'use strict';
// agent#1481: the MCP server must never return an empty tools/call text.
// Spawns the REAL src/mcp-skills/index.js with a stubbed registry (see helpers/).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'src', 'mcp-skills', 'index.js');
const preload = path.join(__dirname, 'helpers', 'stub-registry-preload.cjs');

function startServer() {
  const child = spawn(process.execPath, ['--require', preload, server], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call };
}

test('tools/call never yields an empty text result', async () => {
  const { child, call } = startServer();
  try {
    const init = await call('initialize', {});
    assert.ok(init.result && init.result.serverInfo, 'initialize responded');

    const empties = [
      ['absent', {}],
      ["''", { value: '' }],
      ["'   '", { value: '   ' }],
      ['[]', { value: [] }],
      ['{}', { value: {} }],
      ['null', { value: null }],
    ];
    for (const [label, args] of empties) {
      const res = await call('tools/call', { name: 'probe', arguments: args });
      assert.ok(!res.error, `${label}: unexpected error ${JSON.stringify(res.error)}`);
      const text = res.result.content[0].text;
      assert.ok(typeof text === 'string' && text.trim(), `${label}: text must be non-blank`);
      assert.match(text, /пустой результат/, `${label}: must carry the empty-result marker`);
      assert.match(text, /probe/, `${label}: must name the tool`);
    }

    const ok = await call('tools/call', { name: 'probe', arguments: { value: { ok: 1 } } });
    const okText = ok.result.content[0].text;
    assert.ok(okText.trim());
    assert.deepStrictEqual(JSON.parse(okText), { ok: 1 });
    assert.doesNotMatch(okText, /пустой результат/);
  } finally {
    child.kill();
  }
});
