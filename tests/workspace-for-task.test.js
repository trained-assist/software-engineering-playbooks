'use strict';

// PR2b/engineering_spawn_workspace minimal design (2026-09-25/26): a session
// calls spawnWorkspaceForTask() mid-task with just {principal, repositoryUrl,
// rootTaskId} — no idempotencyKey/hostId/sourceCheckout/baseRevision plumbing,
// no pre-existing local clone required. This exercises exactly that: the
// wrapper clones a bare "remote" itself, resolves the default branch, and
// forks a readable-named worktree branch from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnWorkspaceForTask, statusWorkspaceForTask, releaseWorkspaceForTask } = require('../src/workspace');
const { WorkspaceError } = require('../src/workspace/workspace');

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// A bare "remote" repo, cloned by ensureMirror() inside the wrapper — proves
// the wrapper never requires a pre-existing local checkout from the caller.
function makeRemote() {
  const bare = tmp('eng-remote-');
  runGit(bare, ['init', '--bare', '-q', '-b', 'main']);
  const work = tmp('eng-remote-work-');
  runGit(work, ['clone', '-q', bare, '.']);
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
  runGit(work, ['add', '.']);
  runGit(work, ['config', 'user.email', 'test@example.com']);
  runGit(work, ['config', 'user.name', 'Test']);
  runGit(work, ['commit', '-qm', 'initial']);
  runGit(work, ['push', '-q', 'origin', 'HEAD:main']);
  return bare;
}

function env(overrides = {}) {
  const workspaceRoot = tmp('eng-ws-');
  const mirrorsRoot = tmp('eng-mirrors-');
  return { workspaceRoot, mirrorsRoot, ...overrides };
}

test('spawnWorkspaceForTask resolves everything from principal/repositoryUrl/rootTaskId alone', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();

  const result = spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot });

  assert.equal(result.status, 'code_ready');
  assert.equal(result.branch, 'eng/vova-fix-forum-topics');
  assert.ok(fs.existsSync(path.join(result.codePath, 'README.md')));
  assert.equal(runGit(result.codePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'eng/vova-fix-forum-topics');
});

test('second call with the same rootTaskId reuses the same workspace (session resume)', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();
  const opts = { principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot };

  const first = spawnWorkspaceForTask(opts);
  const second = spawnWorkspaceForTask(opts);

  assert.equal(first.codePath, second.codePath);
  assert.equal(second.reused, true);
});

// Seen on the VM: the first spawn at 06:04, main moved, the resume at 07:19
// failed with "idempotency key was already used with incompatible arguments".
test('resume still reuses the workspace after the default branch moved on the remote', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();
  const opts = { principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot };

  const first = spawnWorkspaceForTask(opts);

  const work = tmp('eng-remote-advance-');
  runGit(work, ['clone', '-q', repositoryUrl, '.']);
  runGit(work, ['config', 'user.email', 'test@example.com']);
  runGit(work, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), 'moved\n');
  runGit(work, ['add', '.']);
  runGit(work, ['commit', '-qm', 'advance main']);
  runGit(work, ['push', '-q', 'origin', 'HEAD:main']);

  const second = spawnWorkspaceForTask(opts);

  assert.equal(second.status, 'code_ready');
  assert.equal(second.reused, true);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(second.codePath, first.codePath);
  assert.equal(second.baseRevision, first.baseRevision);
});

test('a branch already occupying the target name is an explicit collision, not a silent takeover', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();
  const mirrorDir = path.join(mirrorsRoot, repositoryUrl.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/\.git$/, ''));

  // Prime the mirror clone (any task), then create the branch our next call
  // will want, out of band — simulating stale/manual state, not our own
  // owner-key bookkeeping.
  spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'priming', workspaceRoot, mirrorsRoot });
  runGit(mirrorDir, ['branch', 'eng/vova-fix-forum-topics']);

  assert.throws(
    () => spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot }),
    (e) => e instanceof WorkspaceError && e.code === 'BRANCH_COLLISION',
  );
});

test('different rootTaskId, same principal+repo -> separate workspace, own branch', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();

  const a = spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot });
  const b = spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'fix-other-bug', workspaceRoot, mirrorsRoot });

  assert.notEqual(a.codePath, b.codePath);
  assert.notEqual(a.branch, b.branch);
});

test('status/release round-trip through the same task fields', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();
  const opts = { principal: 'vova', repositoryUrl, rootTaskId: 'fix-forum-topics', workspaceRoot, mirrorsRoot };

  const spawned = spawnWorkspaceForTask(opts);
  const status = statusWorkspaceForTask(opts);
  assert.equal(status.status, 'code_ready');
  assert.equal(status.codePath, spawned.codePath);

  const released = releaseWorkspaceForTask({ ...opts, processesStopped: true });
  assert.equal(released.status, 'released');
  assert.equal(fs.existsSync(spawned.codePath), false);
});

test('missing principal/repositoryUrl/rootTaskId fails explicitly', () => {
  assert.throws(() => spawnWorkspaceForTask({ repositoryUrl: 'x', rootTaskId: 'y' }), WorkspaceError);
  assert.throws(() => spawnWorkspaceForTask({ principal: 'vova', rootTaskId: 'y' }), WorkspaceError);
  assert.throws(() => spawnWorkspaceForTask({ principal: 'vova', repositoryUrl: 'x' }), WorkspaceError);
});

// Operation records used to be stored under the bare idempotency key, which
// for-task.js sets to rootTaskId. One plan that touches two repositories — the
// normal case, e.g. a card with an anchor repo and a consumer repo — therefore
// had the second repository compare its fingerprint against the first
// repository's operation record and fail with "idempotency key was already
// used with incompatible arguments". That is what stopped plan c4c5b145
// (card Z01 of the architecture epic) on 2026-10-01: the pr-autofix workspace
// held the plan's key, so playbooks and trained-agent-architecture could not be
// spawned at all. One task label must be usable in every repository of the
// plan, and still reuse its own workspace on a resume.
test('one rootTaskId holds a workspace in several repositories of the same plan', () => {
  const anchorRepo = makeRemote();
  const consumerRepo = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();
  const opts = { principal: 'vova', rootTaskId: 'plan-c4c5b145', workspaceRoot, mirrorsRoot };

  const anchor = spawnWorkspaceForTask({ ...opts, repositoryUrl: anchorRepo });
  const consumer = spawnWorkspaceForTask({ ...opts, repositoryUrl: consumerRepo });

  assert.equal(anchor.status, 'code_ready');
  assert.equal(consumer.status, 'code_ready');
  assert.notEqual(anchor.workspaceId, consumer.workspaceId);
  assert.notEqual(anchor.codePath, consumer.codePath);
  assert.ok(fs.existsSync(path.join(consumer.codePath, 'README.md')));

  // Each repository keeps its own resumable workspace.
  assert.equal(spawnWorkspaceForTask({ ...opts, repositoryUrl: anchorRepo }).workspaceId, anchor.workspaceId);
  assert.equal(spawnWorkspaceForTask({ ...opts, repositoryUrl: consumerRepo }).workspaceId, consumer.workspaceId);
});

test('one rootTaskId is not shared between principals', () => {
  const repositoryUrl = makeRemote();
  const { workspaceRoot, mirrorsRoot } = env();

  const mine = spawnWorkspaceForTask({ principal: 'vova', repositoryUrl, rootTaskId: 'plan-c4c5b145', workspaceRoot, mirrorsRoot });
  const other = spawnWorkspaceForTask({ principal: 'petr', repositoryUrl, rootTaskId: 'plan-c4c5b145', workspaceRoot, mirrorsRoot });

  assert.equal(mine.status, 'code_ready');
  assert.equal(other.status, 'code_ready');
  assert.notEqual(mine.workspaceId, other.workspaceId);
  assert.notEqual(mine.branch, other.branch);
});

// The protection the scoping above must not weaken: one idempotency key reused
// for a different task in the same repository is still a caller bug.
test('reusing one operation key for a different task in the same repository still conflicts', () => {
  const { spawnWorkspace } = require('../src/workspace/workspace');
  const source = makeSourceRepo();
  const root = tmp('eng-ws-');
  const binding = {
    workspaceRoot: root,
    sourceCheckout: source.dir,
    principal: 'vova',
    hostId: 'test-host',
    repositoryId: 'acme/app',
    baseRevision: runGit(source.dir, ['rev-parse', 'HEAD']).trim(),
    rootTaskId: 'task-a',
    idempotencyKey: 'op-1',
    allowFetch: false,
  };

  spawnWorkspace(binding);
  assert.throws(
    () => spawnWorkspace({ ...binding, rootTaskId: 'task-b' }),
    (error) => error instanceof WorkspaceError && error.code === 'CONFLICT',
  );
});

function makeSourceRepo() {
  const dir = tmp('eng-source-');
  runGit(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# source\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['commit', '-qm', 'initial']);
  return { dir };
}
