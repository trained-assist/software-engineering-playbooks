'use strict';

// pr_status / issue_status — "what's up with this PR / issue" in one call (#52).
//
// Core-shaped module (isReady/setupTools/tools) so it is gated like the
// github_* skill when there is no token, and picked up automatically by
// registry.js. The heavy lifting lives in src/github/pr-status-core.js; this
// file is only the schema + the throwing/non-throwing boundary.

const { hasToken } = require('../../github/client');
const { prStatus, issueStatus } = require('../../github/pr-status-core');

module.exports = {
  isReady: hasToken,
  setupTools: [],

  tools: {

    pr_status: {
      description: 'One call for "where is this PR now": open/merged, the CI check-runs (ci + staging-gate highlighted), ' +
        'the compressed tail of the logs of the jobs that failed, whether the merge commit reached production ' +
        '(live / not_yet / unknown), and whether an autofix PR exists. Replaces the old github_pr_checks (which ' +
        'remains as a throwing alias). Never throws: returns {ok:false, error:{code}} for NOT_A_PR / NOT_FOUND / ' +
        'GITHUB_AUTH / RATE_LIMITED. Token is read internally — no manual token handling.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'pr_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo (e.g. trained-assist/trained-assist-agent)' },
          pr_number: { type: 'number', description: 'Pull request number' },
          head_sha: { type: 'string', description: 'Optional: inspect this exact commit instead of the PR head' },
          include_logs: { type: 'boolean', description: 'Include compressed failing-job logs (default true)' },
        },
      },
      handler: async ({ repo, pr_number, head_sha, include_logs }) => prStatus(repo, pr_number, {
        head_sha,
        include_logs: include_logs !== false,
        enrich: true,
      }),
    },

    issue_status: {
      description: 'All pull requests linked to an issue, including cross-repo ones, each with its status (state, ' +
        'merged, CI verdict). Sources: the GitHub GraphQL timeline, the REST timeline fallback, and links in the ' +
        'issue body/comments. Compact (no logs). Never throws: returns {ok:false, error:{code}}.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'issue_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          issue_number: { type: 'number', description: 'Issue number' },
          max_prs: { type: 'number', description: 'Max linked PRs to inspect (default 10)' },
          include_logs: { type: 'boolean', description: 'Include log tails (default false — issue answers stay compact)' },
        },
      },
      handler: async ({ repo, issue_number, max_prs, include_logs }) => issueStatus(repo, issue_number, {
        max_prs,
        include_logs: include_logs === true,
      }),
    },

  },
};
