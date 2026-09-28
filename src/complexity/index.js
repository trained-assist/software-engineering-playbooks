'use strict';

// Complexity → price engine (v4 re-weighting, 2026-09-28 owner directive).
//
// Formula: price = baseline(tier) × K_observability × K_breadth × K_infra
//                  × K_realtime × K_arch × K_acceptance
// Three prices are always produced: dumping ×1, commercial ×2, good ×2.5.
//
// The observability axis is primary: a closed/unavailable API and a closed
// infrastructure are independent, large multipliers (≈×3 each) that stack.
// Breadth (number of platforms) is deliberately small (1.0 / 1.3 / 1.4).
//
// Every coefficient is a named constant in COEFFICIENTS so that tuning a number
// never requires rewriting the logic. Deterministic: no I/O, no clock, no rand.

const COEFFICIENTS = {
  // Baseline by tier (dumping price, RUB).
  BASELINE_T0: 5000, // no-UI agent/export
  BASELINE_T1: 10000, // one static interface

  // Observability axis (primary) — independent, multiply.
  K_API_CLOSED: 3.0, // no test endpoint / access not actually granted
  K_INFRA_CLOSED: 3.0, // infra reachable only in person / via their admins

  // Breadth (number of platforms) — deliberately small.
  BREADTH_ONE_EXTRA: 1.3, // web + iOS
  BREADTH_TWO_EXTRA: 1.4, // web + iOS + Android

  // Infrastructure complexity (v3, unchanged).
  K_INFRA_MEDIUM: 1.7,
  K_INFRA_HIGH: 2.0,

  // Task complexity (v3, unchanged).
  K_REALTIME: 2.0,
  K_ARCH: 1.7,

  // Acceptance judges (v3, unchanged; multiply).
  K_ACCEPTANCE_NOT_AGREED: 1.7,
  K_ACCEPTANCE_CLIENT_TASTE: 2.89,
  K_ACCEPTANCE_EXTERNAL_METRIC: 2.89,

  // Price tiers.
  PRICE_COMMERCIAL: 2.0,
  PRICE_GOOD: 2.5,

  // Stop rule: total K at/above this → propose removing uncertainty first.
  STOP_THRESHOLD: 5.0,
};

const KNOWN_TOP_LEVEL = [
  'tier',
  'observability',
  'platforms',
  'infrastructure',
  'realtime',
  'architecturalConstraints',
  'acceptance',
];

function round2(n) {
  return parseFloat(n.toFixed(2));
}

function estimateComplexity(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('estimateComplexity: input must be an object');
  }
  const project = input;
  const warnings = [];
  const factors = {};
  let k = 1.0;

  // --- unknown top-level fields -------------------------------------------
  for (const key of Object.keys(project)) {
    if (!KNOWN_TOP_LEVEL.includes(key)) {
      warnings.push(`unknown field ignored: '${key}'`);
    }
  }

  // --- tier ----------------------------------------------------------------
  let tier = project.tier;
  if (tier === undefined || tier === null) {
    tier = 'T0';
    warnings.push('tier not specified — assumed T0 (no-UI agent/export)');
  } else if (tier !== 'T0' && tier !== 'T1') {
    warnings.push(`unknown tier '${tier}' — assumed T0`);
    tier = 'T0';
  }
  const baseline = tier === 'T1' ? COEFFICIENTS.BASELINE_T1 : COEFFICIENTS.BASELINE_T0;

  // --- observability (primary axis) ---------------------------------------
  const obs = project.observability || {};
  if (obs.api === 'closed') {
    k *= COEFFICIENTS.K_API_CLOSED;
    factors.observability_api = COEFFICIENTS.K_API_CLOSED;
  } else if (obs.api === 'unknown') {
    warnings.push("observability.api is 'unknown' — treat as 'closed' if there is no test endpoint");
  }
  if (obs.infra === 'closed') {
    k *= COEFFICIENTS.K_INFRA_CLOSED;
    factors.observability_infra = COEFFICIENTS.K_INFRA_CLOSED;
  } else if (obs.infra === 'unknown') {
    warnings.push("observability.infra is 'unknown' — treat as 'closed' if access is only in person");
  }

  // --- breadth (number of platforms) --------------------------------------
  if (project.platforms !== undefined) {
    if (!Array.isArray(project.platforms)) {
      warnings.push('platforms must be an array — ignored');
    } else {
      const extra = project.platforms.filter((p) => p === 'ios' || p === 'android').length;
      let breadth = 1.0;
      if (extra === 1) breadth = COEFFICIENTS.BREADTH_ONE_EXTRA;
      else if (extra >= 2) breadth = COEFFICIENTS.BREADTH_TWO_EXTRA;
      if (breadth > 1.0) {
        k *= breadth;
        factors.breadth = breadth;
      }
    }
  }

  // --- infrastructure complexity ------------------------------------------
  const infra = project.infrastructure || {};
  if (infra.complexity === 'medium') {
    k *= COEFFICIENTS.K_INFRA_MEDIUM;
    factors.infra = COEFFICIENTS.K_INFRA_MEDIUM;
  } else if (infra.complexity === 'high') {
    k *= COEFFICIENTS.K_INFRA_HIGH;
    factors.infra = COEFFICIENTS.K_INFRA_HIGH;
  } else if (infra.complexity !== undefined && infra.complexity !== 'low') {
    warnings.push(`unknown infrastructure.complexity '${infra.complexity}' — ignored`);
  }

  // --- realtime ------------------------------------------------------------
  if (project.realtime) {
    k *= COEFFICIENTS.K_REALTIME;
    factors.realtime = COEFFICIENTS.K_REALTIME;
  }

  // --- architectural constraints ------------------------------------------
  if (project.architecturalConstraints) {
    k *= COEFFICIENTS.K_ARCH;
    factors.arch_constraints = COEFFICIENTS.K_ARCH;
  }

  // --- acceptance judges ---------------------------------------------------
  const acc = project.acceptance || {};
  let accK = 1.0;
  if (acc.notAgreed) accK *= COEFFICIENTS.K_ACCEPTANCE_NOT_AGREED;
  if (acc.clientTaste) accK *= COEFFICIENTS.K_ACCEPTANCE_CLIENT_TASTE;
  if (acc.externalMetric) accK *= COEFFICIENTS.K_ACCEPTANCE_EXTERNAL_METRIC;
  if (accK > 1.0) {
    k *= accK;
    factors.acceptance = round2(accK);
  }

  // --- stop rule -----------------------------------------------------------
  const totalK = round2(k);
  if (totalK >= COEFFICIENTS.STOP_THRESHOLD) {
    warnings.push(
      `total K = ${totalK} (>= ${COEFFICIENTS.STOP_THRESHOLD}) — propose removing uncertainty before quoting`,
    );
  }

  // --- prices --------------------------------------------------------------
  const dumping = round2(baseline * totalK);

  return {
    tier,
    baseline,
    factors,
    k: totalK,
    prices: {
      dumping,
      commercial: round2(dumping * COEFFICIENTS.PRICE_COMMERCIAL),
      good: round2(dumping * COEFFICIENTS.PRICE_GOOD),
    },
    warnings,
  };
}

module.exports = { estimateComplexity, COEFFICIENTS };
