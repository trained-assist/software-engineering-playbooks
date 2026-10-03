'use strict';

const { changeFind } = require('../../change-find/find');
const { changeBind } = require('../../change-find/bind');

// Same host-derived identity/roots contract as 20-workspace.js: principal comes
// from the MCP process env (USER_ID), roots from ENGINEERING_WORKSPACE_ROOT.
// Read inside the handler so "env wins" stays true even if a caller smuggles a
// `principal` field into the arguments.
function context() {
  return {
    principal: process.env.USER_ID || '',
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
  };
}

const find = {
  name: 'engineering_change_find',
  description: 'Find which workspace/branch/commits/PR belong to a task after an interruption: exact identity first (stated refs, saved bindings, workspace records, task-matching branches), then text-similarity candidates. Every candidate carries relation_type (exact|inferred), evidence, rank and supersede links; nothing is auto-selected. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'owner/name (e.g. trained-assist/software-engineering-playbooks) or a GitHub URL. Scope for GitHub rows and for owner-scoped store rows.' },
      task_ref: { type: 'string', description: 'The task label, issue/PR number or URL to look for («change-find», «#115», PR URL).' },
      query: { type: 'string', description: 'Free-text description of the work when there is no stable ref. Combined with task_ref when both are given.' },
      known_refs: { type: 'array', items: { type: 'string' }, description: 'Refs you already know (branch names, SHAs, «PR #115», URLs) — treated as exact, never as theme.' },
      time_range: {
        description: 'Optional filter on candidate timestamps: {"since":"2026-10-01","until":"2026-10-03"} or a JSON object string.',
        oneOf: [
          { type: 'object', properties: { since: { type: 'string' }, until: { type: 'string' } } },
          { type: 'string' },
        ],
      },
      limit: { type: 'number', description: 'Max INFERRED candidates to return (default 10, cap 50). Exact candidates are never cut.' },
    },
  },
  handler: async (args = {}) => {
    const { principal, workspaceRoot } = context();
    return changeFind({ ...(args || {}) }, { principal, workspaceRoot });
  },
};

const bind = {
  name: 'engineering_change_bind',
  description: 'Persist which change belongs to a task (the explicit write half of change_find): stores the chosen refs for your profile in the host-owned workspace store, so the next run of the same profile reads them back. Idempotent per (profile, repo, task_ref); another profile never sees the record. Requires refs.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'task_ref', 'refs'],
    properties: {
      repo: { type: 'string', description: 'owner/name or a GitHub URL.' },
      task_ref: { type: 'string', description: 'The task label the refs belong to (same value you will pass to change_find).' },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'The chosen refs, e.g. ["PR #115"] or ["branch eng/profile-task", "abc1234"]. One string is accepted too.',
      },
    },
  },
  handler: async (args = {}) => {
    const { principal, workspaceRoot } = context();
    return changeBind({ ...(args || {}) }, { principal, workspaceRoot });
  },
};

module.exports = [find, bind];
