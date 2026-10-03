'use strict';

// Local, READ-ONLY facts for change_status (#112).
//
// Everything here is `git` plumbing that only reads: status, rev-parse,
// rev-list, merge-base. No fetch, no commit, no push — the tool must be safe to
// call at any moment, including while an agent is mid-edit (#112: «метод
// read-only, без auto-commit/push/merge»).
//
// A workspace we cannot resolve is `available: null` — NOT false. Only a
// resolved path that is demonstrably not a git worktree is `available: false`
// (that is the `not_applicable` case: an external document delivered without a
// repository). Absence of a workspace never proves absence of a change.

const path = require('path');
const fs = require('fs');
const gitlib = require('../workspace/git');
const storeLocal = require('../change-find/local');
const { normTask } = require('../change-find/refs');

const MAX_AHEAD_SHAS = 20;
const MAX_DIRTY_FILES = 50;

function headBranch(repoPath) {
  const out = gitlib.git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath).stdout;
  if (!out || out === 'HEAD') return null; // detached
  return out;
}

function revParse(repoPath, rev) {
  return gitlib.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], repoPath).stdout || null;
}

function revListShas(repoPath, range, limit = MAX_AHEAD_SHAS) {
  const out = gitlib.git(['rev-list', `-n${limit}`, range], repoPath).stdout;
  return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

// Local default-branch detection only looks at remote-tracking refs, so the
// answer can be stale after someone else pushed. That is reported, not hidden.
function localDefaultBranch(repoPath) {
  return gitlib.defaultBranch(repoPath, 'origin') || gitlib.defaultBranch(repoPath, 'upstream');
}

/**
 * Resolve which workspace the caller means.
 * Precedence: explicit workspace_ref → the workspace recorded for the task
 * (workspace record whose root_task_id matches, then the saved binding from
 * engineering_change_bind) → nothing.
 */
function resolveWorkspace({ workspaceRef, taskRef, repo, principal, workspaceRoot }) {
  const workspaces = storeLocal.listWorkspaces({ workspaceRoot, principal, repositoryId: repo });

  if (workspaceRef) {
    const ref = String(workspaceRef).trim();
    const byId = workspaces.find(w => w.workspaceId === ref);
    if (byId) return { found: true, via: 'workspace_ref', record: byId, code_path: byId.codePath || null, workspace_id: byId.workspaceId };
    if (ref && (ref.includes('/') || ref.startsWith('.')) && fs.existsSync(ref) && fs.statSync(ref).isDirectory()) {
      return { found: true, via: 'path', record: null, code_path: path.resolve(ref), workspace_id: null };
    }
    return {
      found: false,
      via: 'workspace_ref',
      workspace_id: ref,
      reason: `рабочая область «${ref}» не найдена в хранилище этого профиля (и не является путём на диске)`,
    };
  }

  if (taskRef) {
    const byTask = workspaces.find(w => normTask(w.rootTaskId) === normTask(taskRef));
    if (byTask) return { found: true, via: 'workspace_record', record: byTask, code_path: byTask.codePath || null, workspace_id: byTask.workspaceId };
    const binding = storeLocal.readBinding({ workspaceRoot, principal, repositoryId: repo, taskRef });
    if (binding && binding.workspaceId) {
      const byBinding = workspaces.find(w => w.workspaceId === binding.workspaceId);
      if (byBinding) return { found: true, via: 'saved_binding', record: byBinding, code_path: byBinding.codePath || null, workspace_id: byBinding.workspaceId };
    }
  }

  return {
    found: false,
    via: null,
    reason: 'рабочая область для этой задачи не найдена: локальные факты (written/committed/pushed) недоступны — их отсутствие ничего не доказывает',
  };
}

/** Read-only git snapshot of one code path. */
function gitFacts(codePath) {
  if (!codePath) return { available: null, reason: 'нет рабочей области' };
  if (!fs.existsSync(codePath)) return { available: null, code_path: codePath, reason: `путь рабочей области не существует: ${codePath}` };
  if (!gitlib.isGitWorktree(codePath)) {
    return { available: false, code_path: codePath, reason: `путь не является git-рабочей областью: ${codePath}` };
  }

  const st = gitlib.status(codePath);
  const branch = headBranch(codePath);
  const head = gitlib.currentHead(codePath);
  const upstream = branch ? gitlib.upstream(codePath, branch) : null;
  const upstreamSha = upstream ? revParse(codePath, upstream) : null;

  const defBranch = localDefaultBranch(codePath);

  // A freshly created task branch tracks nothing (`git checkout -b`), so there is
  // no upstream to diff against. Falling back to the locally known default
  // branch gives a real answer («2 коммита отсутствуют в origin/main») instead
  // of a shrug; the base used is reported so the answer stays auditable.
  const comparisonBase = upstreamSha ? upstream : (defBranch && revParse(codePath, `origin/${defBranch}`) ? `origin/${defBranch}` : null);

  let commitsAhead = null;
  let aheadShas = [];
  if (comparisonBase && head) {
    const n = gitlib.countAhead(codePath, `${comparisonBase}..HEAD`);
    commitsAhead = n === null ? null : Number(n);
    aheadShas = commitsAhead > 0 ? revListShas(codePath, `${comparisonBase}..HEAD`) : [];
  }
  let mergedIntoDefault = null;
  let defaultHeadSha = null;
  if (defBranch && head) {
    const remoteDefault = `origin/${defBranch}`;
    const defaultSha = revParse(codePath, remoteDefault);
    if (defaultSha) {
      defaultHeadSha = defaultSha;
      mergedIntoDefault = gitlib.isMergedInto(codePath, 'HEAD', defaultSha);
    }
  }

  const files = st.lines.length;
  return {
    available: true,
    code_path: codePath,
    branch,
    head_sha: head,
    dirty: {
      files,
      tracked: st.tracked.slice(0, MAX_DIRTY_FILES),
      untracked: st.untracked.slice(0, MAX_DIRTY_FILES),
    },
    upstream,
    upstream_sha: upstreamSha,
    comparison_base: comparisonBase,
    commits_ahead: commitsAhead,
    ahead_shas: aheadShas,
    default_branch: defBranch,
    default_head_sha: defaultHeadSha,
    merged_into_default: mergedIntoDefault,
  };
}

function localFacts({ workspaceRef, taskRef, repo, principal, workspaceRoot }) {
  const ws = resolveWorkspace({ workspaceRef, taskRef, repo, principal, workspaceRoot });
  if (!ws.found) {
    return {
      workspace: { found: false, via: null, workspace_id: workspaceRef || null, code_path: null, reason: ws.reason },
      git: { available: null, reason: ws.reason },
    };
  }
  const git = gitFacts(ws.code_path);
  return {
    workspace: {
      found: true,
      via: ws.via,
      workspace_id: ws.workspace_id,
      code_path: ws.code_path,
      status: (ws.record && ws.record.status) || null,
      branch: (ws.record && ws.record.branch) || null,
      reason: git.available === false ? git.reason : null,
    },
    git,
  };
}

module.exports = { localFacts, resolveWorkspace, gitFacts, headBranch, revParse, MAX_DIRTY_FILES };