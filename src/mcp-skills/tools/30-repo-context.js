'use strict';

const { repoContext } = require('../../context-sources/repo-context');

module.exports = [{
  name: 'engineering_repo_context',
  description: 'Return ranked repository context for a set of keywords — the "give me context by keys, super fast, without rummaging" tool. Uses a fresh .engineering/index when present, otherwise deterministic raw-repo keyword ranking. No network, no LLM.',
  inputSchema: {
    type: 'object',
    required: ['repo_path', 'keywords'],
    properties: {
      repo_path: { type: 'string', description: 'Absolute or working-directory-relative path to the target repository checkout.' },
      keywords: {
        description: 'Keyword(s) to locate relevant files/symbols.',
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      max_results: { type: 'number', description: 'Maximum number of ranked entries to consider. Defaults to 24.' },
      budget: { type: 'number', description: 'Optional hard cap on returned entries (a fast-path budget).' },
    },
  },
  handler: async ({ repo_path, keywords, max_results = 24, budget } = {}) => repoContext({
    repoPath: repo_path,
    keywords,
    maxResults: max_results,
    budget,
  }),
}];
