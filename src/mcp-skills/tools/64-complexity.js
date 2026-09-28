'use strict';

const { estimateComplexity } = require('../../complexity');

// Proxy to the deterministic complexity→price engine: every number lives in
// src/complexity COEFFICIENTS, this file only declares the MCP contract.
// All fields optional: the engine has defaults (missing tier → T0 + warning)
// and always answers with a non-empty result.
module.exports = {
  name: 'engineering_estimate_complexity',
  description:
    'Deterministic complexity→price estimate for a project profile: baseline (tier) × multipliers (observability axis first, breadth deliberately small), always three prices — dumping ×1, commercial ×2, good ×2.5 — plus applied factors, total K and warnings (K ≥ 5 stop rule, unknown fields).',
  inputSchema: {
    type: 'object',
    required: [],
    properties: {
      tier: {
        type: 'string',
        enum: ['T0', 'T1'],
        description:
          'Baseline tier: T0 = no-UI agent/export (smaller baseline), T1 = one static interface (larger baseline). Missing/unknown → T0 with a warning. Exact numbers: COEFFICIENTS in src/complexity.',
      },
      observability: {
        type: 'object',
        description:
          'Primary axis. api: "closed" = no test endpoint / access not actually granted (×3). infra: "closed" = reachable only in person / via their admins (×3). Independent — they stack. "unknown" → no multiplier, warning only.',
        properties: {
          api: { type: 'string', enum: ['closed', 'unknown'] },
          infra: { type: 'string', enum: ['closed', 'unknown'] },
        },
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Target platforms. Breadth is deliberately small: web only = 1.0, +1 mobile (ios/android) = 1.3, +2 = 1.4.',
      },
      infrastructure: {
        type: 'object',
        description: 'Deployed-infrastructure complexity (v3, unchanged).',
        properties: {
          complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
      realtime: {
        type: 'boolean',
        description: 'Realtime/sync requirements → ×2 (v3, unchanged).',
      },
      architecturalConstraints: {
        type: 'boolean',
        description: 'Hard architectural boundaries → ×1.7 (v3, unchanged).',
      },
      acceptance: {
        type: 'object',
        description:
          'Acceptance judges multiply: not agreed ×1.7, client taste ×2.89, external metric ×2.89 (v3, unchanged).',
        properties: {
          notAgreed: { type: 'boolean' },
          clientTaste: { type: 'boolean' },
          externalMetric: { type: 'boolean' },
        },
      },
    },
  },
  handler: async (args = {}) => estimateComplexity(args),
};
