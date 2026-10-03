'use strict';

const { repoStatus } = require('../../repo-status/status');

module.exports = [{
  name: 'engineering_repo_status',
  description: 'One call for the engineering status of one repository: what it is, the current default-branch head, the newest PR by creation and the newest MERGED PR (a closed PR is not a merge), open PRs/issues with counts and bounded lists, and a CI summary for the head commit. Every section carries observed_at/source/error — partial answers are visibly partial; production status is never inferred. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'owner/name (e.g. trained-assist/software-engineering-playbooks).' },
      limits: {
        description: 'Per-section list sizes.',
        oneOf: [
          { type: 'object', properties: { prs: { type: 'number' }, issues: { type: 'number' } } },
          { type: 'string', description: 'JSON object, e.g. \'{"prs":5,"issues":5}\'.' },
        ],
      },
      refresh: { type: 'boolean', description: 'Bypass the TTL cache for all sections (identity is always fetched live).' },
    },
  },
  handler: async (args = {}) => {
    const input = args || {};
    let limits = input.limits;
    if (typeof limits === 'string') {
      try {
        limits = JSON.parse(limits);
      } catch (e) {
        const err = new Error(`limits must be an object or a JSON object string: ${e.message}`);
        err.code = 'INVALID_LIMITS';
        throw err;
      }
    }
    return repoStatus({ ...input, limits });
  },
}];