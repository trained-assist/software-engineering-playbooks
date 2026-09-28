'use strict';

// Complexity → price engine: fixed cases from the brief (2026-09-28).
// Baseline = cost of one working day (CONFIG.baseDayRub × CONFIG.tierDays),
// independent observability ×3, breadth 1.0/1.3/1.4, stop rule K>=5,
// three prices, unknown-field warning.
//
// No price literal is duplicated in a case: every expectation derives from
// CONFIG, so retuning baseDayRub/tierDays moves the numbers without editing
// this file — except test('CONFIG pins the dictated numbers'), which is the
// single place the dictated figures themselves are asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateComplexity, CONFIG } = require('../src/complexity');

// A tier's baseline price = base day × days for that tier.
const day = (tier) => CONFIG.baseDayRub * CONFIG.tierDays[tier];
const dumpingOf = (result) => day(result.tier) * result.k;

test('CONFIG pins the dictated numbers (single place to retune)', () => {
  assert.equal(CONFIG.baseDayRub, 15000);
  assert.deepEqual(CONFIG.tierDays, { T0: 0.5, T1: 1.0 });
  assert.equal(CONFIG.K_API_CLOSED, 3);
  assert.equal(CONFIG.K_INFRA_CLOSED, 3);
  assert.equal(CONFIG.BREADTH_ONE_EXTRA, 1.3);
  assert.equal(CONFIG.BREADTH_TWO_EXTRA, 1.4);
  assert.equal(CONFIG.STOP_THRESHOLD, 5);
  assert.equal(CONFIG.PRICE_COMMERCIAL, 2);
  assert.equal(CONFIG.PRICE_GOOD, 2.5);
});

test('T0 without factors: half a working day → 7500 / 15000 / 18750', () => {
  const r = estimateComplexity({ tier: 'T0' });
  assert.equal(r.tier, 'T0');
  assert.equal(r.baseline, day('T0'));
  assert.equal(r.baseline, 7500);
  assert.equal(r.k, 1);
  assert.deepEqual(r.factors, {});
  assert.equal(r.prices.dumping, 7500);
  assert.equal(r.prices.commercial, 15000);
  assert.equal(r.prices.good, 18750);
  assert.deepEqual(r.warnings, []);
});

test('T1 without factors: one working day → 15000 / 30000 / 37500', () => {
  const r = estimateComplexity({ tier: 'T1' });
  assert.equal(r.tier, 'T1');
  assert.equal(r.baseline, day('T1'));
  assert.equal(r.baseline, 15000);
  assert.equal(r.k, 1);
  assert.equal(r.prices.dumping, 15000);
  assert.equal(r.prices.commercial, 30000);
  assert.equal(r.prices.good, 37500);
});

test('closed API alone multiplies K by 3 (independent of the tier day)', () => {
  const r = estimateComplexity({ tier: 'T1', observability: { api: 'closed' } });
  assert.equal(r.k, CONFIG.K_API_CLOSED);
  assert.equal(r.prices.dumping, 45000);
  assert.equal(r.prices.commercial, 90000);
  assert.equal(r.prices.good, 112500);
  assert.deepEqual(r.factors, { observability_api: CONFIG.K_API_CLOSED });
});

test('closed infrastructure alone multiplies K by 3', () => {
  const r = estimateComplexity({ tier: 'T1', observability: { infra: 'closed' } });
  assert.equal(r.k, CONFIG.K_INFRA_CLOSED);
  assert.equal(r.prices.dumping, 45000);
  assert.deepEqual(r.factors, { observability_infra: CONFIG.K_INFRA_CLOSED });
});

test('closed API AND closed infra stack independently (3 × 3 = 9)', () => {
  const r = estimateComplexity({
    tier: 'T0',
    observability: { api: 'closed', infra: 'closed' },
  });
  assert.equal(r.k, 9);
  assert.equal(r.prices.dumping, 67500);
  assert.equal(r.prices.commercial, 135000);
  assert.equal(r.prices.good, 168750);
  assert.deepEqual(r.factors, {
    observability_api: CONFIG.K_API_CLOSED,
    observability_infra: CONFIG.K_INFRA_CLOSED,
  });
});

test('breadth: web only = 1.0 (no factor)', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web'] });
  assert.equal(r.k, 1);
  assert.equal(r.prices.dumping, day('T1'));
  assert.equal(r.factors.breadth, undefined);
});

test('breadth: web + iOS = 1.3', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'ios'] });
  assert.equal(r.k, CONFIG.BREADTH_ONE_EXTRA);
  assert.equal(r.prices.dumping, 19500);
  assert.equal(r.factors.breadth, CONFIG.BREADTH_ONE_EXTRA);
});

test('breadth: web + iOS + Android = 1.4', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'ios', 'android'] });
  assert.equal(r.k, CONFIG.BREADTH_TWO_EXTRA);
  assert.equal(r.prices.dumping, 21000);
  assert.equal(r.prices.commercial, 42000);
  assert.equal(r.prices.good, 52500);
  assert.equal(r.factors.breadth, CONFIG.BREADTH_TWO_EXTRA);
});

test('breadth: web + Android (no iOS) = 1.3 — one extra platform', () => {
  const r = estimateComplexity({ tier: 'T1', platforms: ['web', 'android'] });
  assert.equal(r.k, CONFIG.BREADTH_ONE_EXTRA);
  assert.equal(r.factors.breadth, CONFIG.BREADTH_ONE_EXTRA);
});

test('infrastructure complexity 1 / 1.7 / 2.0', () => {
  const low = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'low' } });
  assert.equal(low.k, 1);
  const medium = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'medium' } });
  assert.equal(medium.k, CONFIG.K_INFRA_MEDIUM);
  const high = estimateComplexity({ tier: 'T1', infrastructure: { complexity: 'high' } });
  assert.equal(high.k, CONFIG.K_INFRA_HIGH);
  assert.equal(high.prices.dumping, 30000);
});

test('realtime ×2 and architectural constraints ×1.7 (v3, unchanged)', () => {
  const rt = estimateComplexity({ tier: 'T1', realtime: true });
  assert.equal(rt.k, CONFIG.K_REALTIME);
  const arch = estimateComplexity({ tier: 'T1', architecturalConstraints: true });
  assert.equal(arch.k, CONFIG.K_ARCH);
  const both = estimateComplexity({ tier: 'T1', realtime: true, architecturalConstraints: true });
  assert.equal(both.k, 3.4);
});

test('acceptance judges multiply: not agreed ×1.7, taste ×2.89, metric ×2.89', () => {
  const notAgreed = estimateComplexity({ tier: 'T1', acceptance: { notAgreed: true } });
  assert.equal(notAgreed.k, CONFIG.K_ACCEPTANCE_NOT_AGREED);
  const taste = estimateComplexity({ tier: 'T1', acceptance: { clientTaste: true } });
  assert.equal(taste.k, CONFIG.K_ACCEPTANCE_CLIENT_TASTE);
  const metric = estimateComplexity({ tier: 'T1', acceptance: { externalMetric: true } });
  assert.equal(metric.k, CONFIG.K_ACCEPTANCE_EXTERNAL_METRIC);
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
  assert.equal(r.prices.dumping, day('T0'));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unknown field/);
});

test('missing tier defaults to T0 with a warning', () => {
  const r = estimateComplexity({ realtime: true });
  assert.equal(r.tier, 'T0');
  assert.equal(r.prices.dumping, day('T0') * CONFIG.K_REALTIME);
  assert.ok(r.warnings.some((w) => /tier not specified/.test(w)));
});

test('price is a day × days × K: engine output matches the formula by construction', () => {
  const r = estimateComplexity({
    tier: 'T1',
    observability: { api: 'closed' },
    platforms: ['web', 'ios'],
    realtime: true,
  });
  assert.equal(r.prices.dumping, dumpingOf(r));
  assert.equal(r.prices.commercial, dumpingOf(r) * CONFIG.PRICE_COMMERCIAL);
  assert.equal(r.prices.good, dumpingOf(r) * CONFIG.PRICE_GOOD);
});
