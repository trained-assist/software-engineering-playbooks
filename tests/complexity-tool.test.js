'use strict';

// Sandbox (plan-26741514 step 6): the user scenario end-to-end, run through the
// real MCP functional block. The scenario is "name a project profile → one call
// → tier + factors + K + three prices" (design §1). The call goes through
// registry.callTool() — the same path the MCP server uses — so this file proves
// the tool is registered and behaves as the scenario promises.
//
// Written BEFORE the tool exists on purpose: it must fail now for the right
// reason (engineering_estimate_complexity is not registered yet), and it goes
// green once src/mcp-skills/tools/64-complexity.js lands (slice S2). A green
// run before that would mean the sandbox checks nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { callTool, listTools } = require('../src/mcp-skills/registry');

const TOOL = 'engineering_estimate_complexity';

test('scenario: the estimator is registered under its documented MCP name', () => {
  const names = listTools().map((t) => t.name);
  assert.ok(names.includes(TOOL), `expected '${TOOL}' in the MCP catalog`);
});

test('scenario: one call turns a profile into tier, factors, K and three prices', async () => {
  const result = await callTool(TOOL, {
    tier: 'T1',
    observability: { api: 'closed' },
    platforms: ['web', 'ios'],
    realtime: true,
  });
  // T1 = 10000; K = 3 (closed API, primary axis) × 1.3 (breadth) × 2 (realtime) = 7.8
  assert.equal(result.tier, 'T1');
  assert.equal(result.k, 7.8);
  assert.equal(result.prices.dumping, 78000);
  assert.equal(result.prices.commercial, 156000);
  assert.equal(result.prices.good, 195000);
  assert.ok(
    result.warnings.some((w) => /total K/.test(w)),
    'K >= 5 stop rule must surface as a warning',
  );
});

test('scenario: the fixed brief case — closed API alone → K 3, three prices', async () => {
  const result = await callTool(TOOL, { tier: 'T1', observability: { api: 'closed' } });
  assert.equal(result.k, 3);
  assert.deepEqual(result.prices, { dumping: 30000, commercial: 60000, good: 75000 });
});

test('scenario: observability factors stack independently (closed API × closed infra = 9)', async () => {
  const result = await callTool(TOOL, {
    tier: 'T0',
    observability: { api: 'closed', infra: 'closed' },
    platforms: ['web', 'ios', 'android'],
  });
  assert.equal(result.k, 12.6); // 3 × 3 × 1.4
  assert.deepEqual(result.factors, {
    observability_api: 3,
    observability_infra: 3,
    breadth: 1.4,
  });
});

test('scenario: the estimator is deterministic (same profile → identical result)', async () => {
  const profile = {
    tier: 'T0',
    observability: { api: 'closed', infra: 'closed' },
    platforms: ['web', 'ios', 'android'],
  };
  const a = await callTool(TOOL, profile);
  const b = await callTool(TOOL, profile);
  assert.deepEqual(a, b);
});

test('scenario: empty arguments still return a usable, non-empty estimate', async () => {
  const result = await callTool(TOOL, {});
  assert.equal(typeof result, 'object');
  assert.ok(result && Object.keys(result).length > 0, 'empty MCP result is forbidden');
  assert.equal(result.tier, 'T0');
  assert.ok(result.prices && typeof result.prices.dumping === 'number');
});
