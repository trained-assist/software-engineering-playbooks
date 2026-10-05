'use strict';

// engineering_spawn_workspace forks an isolated worktree per (profile, repo, task)
// through this repo's own workspace library, then prepares it (git identity, hooks,
// deps). Runs against a local bare remote. dev_workspace_setup was the same mechanic
// and was folded in (#124).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ws-')));
const saved = { ...process.env };
process.env.USER_ID = 'tester';
process.env.GH_TOKEN = 'test-token';
delete process.env.GITHUB_TOKEN;
process.env.ENGINEERING_WORKSPACE_ROOT = path.join(root, 'workspaces');
process.env.ENGINEERING_MIRRORS_ROOT = path.join(root, 'mirrors');
const tools = require('../src/mcp-skills/tools/20-workspace.js');
const spawn = tools.find(t => t.name === 'engineering_spawn_workspace');

test.after(() => {
  for (const key of ['USER_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'ENGINEERING_WORKSPACE_ROOT', 'ENGINEERING_MIRRORS_ROOT']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRemote(name) {
  const bare = path.join(root, name);
  fs.mkdirSync(bare);
  git(bare, ['init', '--bare', '-q', '-b', 'main']);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  git(work, ['clone', '-q', bare, '.']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-qm', 'init']);
  git(work, ['push', '-q', 'origin', 'HEAD:main']);
  return bare;
}

test('two task labels on one repo get two separate worktrees and branches', async () => {
  const remote = makeRemote('two-tasks');
  const a = await spawn.handler({ repository_url: remote, root_task_id: 'task-one' });
  const b = await spawn.handler({ repository_url: remote, root_task_id: 'task-two' });

  assert.equal(a.status, 'code_ready');
  assert.equal(a.workspace, a.codePath);
  assert.ok(a.codePath.startsWith(root));
  assert.notEqual(a.codePath, b.codePath);
  assert.equal(a.branch, 'eng/tester-task-one');
  assert.equal(b.branch, 'eng/tester-task-two');
  assert.equal(git(a.codePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'eng/tester-task-one');
  assert.equal(git(b.codePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'eng/tester-task-two');
});

test('root_task_id is required — no implicit label from the repo name', async () => {
  const remote = makeRemote('label-required');
  await assert.rejects(() => spawn.handler({ repository_url: remote }), /rootTaskId|root_task_id/);
});

test('the GitHub token is never persisted and the credential env is restored', async () => {
  const remote = makeRemote('no-token-on-disk');
  await spawn.handler({ repository_url: remote, root_task_id: 'token-check' });

  assert.equal(process.env.AGENT_GIT_TOKEN, undefined);
  assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
  const mirrors = fs.readdirSync(process.env.ENGINEERING_MIRRORS_ROOT);
  for (const m of mirrors) {
    const config = fs.readFileSync(path.join(process.env.ENGINEERING_MIRRORS_ROOT, m, '.git', 'config'), 'utf8');
    assert.ok(!config.includes('test-token'), `token leaked into ${m}/.git/config`);
  }
});

test('the shared-directory dev_workspace_list tool stays removed', () => {
  assert.equal(tools.find(t => t.name === 'dev_workspace_list'), undefined);
});
