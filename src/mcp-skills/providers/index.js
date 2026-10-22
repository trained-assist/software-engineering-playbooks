'use strict';

// The providers of this repository and the rule that decides which of them a
// server serves.
//
// The entry point (src/mcp-skills/index.js) serves ONE process. Which
// providers that process serves is an explicit choice, not an accident:
//
//   ENGINEERING_MCP_PROVIDERS=engineering            — the default
//   ENGINEERING_MCP_PROVIDERS=engineering,checklists — the checklist surface
//                                                     — is added
//
// The composition declaration (mcp-servers.json) says which set the host runs,
// and the host configuration passes the same set through the environment. The
// check compares the two, so the catalog of the running server can never be
// something else than the declared one.

const engineering = require('./engineering');
const checklists = require('./checklists');

const PROVIDERS = {
  [engineering.PROVIDER_ID]: engineering,
  [checklists.PROVIDER_ID]: checklists,
};

// The providers a server serves when nobody says otherwise. The checklist
// surface is opt-in: it is user-local, and adding it to the default catalog
// would widen the surface every host of trained-assist-agent registers.
const DEFAULT_PROVIDERS = [engineering.PROVIDER_ID];

const PROVIDERS_ENV = 'ENGINEERING_MCP_PROVIDERS';

// "engineering,checklists" → ['engineering', 'checklists']
function parseProviderIds(value) {
  if (Array.isArray(value)) {
    return value.map(id => String(id).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * Build the providers of a server.
 *
 * @param {string[]} ids the provider ids to serve
 * @returns {Array<{id: string, listTools: Function, callTool: Function}>}
 */
function buildProviders(ids = DEFAULT_PROVIDERS) {
  const requested = ids.length ? ids : DEFAULT_PROVIDERS;
  return requested.map(id => {
    const module = PROVIDERS[id];
    if (!module) {
      throw new Error(`Unknown MCP provider "${id}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
    }
    if (id === engineering.PROVIDER_ID) return engineering.createEngineeringProvider();
    return checklists.createChecklistsProvider();
  });
}

// The provider ids a server serves, read from the environment.
function providerIdsFromEnv(env = process.env) {
  const configured = parseProviderIds(env[PROVIDERS_ENV]);
  return configured.length ? configured : DEFAULT_PROVIDERS;
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDERS,
  PROVIDERS_ENV,
  parseProviderIds,
  buildProviders,
  providerIdsFromEnv,
};
