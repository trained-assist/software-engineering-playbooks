#!/usr/bin/env node
'use strict';

// The entry point of the MCP stack of this repository.
//
// There used to be three stdio servers here, each with its own copy of the
// JSON-RPC frame (issue #164, finding 6): the engineering server, the
// checklist server and the sandbox server. Now there is ONE frame
// (src/mcp-protocol) and ONE entry point that serves a set of providers:
//
//   ENGINEERING_MCP_PROVIDERS=engineering            — the default
//   ENGINEERING_MCP_PROVIDERS=engineering,checklists — the checklist surface
//                                                     — is added
//
// The set is a deliberate choice, declared in mcp-servers.json and compared
// with the host configuration by `npm run check:mcp-servers`.

const { createTransport, initializeResult, jsonrpc, serveStdio } = require('../mcp-protocol');
const { buildProviders, providerIdsFromEnv, parseProviderIds } = require('./providers');

const SERVER_INFO = { name: 'trained-assist-engineering', version: '0.4.0' };

// `--providers=engineering,checklists` overrides the environment, so the same
// server can be started by hand with a different surface.
function providerIdsFromArgs(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    const match = /^--providers=(.*)$/.exec(arg);
    if (match) return parseProviderIds(match[1]);
  }
  return null;
}

// The handlers of the server: the method names of the protocol, answered from
// the providers that are on.
function serverHandlers(providers) {
  const tools = providers.flatMap(provider => provider.listTools());
  const ownerOf = name => providers.find(provider => provider.listTools().some(tool => tool.name === name));

  return {
    initialize: () => initializeResult({ name: SERVER_INFO.name, version: SERVER_INFO.version }),
    ping: () => ({ ok: true }),
    'tools/list': () => ({ tools }),
    'tools/call': async (params, message) => {
      const name = params && params.name;
      const provider = ownerOf(name);
      if (!provider) {
        throw new jsonrpc.JsonRpcError(jsonrpc.RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name || ''}`);
      }
      return provider.callTool(name, (params && params.arguments) || {}, { requestId: message && message.id });
    },
  };
}

// The cancellation bridge: a notifications/cancelled message aborts the call
// it names. Every provider that can wait keeps its pending calls in a map
// keyed by the id of the request that started them.
function cancellationHandler(providers) {
  return message => {
    if (message.method !== 'notifications/cancelled') return;
    const requestId = message.params && message.params.requestId;
    for (const provider of providers) {
      if (provider.pending) provider.pending.get(String(requestId))?.abort();
    }
  };
}

/**
 * Handle one MCP request against a set of providers.
 *
 * The same path the server takes, so it can be exercised without a pipe.
 */
function handleRequest(request, { providers = buildProviders() } = {}) {
  const transport = createTransport({
    handlers: serverHandlers(providers),
    onNotification: cancellationHandler(providers),
  });
  return transport.handle(request);
}

if (require.main === module) {
  const providers = buildProviders(providerIdsFromArgs() || providerIdsFromEnv());
  serveStdio({
    handlers: serverHandlers(providers),
    onNotification: cancellationHandler(providers),
  });
}

module.exports = { SERVER_INFO, serverHandlers, cancellationHandler, handleRequest };
