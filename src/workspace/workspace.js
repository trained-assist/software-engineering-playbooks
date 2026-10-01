'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const { fail, WorkspaceError } = require('./errors');
const { isInside, realpathOrNull, assertAbsolute, assertContained, sanitizeSegment } = require('./paths');
const git = require('./git');
const store = require('./store');

const CODE_READY = 'code_ready';
const PROVISIONING = 'provisioning';
const NEEDS_REVIEW = 'needs_review';
const RELEASED = 'released';
const FAILED = 'failed';
const STATUSES = [CODE_READY, PROVISIONING, NEEDS_REVIEW, RELEASED, FAILED];

function nowIso() {
  return new Date().toISOString();
}

function ownerKeyOf({ principal, repositoryId, rootTaskId }) {
  return `${principal}\u0000${repositoryId}\u0000${rootTaskId}`;
}

function workspaceIdOf(ownerKey, idempotencyKey) {
  return `ws-${store.shortHash(`${ownerKey}\u0000${idempotencyKey}`, 16)}`;
}

// Operation records share one flat store per workspaceRoot, so their key must
// identify the operation the way the caller does: (principal, repository) plus
// the idempotency key it handed in. Keying them by the bare idempotencyKey made
// one plan unable to touch two repositories — for-task.js passes rootTaskId as
// the idempotency key, so the second repository compared its fingerprint (which
// contains repositoryId) against the first repository's record and refused with
// CONFLICT "idempotency key was already used with incompatible arguments".
// rootTaskId stays out of this key on purpose: reusing one idempotency key for
// two different tasks in the same repository is a caller bug and must keep
// conflicting.
function operationKeyOf({ principal, repositoryId }, idempotencyKey) {
  return `${principal}\u0000${repositoryId}\u0000${idempotencyKey}`;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') fail('INVALID_BINDING', 'binding object is required');
  const required = ['workspaceRoot', 'principal', 'hostId', 'repositoryId', 'sourceCheckout', 'baseRevision', 'rootTaskId', 'idempotencyKey'];
  for (const key of required) {
    if (typeof binding[key] !== 'string' || !binding[key].trim()) fail('INVALID_BINDING', `${key} is required`);
  }
  assertAbsolute(binding.workspaceRoot, 'workspaceRoot');
  assertAbsolute(binding.sourceCheckout, 'sourceCheckout');
  if (path.parse(binding.workspaceRoot).root === binding.workspaceRoot) {
    fail('INVALID_BINDING', 'workspaceRoot must not be a filesystem root');
  }

  fs.mkdirSync(path.resolve(binding.workspaceRoot), { recursive: true });
  const workspaceRoot = realpathOrNull(binding.workspaceRoot) || path.resolve(binding.workspaceRoot);
  const sourceCheckout = realpathOrNull(binding.sourceCheckout) || path.resolve(binding.sourceCheckout);

  if (!git.isGitRepo(sourceCheckout)) {
    fail('INVALID_BINDING', 'sourceCheckout is not a git repository', { sourceCheckout });
  }
  if (isInside(sourceCheckout, workspaceRoot)) {
    fail('INVALID_BINDING', 'workspaceRoot must live outside the source checkout', { sourceCheckout, workspaceRoot });
  }

  if (binding.allowedRoots !== undefined) {
    if (!Array.isArray(binding.allowedRoots) || binding.allowedRoots.length === 0) {
      fail('INVALID_BINDING', 'allowedRoots must be a non-empty array when provided');
    }
    const roots = binding.allowedRoots.map((r) => realpathOrNull(r) || path.resolve(r));
    const approved = roots.some((r) => isInside(r, workspaceRoot) && isInside(r, sourceCheckout));
    if (!approved) fail('PATH_ESCAPE', 'binding is outside the host-approved roots', { workspaceRoot, sourceCheckout });
  }

  return {
    workspaceRoot,
    sourceCheckout,
    principal: binding.principal,
    hostId: binding.hostId,
    repositoryId: binding.repositoryId,
    baseRevision: binding.baseRevision.trim(),
    rootTaskId: binding.rootTaskId,
    idempotencyKey: binding.idempotencyKey,
    workspaceProfile: binding.workspaceProfile || 'cli',
    allowFetch: Boolean(binding.allowFetch),
    leaseTtlMs: binding.leaseTtlMs || null,
  };
}

function fingerprintOf(b, resolvedBase) {
  return store.hash(JSON.stringify({
    workspaceRoot: b.workspaceRoot,
    sourceCheckout: b.sourceCheckout,
    principal: b.principal,
    hostId: b.hostId,
    repositoryId: b.repositoryId,
    rootTaskId: b.rootTaskId,
    workspaceProfile: b.workspaceProfile,
    baseRevision: resolvedBase,
  }));
}

function resolveBaseRevision(b) {
  let sha = git.resolveCommit(b.sourceCheckout, b.baseRevision);
  if (sha) return sha;
  if (b.allowFetch) {
    for (const remote of git.remoteNames(b.sourceCheckout)) {
      if (git.fetchRevision(b.sourceCheckout, b.baseRevision, remote)) {
        sha = git.resolveCommit(b.sourceCheckout, b.baseRevision);
        if (sha) return sha;
      }
    }
  }
  fail('UNKNOWN_REVISION', `cannot resolve exact commit ${b.baseRevision} in source checkout`, {
    baseRevision: b.baseRevision,
    sourceCheckout: b.sourceCheckout,
    hint: 'known offline revisions are acceptable; unknown revisions require fetch',
  });
}

function layoutFor(b, workspaceId) {
  const workspaceDir = path.join(
    b.workspaceRoot,
    sanitizeSegment(b.principal),
    sanitizeSegment(b.repositoryId),
    workspaceId,
  );
  return {
    workspaceDir,
    codePath: path.join(workspaceDir, 'code'),
    runtimePath: path.join(workspaceDir, 'runtime'),
    // Human-readable, not the opaque workspaceId hash: a session (or a human
    // skimming `git branch`/the PR list) must be able to tell whose task this
    // is by the name alone. Uniqueness still comes from git itself refusing a
    // duplicate branch (BRANCH_COLLISION below), not from this being a hash.
    branch: `eng/${sanitizeSegment(b.principal)}-${sanitizeSegment(b.rootTaskId)}`,
  };
}

function runtimeScaffold(runtimePath) {
  for (const sub of ['data', 'logs', 'tmp', 'config']) {
    fs.mkdirSync(path.join(runtimePath, sub), { recursive: true });
  }
}

function buildRecord({ b, resolvedBase, workspaceId, layout, ownerKey, fingerprint, leaseGeneration = 1 }) {
  const at = nowIso();
  return {
    schemaVersion: 1,
    workspaceId,
    repositoryId: b.repositoryId,
    rootTaskId: b.rootTaskId,
    principal: b.principal,
    hostId: b.hostId,
    workspaceProfile: b.workspaceProfile,
    engineeringRevision: pkg.version,
    baseRevision: resolvedBase,
    branch: layout.branch,
    codePath: layout.codePath,
    runtimePath: layout.runtimePath,
    sourceCheckout: b.sourceCheckout,
    operationKey: operationKeyOf(b, b.idempotencyKey),
    operationFingerprint: fingerprint,
    ownerKey,
    leaseGeneration,
    status: PROVISIONING,
    readiness: { requested: CODE_READY, actual: PROVISIONING },
    git: { headRevision: null, worktreeRegistered: false },
    retention: null,
    failure: null,
    createdAt: at,
    updatedAt: at,
    releasedAt: null,
  };
}

function summarize(record, extra = {}) {
  return {
    status: record.status,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    rootTaskId: record.rootTaskId,
    principal: record.principal,
    hostId: record.hostId,
    workspaceProfile: record.workspaceProfile,
    baseRevision: record.baseRevision,
    branch: record.branch,
    codePath: record.codePath,
    runtimePath: record.runtimePath,
    leaseGeneration: record.leaseGeneration,
    readiness: record.readiness,
    git: record.git,
    retention: record.retention,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    releasedAt: record.releasedAt,
    ...extra,
  };
}

function readOperation(workspaceRoot, operationKey) {
  return store.readJsonSafe(store.operationFile(workspaceRoot, operationKey));
}

function writeOperation(workspaceRoot, operationKey, patch) {
  const file = store.operationFile(workspaceRoot, operationKey);
  const prev = store.readJsonSafe(file) || {};
  store.writeJsonAtomic(file, { schemaVersion: 1, ...prev, ...patch, updatedAt: nowIso() });
}

function readOwner(workspaceRoot, ownerKey) {
  return store.readJsonSafe(store.ownerFile(workspaceRoot, ownerKey));
}

function writeOwner(workspaceRoot, ownerKey, patch) {
  const file = store.ownerFile(workspaceRoot, ownerKey);
  const prev = store.readJsonSafe(file) || {};
  store.writeJsonAtomic(file, { schemaVersion: 1, ...prev, ...patch, updatedAt: nowIso() });
}

function readIntent(workspaceRoot, workspaceId) {
  return store.readJsonSafe(store.intentFile(workspaceRoot, workspaceId));
}

function writeIntent(workspaceRoot, workspaceId, patch) {
  const file = store.intentFile(workspaceRoot, workspaceId);
  const prev = store.readJsonSafe(file) || {};
  store.writeJsonAtomic(file, { schemaVersion: 1, ...prev, ...patch, updatedAt: nowIso() });
}

function loadWorkspace(workspaceRoot, workspaceId) {
  return store.readJsonSafe(store.workspaceFile(workspaceRoot, workspaceId));
}

function saveWorkspace(workspaceRoot, record) {
  record.updatedAt = nowIso();
  store.writeJsonAtomic(store.workspaceFile(workspaceRoot, record.workspaceId), record);
}

// A lease that reached RELEASED/FAILED is over: its worktree is gone and its
// branch is merged or deliberately retained. Its operation record and workspace
// record stay on disk as history — but they must not act as a live reservation,
// because the caller is entitled to reuse the same (principal, repository,
// rootTaskId) label for the next lease. The fingerprint deliberately contains
// the resolved base revision, so a new spawn after release always computes a
// different one; comparing it against a finished lease is what used to burn the
// label for good with CONFLICT "incompatible idempotency arguments".
function isFinishedLease(workspaceRoot, op) {
  if (!op || !op.workspaceId) return false;
  const record = loadWorkspace(workspaceRoot, op.workspaceId);
  return Boolean(record && [RELEASED, FAILED].includes(record.status));
}

function completeProvision({ b, resolvedBase, fingerprint, workspaceId, layout, ownerKey, hooks = {}, reused = false, leaseGeneration = 1 }) {
  store.ensureStore(b.workspaceRoot);
  const intent = readIntent(b.workspaceRoot, workspaceId) || {};
  const operationKey = operationKeyOf(b, b.idempotencyKey);
  let state = intent.state || 'reserved';

  let worktree = git.worktreeForPath(b.sourceCheckout, layout.codePath);
  if (!worktree) {
    if (fs.existsSync(layout.codePath) && fs.readdirSync(layout.codePath).length > 0) {
      if (state === 'worktree_created') {
        writeIntent(b.workspaceRoot, workspaceId, { state: NEEDS_REVIEW, lastError: 'unregistered path occupied' });
        fail('NEEDS_REVIEW', 'worktree path is occupied but not registered with git', { codePath: layout.codePath });
      }
      fail('PATH_COLLISION', 'target worktree path already exists', { codePath: layout.codePath });
    }

    const branchExists = git.branchExists(b.sourceCheckout, layout.branch);
    const branchTip = branchExists ? git.resolveCommit(b.sourceCheckout, layout.branch) : null;
    if (branchExists && state !== 'worktree_created') {
      fail('BRANCH_COLLISION', 'target branch already exists', { branch: layout.branch });
    }
    if (branchExists && branchTip !== resolvedBase) {
      fail('BRANCH_COLLISION', 'existing branch does not point at the requested revision', { branch: layout.branch, branchTip, resolvedBase });
    }

    if (typeof hooks.beforeWorktree === 'function') hooks.beforeWorktree({ workspaceId, codePath: layout.codePath });

    fs.mkdirSync(layout.workspaceDir, { recursive: true });
    runtimeScaffold(layout.runtimePath);

    try {
      if (branchExists) {
        git.git(['worktree', 'add', layout.codePath, layout.branch], b.sourceCheckout, { allowFail: false });
      } else {
        git.worktreeAdd(b.sourceCheckout, { worktreePath: layout.codePath, branch: layout.branch, revision: resolvedBase });
      }
    } catch (e) {
      writeIntent(b.workspaceRoot, workspaceId, { state: FAILED, lastError: String(e.message || e) });
      fail('WORKTREE_FAILED', 'failed to create git worktree', { stderr: String(e.stderr || e.message || e) });
    }

    state = 'worktree_created';
    writeIntent(b.workspaceRoot, workspaceId, { state, worktreePath: layout.codePath });
    worktree = git.worktreeForPath(b.sourceCheckout, layout.codePath);
    if (typeof hooks.afterWorktree === 'function') hooks.afterWorktree({ workspaceId, codePath: layout.codePath });
  }

  const head = git.currentHead(layout.codePath);
  if (head !== resolvedBase) {
    writeIntent(b.workspaceRoot, workspaceId, { state: NEEDS_REVIEW, lastError: `head ${head} != base ${resolvedBase}` });
    fail('HEAD_MISMATCH', 'created worktree HEAD does not match the requested revision', { head, resolvedBase, codePath: layout.codePath });
  }

  const existing = loadWorkspace(b.workspaceRoot, workspaceId);
  const record = existing || buildRecord({ b, resolvedBase, workspaceId, layout, ownerKey, fingerprint, leaseGeneration });
  const previousLeaseFinished = Boolean(existing) && [RELEASED, FAILED].includes(existing.status);
  record.status = PROVISIONING;
  record.readiness = { requested: CODE_READY, actual: PROVISIONING };
  record.git = { headRevision: head, worktreeRegistered: Boolean(worktree) };
  record.failure = null;
  record.retention = null;
  record.releasedAt = previousLeaseFinished ? null : record.releasedAt;
  // Same reason: the record must describe the lease that is actually running
  // now, otherwise status() keeps reporting the base revision and fingerprint of
  // a lease that no longer exists.
  if (previousLeaseFinished) {
    record.baseRevision = resolvedBase;
    record.operationFingerprint = fingerprint;
  }
  // A record left by a finished lease must not pin the new lease to the old
  // generation number — leaseGeneration is what tells a resumed lease from a
  // fresh one, so keep the caller's value across a re-lease and only preserve it
  // when the same lease is being completed again (crash recovery, resume).
  if (existing) {
    record.leaseGeneration = previousLeaseFinished
      ? leaseGeneration
      : (existing.leaseGeneration || leaseGeneration);
  }
  saveWorkspace(b.workspaceRoot, record);

  writeIntent(b.workspaceRoot, workspaceId, { state: 'metadata_written', worktreePath: layout.codePath });
  if (typeof hooks.afterMetadata === 'function') hooks.afterMetadata({ workspaceId, codePath: layout.codePath });

  record.status = CODE_READY;
  record.readiness = { requested: CODE_READY, actual: CODE_READY };
  record.git = { headRevision: head, worktreeRegistered: Boolean(worktree) };
  saveWorkspace(b.workspaceRoot, record);

  writeIntent(b.workspaceRoot, workspaceId, { state: CODE_READY, attempts: (intent.attempts || 0) + 1, lastError: null });
  writeOperation(b.workspaceRoot, operationKey, {
    operationKey,
    fingerprint,
    workspaceId,
    ownerKey,
    status: CODE_READY,
  });
  writeOwner(b.workspaceRoot, ownerKey, {
    ownerKey,
    workspaceId,
    operationKey,
    principal: b.principal,
    hostId: b.hostId,
    repositoryId: b.repositoryId,
    rootTaskId: b.rootTaskId,
    leaseGeneration: record.leaseGeneration || 1,
    status: CODE_READY,
  });

  if (typeof hooks.afterSpawn === 'function') hooks.afterSpawn({ workspaceId, codePath: layout.codePath });

  return summarize(record, { found: true, reused, recovered: state !== 'reserved' && !reused });
}

function spawnWorkspace(binding, options = {}) {
  const b = normalizeBinding(binding);
  const hooks = options.hooks || {};
  const resolvedBase = resolveBaseRevision(b);
  const fingerprint = fingerprintOf(b, resolvedBase);
  const ownerKey = ownerKeyOf(b);
  const workspaceId = workspaceIdOf(ownerKey, b.idempotencyKey);
  const operationKey = operationKeyOf(b, b.idempotencyKey);
  const layout = layoutFor(b, workspaceId);

  assertContained(b.workspaceRoot, layout.workspaceDir, 'workspace directory');
  assertContained(b.workspaceRoot, layout.codePath, 'code path');
  assertContained(b.workspaceRoot, layout.runtimePath, 'runtime path');

  store.ensureStore(b.workspaceRoot);

  // A finished lease (released/failed) leaves its operation record behind as
  // history. Read it, but treat it as absent: the next spawn for this label is a
  // new lease and must be allowed to resolve a fresh base revision.
  const finished = isFinishedLease(b.workspaceRoot, readOperation(b.workspaceRoot, operationKey));
  const existingOp = finished ? null : readOperation(b.workspaceRoot, operationKey);
  if (existingOp) {
    if (existingOp.fingerprint !== fingerprint) {
      fail('CONFLICT', 'idempotency key was already used with incompatible arguments', {
        operationKey,
        existingWorkspaceId: existingOp.workspaceId,
        workspaceId,
      });
    }
    if (existingOp.status === CODE_READY) {
      const record = loadWorkspace(b.workspaceRoot, existingOp.workspaceId || workspaceId);
      if (record && record.status === CODE_READY) return summarize(record, { found: true, reused: true, recovered: false });
    }
  }

  const releaseOp = store.acquireLock(store.lockFile(b.workspaceRoot, `op:${operationKey}`));
  const releaseOwner = store.acquireLock(store.lockFile(b.workspaceRoot, `owner:${ownerKey}`));
  try {
    const op = isFinishedLease(b.workspaceRoot, readOperation(b.workspaceRoot, operationKey))
      ? null
      : readOperation(b.workspaceRoot, operationKey);
    if (op) {
      if (op.fingerprint !== fingerprint) {
        fail('CONFLICT', 'idempotency key was already used with incompatible arguments', {
          operationKey,
          existingWorkspaceId: op.workspaceId,
          workspaceId,
        });
      }
      const existingOwner = readOwner(b.workspaceRoot, ownerKey);
      return completeProvision({
        b,
        resolvedBase,
        fingerprint,
        workspaceId: op.workspaceId || workspaceId,
        layout,
        ownerKey,
        hooks,
        reused: true,
        leaseGeneration: existingOwner ? existingOwner.leaseGeneration : 1,
      });
    }

    const owner = readOwner(b.workspaceRoot, ownerKey);
    if (owner && ![RELEASED, FAILED].includes(owner.status)) {
      fail('CONFLICT', 'another workspace already owns this (principal, repository, task)', {
        ownerKey,
        existingWorkspaceId: owner.workspaceId,
      });
    }
    const nextLease = (owner && owner.leaseGeneration ? owner.leaseGeneration : 0) + 1;

    writeOperation(b.workspaceRoot, operationKey, {
      operationKey,
      fingerprint,
      workspaceId,
      ownerKey,
      status: PROVISIONING,
      createdAt: nowIso(),
    });
    writeIntent(b.workspaceRoot, workspaceId, {
      intentId: workspaceId,
      operationKey,
      idempotencyKey: b.idempotencyKey,
      ownerKey,
      workspaceId,
      state: 'reserved',
      attempts: 0,
      binding: {
        workspaceRoot: b.workspaceRoot,
        sourceCheckout: b.sourceCheckout,
        principal: b.principal,
        hostId: b.hostId,
        repositoryId: b.repositoryId,
        rootTaskId: b.rootTaskId,
        workspaceProfile: b.workspaceProfile,
        baseRevision: resolvedBase,
      },
      branch: layout.branch,
      codePath: layout.codePath,
      runtimePath: layout.runtimePath,
      createdAt: nowIso(),
    });
    writeOwner(b.workspaceRoot, ownerKey, {
      ownerKey,
      workspaceId,
      operationKey,
      principal: b.principal,
      hostId: b.hostId,
      repositoryId: b.repositoryId,
      rootTaskId: b.rootTaskId,
      leaseGeneration: nextLease,
      status: PROVISIONING,
    });

    return completeProvision({ b, resolvedBase, fingerprint, workspaceId, layout, ownerKey, hooks, reused: false, leaseGeneration: nextLease });
  } finally {
    releaseOwner();
    releaseOp();
  }
}

function observeWorkspace(record) {
  const observed = {
    worktreeRegistered: false,
    headRevision: null,
    branch: null,
    dirty: false,
    hasUntracked: false,
    stashEntries: 0,
    hasRemote: false,
  };
  const src = record.sourceCheckout;
  if (src && fs.existsSync(src) && git.isGitRepo(src)) {
    observed.hasRemote = git.remoteNames(src).length > 0;
    observed.stashEntries = git.stashEntries(src).length;
    const wt = git.worktreeForPath(src, record.codePath);
    observed.worktreeRegistered = Boolean(wt);
    if (wt) {
      observed.headRevision = wt.head;
      observed.branch = wt.branch;
    }
  }
  if (fs.existsSync(record.codePath)) {
    const st = git.status(record.codePath);
    observed.dirty = st.dirty;
    observed.hasUntracked = st.hasUntracked;
  }
  return observed;
}

// `git stash` renders the branch in the stash message differently across git
// versions: for a slashed branch git 2.34 writes "WIP on alice-task-1" while
// the workspace branch is "eng/alice-task-1", so a message-only match
// (entry.includes(record.branch)) silently drops the retention guard and
// RELEASES a workspace whose uncommitted work is parked in a stash. Match the
// stash's base commit (stash@{n}^1) against this workspace's tips instead, and
// read the stash list from the source checkout AND the worktree — newer git
// keeps stashes per worktree, so the source list alone can be empty.
function stashBelongsToWorkspace(record, src) {
  const tips = new Set(
    [record.baseRevision, record.git && record.git.headRevision, git.currentHead(record.codePath)].filter(Boolean),
  );
  const repos = [...new Set([src, record.codePath])]
    .filter((p) => p && fs.existsSync(p) && git.isGitRepo(p));
  const refs = new Set();
  for (const repo of repos) {
    for (const entry of git.stashEntries(repo)) {
      if (entry.includes(record.branch)) return true;
      const colon = entry.indexOf(':');
      if (colon > 0) refs.add(entry.slice(0, colon));
    }
  }
  for (const ref of refs) {
    for (const repo of repos) {
      const base = git.resolveCommit(repo, `${ref}^1`);
      if (base && tips.has(base)) return true;
    }
  }
  return false;
}

function evaluateRetention(record, { processesStopped = true, force = false, deliveryEvidence = null } = {}) {
  const reasons = [];
  if (processesStopped !== true && !force) reasons.push('processes_active');
  if (!fs.existsSync(record.codePath)) {
    return { removable: reasons.length === 0 || force, reasons, worktreeRegistered: false, worktreeMissing: true, merged: false };
  }
  const src = record.sourceCheckout;
  const registered = git.isGitRepo(src) && Boolean(git.worktreeForPath(src, record.codePath));
  const st = git.status(record.codePath);
  if (st.dirty) reasons.push('dirty');
  if (st.hasUntracked) reasons.push('untracked');

  const head = git.currentHead(record.codePath) || record.git.headRevision;
  const hasRemote = git.remoteNames(src).length > 0;
  const merged = Boolean(deliveryEvidence && deliveryEvidence.merged === true);
  let provenOnRemote = false;
  if (head && head !== record.baseRevision) {
    provenOnRemote = git.remoteBranchesContaining(src, head).length > 0;
    if (!provenOnRemote && !merged) reasons.push(hasRemote ? 'unpushed' : 'unknown_remote');
  }
  if (stashBelongsToWorkspace(record, src)) reasons.push('stash');

  return { removable: reasons.length === 0 || force, reasons, worktreeRegistered: registered, worktreeMissing: false, merged: merged || provenOnRemote };
}

function requireOwnership(record, { principal, rootTaskId, hostId } = {}) {
  if (principal && record.principal !== principal) fail('OWNERSHIP', 'principal does not own this workspace', { workspaceId: record.workspaceId });
  if (rootTaskId && record.rootTaskId !== rootTaskId) fail('OWNERSHIP', 'rootTaskId does not own this workspace', { workspaceId: record.workspaceId });
  if (hostId && record.hostId !== hostId) fail('OWNERSHIP', 'hostId does not own this workspace', { workspaceId: record.workspaceId });
}

function requireWorkspaceRoot(workspaceRoot) {
  assertAbsolute(workspaceRoot, 'workspaceRoot');
  if (!fs.existsSync(workspaceRoot)) fail('NOT_FOUND', `workspace root not found: ${workspaceRoot}`);
  return realpathOrNull(workspaceRoot) || path.resolve(workspaceRoot);
}

function statusWorkspace({ workspaceRoot, workspaceId, principal, rootTaskId, hostId } = {}) {
  const root = requireWorkspaceRoot(workspaceRoot);
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) fail('INVALID_BINDING', 'workspaceId is required');

  let record = loadWorkspace(root, workspaceId);
  const intent = readIntent(root, workspaceId);
  if (!record && intent && intent.state && intent.state !== CODE_READY) {
    try {
      record = recoverIntent(root, intent);
    } catch (e) {
      return {
        status: NEEDS_REVIEW,
        found: false,
        workspaceId,
        recovered: false,
        reason: e.message,
        reasonCode: e.code || 'RECOVERY_FAILED',
      };
    }
  }
  if (!record) return { status: 'missing', found: false, workspaceId };

  requireOwnership(record, { principal, rootTaskId, hostId });
  const observed = observeWorkspace(record);
  const retention = record.status === CODE_READY ? evaluateRetention(record, {}) : record.retention || null;
  return { ...summarize(record), found: true, observed, retention };
}

function releaseWorkspace({
  workspaceRoot,
  workspaceId,
  principal,
  rootTaskId,
  hostId,
  processesStopped = true,
  force = false,
  deliveryEvidence = null,
} = {}) {
  const root = requireWorkspaceRoot(workspaceRoot);
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) fail('INVALID_BINDING', 'workspaceId is required');

  let record = loadWorkspace(root, workspaceId);
  const intent = readIntent(root, workspaceId);
  if (!record && intent && intent.state && intent.state !== CODE_READY) {
    record = recoverIntent(root, intent);
  }
  if (!record) fail('NOT_FOUND', `workspace not found: ${workspaceId}`);

  requireOwnership(record, { principal, rootTaskId, hostId });

  if (record.status === RELEASED) {
    return summarize(record, { found: true, alreadyReleased: true, removed: false });
  }

  const evaluation = evaluateRetention(record, { processesStopped, force, deliveryEvidence });
  if (!evaluation.removable && !force) {
    record.status = NEEDS_REVIEW;
    record.retention = { reasons: evaluation.reasons, evaluatedAt: nowIso() };
    record.readiness = { ...record.readiness, actual: NEEDS_REVIEW };
    saveWorkspace(root, record);
    writeOwner(root, record.ownerKey, { status: NEEDS_REVIEW });
    return summarize(record, { found: true, retained: true, removed: false, reasons: evaluation.reasons });
  }

  if (evaluation.worktreeRegistered) {
    const removal = git.worktreeRemove(record.sourceCheckout, record.codePath, { force: Boolean(force) });
    if (!removal.ok) {
      record.status = NEEDS_REVIEW;
      record.retention = { reasons: ['worktree_remove_failed'], error: removal.stderr, evaluatedAt: nowIso() };
      saveWorkspace(root, record);
      writeOwner(root, record.ownerKey, { status: NEEDS_REVIEW });
      return summarize(record, { found: true, retained: true, removed: false, reasons: ['worktree_remove_failed'] });
    }
  }

  if (fs.existsSync(record.runtimePath)) fs.rmSync(record.runtimePath, { recursive: true, force: true });
  store.removeDirIfEmpty(path.dirname(record.codePath));

  const branchTip = git.resolveCommit(record.sourceCheckout, record.branch);
  let branchDeleted = false;
  let branchRetained = false;
  if (branchTip) {
    const noUniqueCommits = branchTip === record.baseRevision;
    if (noUniqueCommits || evaluation.merged) {
      const deletion = git.deleteBranch(record.sourceCheckout, record.branch, { force: noUniqueCommits });
      branchDeleted = deletion.ok;
      if (!deletion.ok) branchRetained = true;
    } else {
      branchRetained = true;
    }
  }

  record.status = RELEASED;
  record.releasedAt = nowIso();
  record.retention = null;
  record.readiness = { ...record.readiness, actual: RELEASED };
  record.git = { ...record.git, headRevision: branchTip, worktreeRegistered: false };
  saveWorkspace(root, record);
  writeOwner(root, record.ownerKey, { status: RELEASED, leaseGeneration: record.leaseGeneration });

  return summarize(record, { found: true, removed: true, branchDeleted, branchRetained });
}

function recoverIntent(root, intent) {
  const binding = intent.binding || {};
  const b = {
    workspaceRoot: root,
    sourceCheckout: binding.sourceCheckout,
    principal: binding.principal,
    hostId: binding.hostId,
    repositoryId: binding.repositoryId,
    baseRevision: binding.baseRevision,
    rootTaskId: binding.rootTaskId,
    // Intents written before the operation key was scoped carry the bare
    // idempotency key in operationKey; fall back to it so recovery of an
    // in-flight spawn still rebuilds the same workspace id.
    idempotencyKey: intent.idempotencyKey || intent.operationKey,
    workspaceProfile: binding.workspaceProfile || 'cli',
    allowFetch: false,
    leaseTtlMs: null,
  };
  const resolvedBase = binding.baseRevision;
  const operation = readOperation(root, intent.operationKey);
  const layout = {
    workspaceDir: path.dirname(intent.codePath),
    codePath: intent.codePath,
    runtimePath: intent.runtimePath,
    branch: intent.branch,
  };
  const owner = readOwner(root, intent.ownerKey);
  return completeProvision({
    b,
    resolvedBase,
    fingerprint: operation ? operation.fingerprint : null,
    workspaceId: intent.workspaceId,
    layout,
    ownerKey: intent.ownerKey,
    hooks: {},
    reused: true,
    leaseGeneration: owner ? owner.leaseGeneration : 1,
  });
}

function walkWorktreeCodes(workspaceRoot) {
  const found = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === store.STORE_DIRNAME) continue;
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === 'code' && fs.existsSync(path.join(full, '.git'))) {
        found.push(full);
        continue;
      }
      walk(full, depth + 1);
    }
  }
  walk(workspaceRoot, 0);
  return found;
}

function reconcileWorkspaces({ workspaceRoot } = {}) {
  const root = requireWorkspaceRoot(workspaceRoot);
  const dirs = store.ensureStore(root);
  const report = { checked: 0, recovered: [], needsReview: [], failed: [], orphans: [] };

  const intents = store.listFiles(dirs.intents).map((f) => store.readJsonSafe(path.join(dirs.intents, f))).filter(Boolean);
  for (const intent of intents) {
    report.checked += 1;
    if (intent.state === CODE_READY) continue;
    const existing = loadWorkspace(root, intent.workspaceId);
    if (existing && existing.status === CODE_READY) {
      report.recovered.push({ workspaceId: intent.workspaceId, status: CODE_READY });
      continue;
    }
    try {
      const recovered = recoverIntent(root, intent);
      report.recovered.push({ workspaceId: recovered.workspaceId, status: recovered.status });
    } catch (e) {
      const entry = { workspaceId: intent.workspaceId, reason: e.message, reasonCode: e.code || 'RECOVERY_FAILED' };
      if (e.code === 'NEEDS_REVIEW') report.needsReview.push(entry);
      else report.failed.push(entry);
    }
  }

  const records = store.listFiles(dirs.workspaces).map((f) => store.readJsonSafe(path.join(dirs.workspaces, f))).filter(Boolean);
  const known = new Set();
  for (const record of records) if (record.status !== RELEASED) known.add(record.codePath);
  for (const intent of intents) if (intent.state !== RELEASED) known.add(intent.codePath);
  for (const codePath of walkWorktreeCodes(root)) {
    if (!known.has(codePath)) report.orphans.push({ codePath, action: 'retained' });
  }
  return report;
}

module.exports = {
  spawnWorkspace,
  statusWorkspace,
  releaseWorkspace,
  reconcileWorkspaces,
  WorkspaceError,
  workspaceIdOf,
  ownerKeyOf,
  operationKeyOf,
  STATUSES,
  CODE_READY,
  NEEDS_REVIEW,
  RELEASED,
};
