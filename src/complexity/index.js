'use strict';

// Complexity → price engine (v4 re-weighting, 2026-09-28 owner directive).
//
// Baseline = the cost of ONE ISOLATED WORKING DAY (directive 2, voice 19:28 MSK).
// Every coefficient is a multiplier OF that day, not a separate per-factor price.
//
// Formula: dumping = baseDayRub × tierDays(tier) × K_observability × K_breadth
//                   × K_infra × K_realtime × K_arch × K_acceptance
// Three prices are always produced: dumping ×1, commercial ×2, good ×2.5.
//
// The observability axis is primary: a closed/unavailable API and a closed
// infrastructure are independent, large multipliers (≈×3 each) that stack.
// Breadth (number of platforms) is deliberately small (1.0 / 1.3 / 1.4).
//
// Every coefficient is a named constant in CONFIG so that tuning a number
// never requires rewriting the logic. Deterministic: no I/O, no clock, no rand.

const CONFIG = {
  // Baseline: cost of one isolated working day (RUB). The number the owner
  // dictated ("пусть будет 15000") — retune here, never in the logic.
  baseDayRub: 15000,

  // Tiers expressed in DAYS relative to that base day. Keeps v3's relation
  // T1 = 2 × T0 and fits "all isolated, done within a day".
  tierDays: {
    T0: 0.5, // no-UI agent/export
    T1: 1.0, // one static interface
  },

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
  const days = CONFIG.tierDays[tier];
  const baseline = CONFIG.baseDayRub * days; // dumping price without factors

  // --- observability (primary axis) ---------------------------------------
  const obs = project.observability || {};
  if (obs.api === 'closed') {
    k *= CONFIG.K_API_CLOSED;
    factors.observability_api = CONFIG.K_API_CLOSED;
  } else if (obs.api === 'unknown') {
    warnings.push("observability.api is 'unknown' — treat as 'closed' if there is no test endpoint");
  }
  if (obs.infra === 'closed') {
    k *= CONFIG.K_INFRA_CLOSED;
    factors.observability_infra = CONFIG.K_INFRA_CLOSED;
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
      if (extra === 1) breadth = CONFIG.BREADTH_ONE_EXTRA;
      else if (extra >= 2) breadth = CONFIG.BREADTH_TWO_EXTRA;
      if (breadth > 1.0) {
        k *= breadth;
        factors.breadth = breadth;
      }
    }
  }

  // --- infrastructure complexity ------------------------------------------
  const infra = project.infrastructure || {};
  if (infra.complexity === 'medium') {
    k *= CONFIG.K_INFRA_MEDIUM;
    factors.infra = CONFIG.K_INFRA_MEDIUM;
  } else if (infra.complexity === 'high') {
    k *= CONFIG.K_INFRA_HIGH;
    factors.infra = CONFIG.K_INFRA_HIGH;
  } else if (infra.complexity !== undefined && infra.complexity !== 'low') {
    warnings.push(`unknown infrastructure.complexity '${infra.complexity}' — ignored`);
  }

  // --- realtime ------------------------------------------------------------
  if (project.realtime) {
    k *= CONFIG.K_REALTIME;
    factors.realtime = CONFIG.K_REALTIME;
  }

  // --- architectural constraints ------------------------------------------
  if (project.architecturalConstraints) {
    k *= CONFIG.K_ARCH;
    factors.arch_constraints = CONFIG.K_ARCH;
  }

  // --- acceptance judges ---------------------------------------------------
  const acc = project.acceptance || {};
  let accK = 1.0;
  if (acc.notAgreed) accK *= CONFIG.K_ACCEPTANCE_NOT_AGREED;
  if (acc.clientTaste) accK *= CONFIG.K_ACCEPTANCE_CLIENT_TASTE;
  if (acc.externalMetric) accK *= CONFIG.K_ACCEPTANCE_EXTERNAL_METRIC;
  if (accK > 1.0) {
    k *= accK;
    factors.acceptance = round2(accK);
  }

  // --- stop rule -----------------------------------------------------------
  const totalK = round2(k);
  if (totalK >= CONFIG.STOP_THRESHOLD) {
    warnings.push(
      `total K = ${totalK} (>= ${CONFIG.STOP_THRESHOLD}) — propose removing uncertainty before quoting`,
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
      commercial: round2(dumping * CONFIG.PRICE_COMMERCIAL),
      good: round2(dumping * CONFIG.PRICE_GOOD),
    },
    warnings,
  };
}

module.exports = { estimateComplexity, CONFIG };
