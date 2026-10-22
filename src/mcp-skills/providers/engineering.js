'use strict';

// The engineering provider of this repository: the GitHub, workspace,
// repo/change/verify and spec tools.
//
// It used to be the server itself (src/mcp-skills/index.js owned the registry,
// the frame and the tool call). The registry is still the source of truth for
// the tools — this module only turns it into a provider the shared entry
// point can serve.

const registry = require('../registry');
const { toolResultText } = require('../tool-result');

const PROVIDER_ID = 'engineering';
const SERVER_INFO = { name: 'trained-assist-engineering', version: '0.4.0' };

function createEngineeringProvider() {
  return {
    id: PROVIDER_ID,
    serverInfo: SERVER_INFO,
    listTools: () => registry.listTools(),

    async callTool(name, args = {}, context = {}) {
      const value = await registry.callTool(name, args, context);
      return {
        content: [{ type: 'text', text: toolResultText(name, value) }],
      };
    },
  };
}

module.exports = { PROVIDER_ID, SERVER_INFO, createEngineeringProvider };
