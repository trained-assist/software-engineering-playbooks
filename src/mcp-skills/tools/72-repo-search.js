'use strict';

const { repoSearch } = require('../../repo-search/search');

module.exports = [{
  name: 'engineering_repo_search',
  description: 'Code+doc retrieval inside one local checkout: a Russian question ("где ограничивают аттестацию бюджет") returns relevant sources — path, start/end lines, symbol, snippet, commit_sha and source_ref. Default strategy "auto" ranks lexically first and falls back to semantic ranking only when lexical has no confident hit (measured 0.571 → 0.946 recall@5 on 34 labelled queries; semantic ranking needs an embedding provider and degrades honestly to lexical without one). A stale or renamed file is never quoted as current, and no-match is explicitly NOT proof of absence. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['repo_path', 'query'],
    properties: {
      repo_path: { type: 'string', description: 'Absolute path to a local checkout of the repository.' },
      query: { type: 'string', description: 'Natural-language question or exact identifier.' },
      strategy: {
        type: 'string',
        enum: ['keyword', 'dense', 'hybrid'],
        description: 'Ranking strategy, default auto: lexical first, semantic only when lexical has no confident hit. keyword = lexical only; dense = full-corpus semantic (best recall, pays the whole embedding pass); hybrid = reciprocal-rank fusion over the lexical shortlist. Without embedding credentials everything but keyword degrades to keyword and says so.',
      },
      limit: { type: 'number', description: 'Max sources to return (default 8).' },
      include: { type: 'array', items: { type: 'string' }, description: 'Restrict to path prefixes, e.g. ["src/", "docs/"].' },
      include_stale: { type: 'boolean', description: 'Also quote hits whose file changed after the indexed revision (they are excluded by default).' },
      refresh: { type: 'boolean', description: 'Rebuild the chunk cache for this revision instead of reusing it.' },
      max_chunks: { type: 'number', description: 'Chunk budget for a fresh build (default 1500).' },
      embed_model: { type: 'string', description: 'Embedding model id (default google/gemini-embedding-001 via OpenRouter).' },
    },
  },
  handler: async (args = {}) => repoSearch(args || {}),
}];