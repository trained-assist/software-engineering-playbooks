'use strict';

// Self-service entry points a coding session calls mid-task, the moment it
// decides to make a branch/PR — not a host-orchestrated pre-launch step tied
// to any project/session id. spawnWorkspace()/statusWorkspace()/
// releaseWorkspace() (./workspace.js) already do the real work (git worktree,
// crash-safe state machine, dirty/unpushed release guards) and stay
// untouched; these wrappers only resolve the low-level fields that library
// expects (sourceCheckout, baseRevision, hostId, idempotencyKey) from the
// three things a session and its host actually have:
//   - principal: host-derived (env), never a session argument — keeps
//     profiles from mixing up on disk. Not a security boundary (this repo is
//     first-party, same-company code), just correctness.
//   - repositoryUrl: the session's own choice — access is already gated by
//     whatever git credentials the calling profile has.
//   - rootTaskId: the session's own short, readable label (e.g.
//     "fix-forum-topics"). It becomes the branch name (via workspace.js's
//     `eng/<principal>-<rootTaskId>`), so a colliding label from a second
//     session surfaces as an explicit BRANCH_COLLISION, not silent overwrite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');
const { fail } = require('./errors');
const { spawnWorkspace, statusWorkspace, releaseWorkspace, ownerKeyOf, workspaceIdOf, CODE_READY } = require('./workspace');
const { buildMap, mapStatus } = require('../repo-map');

const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), 'agent-data', 'engineering-workspaces');
const DEFAULT_MIRRORS_ROOT = path.join(os.homedir(), 'agent-data', 'engineering-mirrors');

// Background map build for the commit this workspace was just created at.
// Fire-and-forget on purpose: spawn must never wait for it (scenario step 1)
// and never fail because of it — a map is an optimisation, raw reading always
// works. REPO_MAP_SPAWN_BUILD=0 is the kill-switch: no redeploy, no rollback.
function spawnMapBuild({ codePath, workspaceRoot }) {
  if (process.env.REPO_MAP_SPAWN_BUILD === '0') return;
  buildMap({ repoPath: codePath, workspacesRoot: workspaceRoot }).then(
    (result) => console.error(`[repo-map] ${result.status} ${String(result.sha).slice(0, 8)} for ${path.basename(codePath)}`),
    (error) => console.error(`[repo-map] spawn build skipped: ${(error && error.message) || error}`),
  );
}

// One local mirror per repository, shared across principals/tasks — never a
// task's own working directory, only the thing git worktree forks from. Clone
// on first use, fetch to refresh on every later call.
function ensureMirror(repositoryUrl, mirrorsRoot) {
  const name = repositoryUrl.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/\.git$/, '');
  const dir = path.join(mirrorsRoot, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(mirrorsRoot, { recursive: true });
    git.git(['clone', repositoryUrl, dir], undefined, { allowFail: false });
  } else {
    git.git(['fetch', '--all', '--prune'], dir);
  }
  return dir;
}

function resolveBaseRevision(sourceCheckout, ref) {
  if (ref) return git.resolveCommit(sourceCheckout, ref) || git.resolveCommit(sourceCheckout, `origin/${ref}`);
  const branch = git.defaultBranch(sourceCheckout, 'origin');
  const candidates = branch ? [`origin/${branch}`, branch] : ['origin/main', 'main', 'origin/master', 'master'];
  for (const candidate of candidates) {
    const sha = git.resolveCommit(sourceCheckout, candidate);
    if (sha) return sha;
  }
  return null;
}

function repositoryIdFrom(repositoryUrl) {
  return repositoryUrl.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/') || repositoryUrl;
}

function requireTaskFields({ principal, repositoryUrl, rootTaskId }) {
  if (!principal) fail('INVALID_BINDING', 'principal is required (host-derived, not a session argument)');
  if (!repositoryUrl) fail('INVALID_BINDING', 'repositoryUrl is required');
  if (!rootTaskId) fail('INVALID_BINDING', 'rootTaskId is required — a short, readable label for this branch/task');
}

function spawnWorkspaceForTask({
  principal, repositoryUrl, repositoryId, rootTaskId, ref,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT, mirrorsRoot = DEFAULT_MIRRORS_ROOT, hostId,
} = {}) {
  requireTaskFields({ principal, repositoryUrl, rootTaskId });

  // Resume: a task that already has a ready workspace gets it back as-is,
  // before the mirror is refreshed. The base branch has usually moved since
  // the first spawn, and a re-resolved baseRevision changes the operation
  // fingerprint — spawnWorkspace() would then reject a legitimate resume as
  // "idempotency key was already used with incompatible arguments".
  if (fs.existsSync(workspaceRoot)) {
    const workspaceId = taskWorkspaceId({ principal, repositoryUrl, repositoryId, rootTaskId });
    const existing = statusWorkspace({ workspaceRoot, workspaceId, principal, rootTaskId });
    if (existing.found && existing.status === CODE_READY) {
      const actualBranch = git.git(['branch', '--show-current'], existing.codePath).stdout;
      if (actualBranch !== existing.branch) {
        fail('LABEL_BRANCH_MISMATCH', 'workspace branch differs from lease metadata; retained for review',
          { branch: existing.branch, actualBranch, workspaceId });
      }
      // Old lifecycle versions reissued the original branch for generation 2+.
      if (existing.leaseGeneration > 1 && !existing.branch.endsWith(`-lease-${existing.leaseGeneration}`)) {
        fail('LABEL_BRANCH_MERGED', 'legacy lease reused a publication branch; release it before respawning',
          { branch: existing.branch, leaseGeneration: existing.leaseGeneration, workspaceId });
      }
      const mirror = ensureMirror(repositoryUrl, mirrorsRoot);
      const base = resolveBaseRevision(mirror);
      const published = git.resolveCommit(mirror, `refs/remotes/origin/${existing.branch}`);
      if (published && base && git.isMergedInto(mirror, published, base)) {
        fail('LABEL_BRANCH_MERGED', 'published branch is already merged; release it before respawning',
          { branch: existing.branch, publishedRevision: published, workspaceId });
      }
      return { ...existing, reused: true, recovered: false };
    }
  }

  const sourceCheckout = ensureMirror(repositoryUrl, mirrorsRoot);
  const baseRevision = resolveBaseRevision(sourceCheckout, ref);
  if (!baseRevision) fail('UNKNOWN_REVISION', `cannot resolve ${ref || 'the default branch'} in mirror`, { sourceCheckout, repositoryUrl });

  return spawnWorkspace({
    workspaceRoot,
    sourceCheckout,
    baseRevision,
    principal,
    hostId: hostId || os.hostname(),
    repositoryId: repositoryId || repositoryIdFrom(repositoryUrl),
    rootTaskId,
    idempotencyKey: rootTaskId,
    allowFetch: true,
  }, {
    hooks: {
      afterSpawn: ({ codePath }) => spawnMapBuild({ codePath, workspaceRoot }),
    },
  });
}

function taskWorkspaceId({ principal, repositoryUrl, repositoryId, rootTaskId }) {
  requireTaskFields({ principal, repositoryUrl, rootTaskId });
  const ownerKey = ownerKeyOf({ principal, repositoryId: repositoryId || repositoryIdFrom(repositoryUrl), rootTaskId });
  return workspaceIdOf(ownerKey, rootTaskId);
}

function statusWorkspaceForTask({ principal, repositoryUrl, repositoryId, rootTaskId, workspaceRoot = DEFAULT_WORKSPACE_ROOT } = {}) {
  const workspaceId = taskWorkspaceId({ principal, repositoryUrl, repositoryId, rootTaskId });
  const status = statusWorkspace({ workspaceRoot, workspaceId, principal, rootTaskId });
  // Report whether the map for this workspace's commit exists yet (scenario
  // step 1). Read-only: status never triggers a build.
  if (status && status.codePath && status.status === CODE_READY) {
    status.repoMap = mapStatus({ repoPath: status.codePath, workspacesRoot: workspaceRoot });
  }
  return status;
}

function releaseWorkspaceForTask({
  principal, repositoryUrl, repositoryId, rootTaskId, workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  processesStopped = true, force = false, deliveryEvidence = null,
} = {}) {
  const workspaceId = taskWorkspaceId({ principal, repositoryUrl, repositoryId, rootTaskId });
  return releaseWorkspace({ workspaceRoot, workspaceId, principal, rootTaskId, processesStopped, force, deliveryEvidence });
}

module.exports = { spawnWorkspaceForTask, statusWorkspaceForTask, releaseWorkspaceForTask };
