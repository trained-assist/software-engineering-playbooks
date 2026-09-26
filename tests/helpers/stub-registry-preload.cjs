'use strict';
// Preloaded via `node --require` by tests/mcp-empty-result.test.js: replaces the real
// tool registry with a single `probe` tool that returns args.value verbatim, so the
// real src/mcp-skills/index.js can be exercised with arbitrary (incl. empty) results.
const path = require('path');
const Module = require('module');
const file = path.resolve(__dirname, '..', '..', 'src', 'mcp-skills', 'registry.js');
const m = new Module(file, module);
m.filename = file;
m.loaded = true;
m.exports = {
  listTools: () => [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => (args || {}).value,
};
require.cache[file] = m;
