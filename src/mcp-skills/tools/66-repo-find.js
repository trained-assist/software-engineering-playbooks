'use strict';

const { findRepos } = require('../../repo-catalog/find');

module.exports = [{
  name: 'engineering_repo_find',
  description: 'Find accessible repositories by purpose, name or former name from a natural-language query («инструменты рекрутера» → the matching repos with why they matched). Returns ranked repos with match_reasons, structured freshness and an honest no_match — for discovery before repo_status/repo_search. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Natural-language query or repository name/alias (Russian or English).' },
      scope: { type: 'string', description: 'Catalog scope: "visible" (default, all repos the token can see), "org:<name>" or "user:<name>".' },
      limit: { type: 'number', description: 'Max repos to return (default 10, cap 50).' },
      cursor: { type: 'string', description: 'Pagination cursor from a previous next_cursor.' },
      refresh: { type: 'boolean', description: 'Force catalog rebuild, bypassing the TTL cache.' },
      include_archived: { type: 'boolean', description: 'Include archived repos in matches (default false; excluded ones are listed in "excluded").' },
    },
  },
  handler: async (args) => findRepos(args || {}),
}];
