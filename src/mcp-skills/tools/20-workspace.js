'use strict';

const { statusWorkspaceForTask, releaseWorkspaceForTask } = require('../../workspace');
// The token-aware spawn + workspace prep used to live on a second tool (dev_workspace_setup).
// There was only ever one mechanic, so it is one tool now: engineering_spawn_workspace.
const { getToken, spawnTaskWorkspace, prepareWorkspace, detectDependencies } = require('./61-dev.js');

// `principal` is host-derived identity, never a tool-call argument: it comes
// from the MCP server process env (USER_ID), matching how trained-assist-agent's
// mcpToolEnv injects profile identity into sibling MCP servers (hh-skills,
// freelance-skills). Reading it inside the handler — not at require time —
// keeps the tools honest about "env wins" even if the caller smuggles a
// `principal` field into the arguments.
//
// Roots are optional host config (tests and non-default hosts point these at
// temp/owned dirs); when unset the library's own ~/agent-data defaults apply.
function context() {
  return {
    principal: process.env.USER_ID || '',
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
    mirrorsRoot: process.env.ENGINEERING_MIRRORS_ROOT || undefined,
  };
}

const CODE_PATH_HINT = 'The response includes codePath — cd into it and use it for every further git/file operation in this task; the repository checkout you started in is not where this branch lives.';
const COLLISION_HINT = 'A BRANCH_COLLISION error means another task already claimed this root_task_id label — pick a different root_task_id, or call engineering_workspace_status if you believe this is your own earlier attempt.';

const spawn = {
  name: 'engineering_spawn_workspace',
  description: `Create an isolated git worktree + branch for a task, ready to code in. Call this once you have decided to make a branch/PR — it clones/refreshes the repository mirror and bases a new 'eng/<profile>-<root_task_id>' branch off the default branch (or ref), then sets git identity, installs repo hooks and detects/installs dependencies (npm/pip/cargo). Two calls with different root_task_id get separate trees and branches. ${CODE_PATH_HINT} ${COLLISION_HINT}`,
  inputSchema: {
    type: 'object',
    required: ['repository_url', 'root_task_id'],
    properties: {
      repository_url: { type: 'string', description: 'Git URL of the repository to work in.' },
      root_task_id: { type: 'string', description: 'Short, readable label for this task (e.g. "fix-forum-topics"). Becomes the branch name; must be unique per task.' },
      ref: { type: 'string', description: 'Optional branch/tag to base the workspace off. Defaults to the repository default branch.' }
    }
  },
  handler: async ({ repository_url, root_task_id, ref } = {}) => {
    // A token lets private repos clone; without one public repos still work, so this is
    // not a gate — it degrades instead of refusing.
    let token = null;
    try { token = getToken(); } catch { /* no GitHub token — proceed unauthenticated */ }

    const result = spawnTaskWorkspace({
      repositoryUrl: repository_url,
      rootTaskId: root_task_id,
      ref,
      token,
    });
    const workspace = result.codePath;
    prepareWorkspace(workspace);
    const { deps, depsLog } = detectDependencies(workspace);
    return {
      ...result,
      workspace,
      codePath: workspace,
      repo: repository_url,
      deps,
      deps_log: depsLog,
    };
  },
};

const status = {
  name: 'engineering_workspace_status',
  description: `Report the current state of a task's workspace (branch, codePath, git status, retention/merge readiness) without mutating it. Use the same repository_url and root_task_id you spawned with. ${CODE_PATH_HINT}`,
  inputSchema: {
    type: 'object',
    required: ['repository_url', 'root_task_id'],
    properties: {
      repository_url: { type: 'string', description: 'Git URL of the repository the workspace belongs to.' },
      root_task_id: { type: 'string', description: 'The task label used when the workspace was spawned.' }
    }
  },
  handler: async ({ repository_url, root_task_id } = {}) => {
    const { principal, workspaceRoot } = context();
    return statusWorkspaceForTask({
      principal,
      repositoryUrl: repository_url,
      rootTaskId: root_task_id,
      workspaceRoot,
    });
  },
};

const release = {
  name: 'engineering_release_workspace',
  description: `Release (tear down) a finished task's workspace: removes the worktree and deletes the branch when its work is safely merged/pushed, otherwise retains it for review. Call only once the branch is merged (or you set delivery_evidence). Use the same repository_url and root_task_id you spawned with.`,
  inputSchema: {
    type: 'object',
    required: ['repository_url', 'root_task_id'],
    properties: {
      repository_url: { type: 'string', description: 'Git URL of the repository the workspace belongs to.' },
      root_task_id: { type: 'string', description: 'The task label used when the workspace was spawned.' },
      processes_stopped: { type: 'boolean', description: 'Whether all processes using the workspace have been stopped. Defaults to true.' },
      force: { type: 'boolean', description: 'Remove even if the workspace looks unmerged/dirty. Defaults to false.' },
      delivery_evidence: { type: 'object', description: 'Optional evidence that the work was delivered, e.g. {"merged": true, "evidence": "<merge commit/PR URL>"}.' }
    }
  },
  handler: async ({ repository_url, root_task_id, processes_stopped, force, delivery_evidence } = {}) => {
    const { principal, workspaceRoot } = context();
    return releaseWorkspaceForTask({
      principal,
      repositoryUrl: repository_url,
      rootTaskId: root_task_id,
      workspaceRoot,
      processesStopped: processes_stopped,
      force,
      deliveryEvidence: delivery_evidence,
    });
  },
};

module.exports = [spawn, status, release];
