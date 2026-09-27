'use strict';

const { registerAutofix, statusAutofix, disableAutofix, installAutofixWorkflow } = require('../../pr-autofix');

// `profileId` is host-derived identity (USER_ID), never a tool-call argument —
// same rule as the workspace and qa-log tools, so an argument cannot redirect
// the registry to another profile. Root is optional host config for hermetic
// tests (ENGINEERING_PR_AUTOFIX_ROOT).
function context() {
  return {
    profileId: process.env.USER_ID || '',
    root: process.env.ENGINEERING_PR_AUTOFIX_ROOT || undefined,
  };
}

const register = {
  name: 'engineering_pr_autofix_register',
  description: 'Register a repository for the pr-autofix service: records base branch, enabled features (fix/cleanup/batch), the pinned pr-autofix ref and capability records. Idempotent upsert keyed by repo; it never stores credentials and never auto-enables autofix. This slice writes local engineering state only (no workflow install, no secret delivery); a later external-write slice will require approval.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'Target repository in "owner/name" form.' },
      base_branch: { type: 'string', description: 'Branch autofix works against. Defaults to "main".' },
      features: {
        type: 'object',
        properties: {
          fix: { type: 'boolean' },
          cleanup: { type: 'boolean' },
          batch: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      autofix_ref: { type: 'string', description: 'Pinned pr-autofix revision/tag. Defaults to an immutable tag ("v1.7.0").' },
      ci_workflow_name: { type: 'string', description: 'name: of the target repo CI workflow the installed workflow_run trigger watches. Defaults to "CI".' },
      capabilities: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Requested capabilities as name -> description (capability records only, never secrets).',
      },
    },
  },
  handler: async ({ repo, base_branch, features, autofix_ref, ci_workflow_name, capabilities } = {}) => {
    const { profileId, root } = context();
    return registerAutofix({ profileId, root, registration: { repo, base_branch, features, autofix_ref, ci_workflow_name, capabilities } });
  },
};

const install = {
  name: 'engineering_pr_autofix_install',
  description: 'Install or update the pr-autofix workflow in a registered repository. Builds .github/workflows/pr-autofix.yml pinned to an immutable pr-autofix ref and opens (or updates) a pull request against the base branch; the cleanup workflow is installed when features.cleanup is set. EXTERNAL WRITE: opening a PR in the target repo requires approval and a host GitHub token (ENGINEERING_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN). It never writes credentials or repository Actions secrets. Idempotent: an identical pinned job already present is a no-op, and bumping autofix_ref updates the open install PR.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'Target repository in "owner/name" form (must be registered).' },
      base_branch: { type: 'string', description: 'Branch the install PR targets. Defaults to the registration base_branch.' },
      autofix_ref: { type: 'string', description: 'Immutable pr-autofix tag (e.g. "v1.2.1") or full commit SHA to pin.' },
      ci_workflow_name: { type: 'string', description: 'name: of the target repo CI workflow the workflow_run trigger watches. Defaults to "CI".' },
    },
  },
  handler: async ({ repo, base_branch, autofix_ref, ci_workflow_name } = {}) => {
    const { profileId, root } = context();
    return installAutofixWorkflow({ profileId, root, repo, base_branch, autofix_ref, ci_workflow_name });
  },
};

const status = {
  name: 'engineering_pr_autofix_status',
  description: 'Report pr-autofix registrations for the current profile and their lifecycle state, without mutating anything. Pass repo to narrow to one registration; omit it to list all.',
  inputSchema: {
    type: 'object',
    required: [],
    properties: {
      repo: { type: 'string', description: 'Optional "owner/name" to report a single registration.' },
    },
  },
  handler: async ({ repo } = {}) => {
    const { profileId, root } = context();
    return statusAutofix({ profileId, root, repo });
  },
};

const disable = {
  name: 'engineering_pr_autofix_disable',
  description: 'Disable pr-autofix for a registered repository (kill-switch): sets its local state to disabled. Idempotent. This slice changes local state only; a later external-write slice that removes the installed workflow will require approval.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: 'Target repository in "owner/name" form.' },
    },
  },
  handler: async ({ repo } = {}) => {
    const { profileId, root } = context();
    return disableAutofix({ profileId, root, repo });
  },
};

module.exports = [register, install, status, disable];
