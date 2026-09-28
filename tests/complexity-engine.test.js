'use strict';

// Complexity → price engine: fixed cases from the brief (2026-09-28).
// T0/T1 baselines, independent observability ×3, breadth 1.0/1.3/1.4,
// stop rule K>=5, three prices, unknown-field warning.

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateComplexity, COEFFICIENTS } = require('../src/complexity');

test('T0 without factors: baseline and three prices', () => {
  const r = estimateComplexity({ tier: 'T0' });
  assert.equal(r.tier, 'T0');
  assert.equal(r.baseline, 5000);
  assert.equal(r.k, 1);
  assert.deepEqual(r.factors, {});
  assert.equal(r.prices.dumping, 5000);
  assert.equal(r.prices.commercial, 10000);
  assert.equal(r.prices.good, 12500);
  assert.deepEqual(r.warnings, []);
});

test('T1 without factors: baseline and three prices', () => {
  const r = estimateComplexity({ tier: 'T1' });
  assert.equal(r.tier, 'T1');
  assert.equal(r.baseline, 10000);
  assert.equal(r.k, 1);
  assert.equal(r.prices.dumping, 10000);
  assert.equal(r.prices.commercial, 20000);
  assert.equal(r.prices.good, 25000);
});

test('closed API alone multiplies K by 3', () => {
  const r = estimateComplexity({ tier: 'T1', observability: { api: 'closed' } });
  assert.equal(r.k, 3);
  assert.equal(r.prices.dumping, 30000);
  assert.equal(r.prices.commercial, 60000);
  assert.equal(r.prices.good, 75000);
  assert.deepEqual(r.factors, { observability_api: 3 });
});

test('closed infrastructure alone multiplies K by 3', () => {
  const r = estimateComplexity({ tier: 'T1', observability: { infra: 'closed' } });
  assert.equal(r.k, 3);
  assert.equal(r.prices.dumping, 30000);
  assert.deepEqual(r.factors, { observability_infra: 3 });
});

test('closed API AND closed infra stack independently (3 × 3 = 9)', () => {
  const r = estimateComplexity({
    tier: 'T0',
    observability: { api: 'closed', infra: 'closed' },
  });
  assert.equal(r.k, 9);
  assert.equal(r.prices.dumping, 45000);
  assert.equal(r.prices.commercial, 90000);
  assert.equal(r.prices.good, 112500);
  assert.deepEqual(r.factors, { observability_api: 3, observability_infra: 3 });
});

test('breadth: web only = 1.0 (no factor)', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web'] });
  assert.equal(r.k, 1);
  assert.equal(r.prices.dumping, 10000);
  assert.equal(r.factors.breadth, undefined);
});

test('breadth: web + iOS = 1.3', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'ios'] });
  assert.equal(r.k, 1.3);
  assert.equal(r.prices.dumping, 13000);
  assert.equal(r.factors.breadth, 1.3);
});

test('breadth: web + iOS + Android = 1.4', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'ios', 'android'] });
  assert.equal(r.k, 1.4);
  assert.equal(r.prices.dumping, 14000);
  assert.equal(r.prices.commercial, 28000);
  assert.equal(r.prices.good, 35000);
  assert.equal(r.factors.breadth, 1.4);
});

test('breadth: web + Android (no iOS) = 1.3 — one extra platform', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'android'] });
  assert.equal(r.k, 1.3);
  assert.equal(r.factors.breadth, 1.3);
});

test('infrastructure complexity 1 / 1.7 / 2.0', () => {
  const low = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'low' } });
  assert.equal(low.k, 1);
  const medium = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'medium' } });
  assert.equal(medium.k, 1.7);
  const high = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'high' } });
  assert.equal(high.k, 2);
  assert.equal(high.prices.dumping, 20000);
});

test('realtime ×2 and architectural constraints ×1.7 (v3, unchanged)', () => {
  const rt = estimateComplexity({ tier: 'T1', realtime: true });
  assert.equal(rt.k, 2);
  const arch = estimateComplexity({ tier: 'T1', architecturalConstraints: true });
  assert.equal(arch.k, 1.7);
  const both = estimateComplexity({ tier: 'T1', realtime: true, architecturalConstraints: true });
  assert.equal(both.k, 3.4);
});

test('acceptance judges multiply: not agreed ×1.7, taste ×2.89, metric ×2.89', () => {
  const notAgreed = estimateComplexity({ tier: 'T1', acceptance: { notAgreed: true } });
  assert.equal(notAgreed.k, 1.7);
  const taste = estimateComplexity({ tier: 'T1', acceptance: { clientTaste: true } });
  assert.equal(taste.k, 2.89);
  const metric = estimateComplexity({ tier: 'T1', acceptance: { externalMetric: true } });
  assert.equal(metric.k, 2.89);
  const stacked = estimateComplexity({
    tier: 'T1',
    acceptance: { notAgreed: true, clientTaste: true },
  });
  assert.equal(stacked.k, 4.91);
  assert.equal(stacked.factors.acceptance, 4.91);
});

test('stop rule: total K >= 5 raises a warning', () => {
  const r = estimateComplexity({
    tier: 'T1',
    observability: { api: 'closed' },
    realtime: true,
  }); // 3 × 2 = 6
  assert.equal(r.k, 6);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /total K = 6 \(>= 5\)/);
});

test('stop rule not triggered below the threshold', () => {
  const below = estimateComplexity({ tier: 'T1', platforms: ['web', 'ios'], realtime: true }); // 1.3 × 2 = 2.6
  assert.equal(below.k, 2.6);
  assert.deepEqual(below.warnings, []);
});

test('unknown fields are reported, not silently multiplied', () => {
  const r = estimateComplexity({ tier: 'T0', somethingNew: true });
  assert.equal(r.k, 1);
  assert.equal(r.prices.dumping, 5000);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unknown field/);
});

test('missing tier defaults to T0 with a warning', () => {
  const r = estimateComplexity({ realtime: true });
  assert.equal(r.tier, 'T0');
  assert.equal(r.prices.dumping, 10000);
  assert.ok(r.warnings.some((w) => /tier not specified/.test(w)));
});

test('COEFFICIENTS are the single place to retune numbers', () => {
  assert.equal(COEFFICIENTS.K_API_CLOSED, 3);
  assert.equal(COEFFICIENTS.K_INFRA_CLOSED, 3);
  assert.equal(COEFFICIENTS.BREADTH_ONE_EXTRA, 1.3);
  assert.equal(COEFFICIENTS.BREADTH_TWO_EXTRA, 1.4);
  assert.equal(COEFFICIENTS.STOP_THRESHOLD, 5);
  assert.equal(COEFFICIENTS.PRICE_COMMERCIAL, 2);
  assert.equal(COEFFICIENTS.PRICE_GOOD, 2.5);
});
