'use strict';

const { registerLog, lookupLogs, listLogs } = require('../../qa-logs');

// `profile` is host-derived identity (USER_ID), never a tool-call argument,
// matching the workspace tools: an argument must not be able to redirect the
// registry to another profile. Root is optional host config for hermetic tests.
function context() {
  return {
    profile: process.env.USER_ID || '',
    root: process.env.ENGINEERING_QA_LOGS_ROOT || undefined,
  };
}

const register = {
  name: 'qa_log_register',
  description: 'Declare a log you found or created during work/debug: where it lives and how to read it. Stores only location + metadata, never raw log contents or credentials. Re-registering the same name+location updates it.',
  inputSchema: {
    type: 'object',
    required: ['name', 'location', 'how_to_read'],
    properties: {
      name: { type: 'string', description: 'Short human name for the log (e.g. "autofix-worker stderr").' },
      location: { type: 'string', description: 'Where the log is, e.g. a path, glob, unit name or query — not its contents.' },
      ttl: { description: 'How long the log tends to live (seconds or a human string like "until next deploy").' },
      fields: {
        description: 'Field/column names present in the log, e.g. ["level","request_id"].',
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string' },
        ],
      },
      how_to_read: { type: 'string', description: 'Exact command/how to read it (e.g. "journalctl -u autofix -f").' },
      owner: { type: 'string', description: 'Team/component owning the log.' },
      source: { type: 'string', description: 'Where this knowledge came from (e.g. "agent", "ci", "debug").' },
    },
  },
  handler: async ({ name, location, ttl, fields, how_to_read, owner, source } = {}) => {
    const { profile, root } = context();
    return registerLog({ profile, root, entry: { name, location, ttl, fields, how_to_read, owner, source } });
  },
};

const lookup = {
  name: 'qa_log_lookup',
  description: 'Look up registered logs by a query string. Searches name, location, field names, owner, source and how_to_read.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Text to search for across registered logs.' },
      max_results: { type: 'number', description: 'Maximum number of matches to return. Defaults to 50.' },
    },
  },
  handler: async ({ query, max_results = 50 } = {}) => {
    const { profile, root } = context();
    return lookupLogs({ profile, root, query, maxResults: max_results });
  },
};

const list = {
  name: 'qa_log_list',
  description: 'List all logs registered for the current profile.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { profile, root } = context();
    return listLogs({ profile, root });
  },
};

module.exports = [register, lookup, list];
