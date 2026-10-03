'use strict';

const { verify } = require('../../verify/verify');
const { SCOPES } = require('../../verify/checks');

// Same host-derived identity contract as 68-change-find.js / 69-change-status.js:
// principal and roots are read inside the handler so a smuggled argument cannot
// move the write into another profile's store.
function context() {
  return {
    principal: process.env.USER_ID || '',
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
  };
}

module.exports = [{
  name: 'engineering_verify',
  description: 'Independent judge of whether a result meets the ACCEPTED requirements: pins the target to one revision, re-collects evidence (GitHub CI/PR/content, workspace, explicitly enabled command runs) instead of trusting the implementer\'s report, and answers verified / partial / not_met / inconclusive with a per-requirement verdict, each one\'s evidence and gaps. A semantic judge only classifies requirements it is handed — it can never reword them; a dead judge, missing access or an unresolved validator yields inconclusive, never «not done». Writes one verification receipt into your own store (the fact engineering_change_status reads) and never fixes, commits or merges anything.',
  inputSchema: {
    type: 'object',
    properties: {
      requirements: { type: 'array', description: 'Accepted requirements, read-only for the judge: strings or {id?, text, required?, evidence?: existence|receipt|output, checks?: [{kind, …}]}. Mutually exclusive with requirements_ref.' },
      requirements_ref: { type: 'string', description: '«issue#<n>[@<rev>]» or «file:<path>[@<rev>]» — the service reads the accepted requirements itself. Mutually exclusive with requirements.' },
      target: {
        type: 'object',
        description: 'What is judged, exactly one of: pr, commit, branch, workspace_ref, artifact (plus repo for GitHub targets). The answer is pinned to the resolved SHA.',
        properties: {
          repo: { type: 'string' },
          pr: { type: 'number' },
          commit: { type: 'string' },
          branch: { type: 'string' },
          workspace_ref: { type: 'string' },
          artifact: { type: 'string' },
          url: { type: 'string' },
        },
      },
      repo: { type: 'string', description: 'owner/name — used for GitHub targets and issue# requirements; a repo stated in target.repo always wins.' },
      workspace_ref: { type: 'string', description: 'Convenience alias for target.workspace_ref.' },
      scope: { type: 'string', enum: SCOPES, description: 'What is being judged: implementation (default), delivery, user_scenario. Checks outside the scope are reported as unknown, never as pass.' },
      evidence_refs: { type: ['array', 'string'], description: 'Evidence claims from the implementer. Each must carry the pinned revision to be admissible; stale or unsourced claims become gaps, not evidence.' },
      run_checks: { type: 'boolean', description: 'Explicit mode: allow command checks to actually run, only inside an isolated workspace from ENGINEERING_WORKSPACE_ROOT. Requirement text is never executed.' },
      budget: { type: 'object', description: '{max_checks?: number, judge?: boolean} — judge:false disables the semantic judge for this call (undecided requirements then stay unknown).' },
    },
  },
  handler: async (args = {}) => {
    const { principal, workspaceRoot } = context();
    return verify({ ...(args || {}) }, { principal, workspaceRoot });
  },
}];
