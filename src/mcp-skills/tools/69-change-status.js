'use strict';

const { changeStatus } = require('../../change-status/status');

// Same host-derived identity/roots contract as 20-workspace.js and
// 68-change-find.js: principal comes from the MCP process env (USER_ID), roots
// from ENGINEERING_WORKSPACE_ROOT. Read inside the handler so "env wins" stays
// true even if a caller smuggles a `principal` field into the arguments.
function context() {
  return {
    principal: process.env.USER_ID || '',
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
  };
}

module.exports = [{
  name: 'engineering_change_status',
  description: 'Where a change actually stands, as six separate facts instead of one verdict: written, committed, pushed, merged, delivered, verified — each satisfied/not_satisfied/unknown/not_applicable with refs, revision and observed_at, plus next_missing_actions as recommendations. A missing workspace, unreachable CI or unreachable production endpoint reads as unknown, never as «not done»; a green deploy job is evidence, not proof. Verified is bound to a requirement revision and a commit, so a new revision makes it stale. Read-only: never commits, pushes, merges or deploys.',
  inputSchema: {
    type: 'object',
    required: ['change_ref'],
    properties: {
      change_ref: { type: 'string', description: 'What to judge: PR/issue number or URL («#115», «PR #115», «https://github.com/owner/repo/pull/115»), a branch («branch eng/x»), a commit («sha abc1234») or a task label bound by engineering_change_bind.' },
      repo: { type: 'string', description: 'owner/name (e.g. trained-assist/software-engineering-playbooks). Optional when change_ref is a full GitHub URL — a stated repo always wins.' },
      workspace_ref: { type: 'string', description: 'Workspace id from engineering_spawn_workspace, or a path on disk. Omit to resolve the workspace by task label; a path that is not a git repository makes the git stages not_applicable (an external document delivered without Git).' },
      requirements_ref: { type: 'string', description: 'The accepted requirements this change is judged against (e.g. «issue#112@3»). A verification record for different requirements is reported as stale, not as verified.' },
    },
  },
  handler: async (args = {}) => {
    const { principal, workspaceRoot } = context();
    return changeStatus({ ...(args || {}) }, { principal, workspaceRoot });
  },
}];