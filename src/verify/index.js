'use strict';

// engineering_verify (#113) — one capability, three facades (MCP tool, CLI,
// playbook step calling the tool). They all land in verify(), so a verdict can
// never depend on which door was used; the execution-plans runtime stays the
// owner of plan transitions (verify records a fact, it never moves a step).

const { verify, overallVerdict, classifyProvidedEvidence, normalizeScope } = require('./verify');
const { resolveRequirements, parseRequirementsRef, hashRequirements, normalizeExplicit } = require('./requirements');
const { resolveTarget } = require('./target');
const { runCheck, evidenceSatisfies, SUPPORTED_KINDS, SCOPES } = require('./checks');
const { judge, extractJsonArray } = require('./judge');

module.exports = {
  verify,
  overallVerdict,
  classifyProvidedEvidence,
  normalizeScope,
  resolveRequirements,
  parseRequirementsRef,
  hashRequirements,
  normalizeExplicit,
  resolveTarget,
  runCheck,
  evidenceSatisfies,
  SUPPORTED_KINDS,
  SCOPES,
  judge,
  extractJsonArray,
};
