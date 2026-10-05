'use strict';

// Developer skill — git clone → local edit → test → commit → PR workflow
// Requires GitHub token (scope: repo) from 60-github.js / agent-tokens/{userId}/github.
// Moved here from trained-assist-agent core (#1631). Task formulation (clarifying
// requirements, writing a durable spec) is a separate business/systems-analyst concern —
// see trained-assist-agent 62-business-analyst.js (ba_clarify_requirements,
// ba_write_spec). This skill only covers repo/workspace mechanics (clone, deps, PR creation
// happens via github_create_pr). Tracking a PR through to deploy is a separate ci-cd concern
// — see 63-ci-cd.js (cicd_track_pr).
//
// Workflow:
//   1. ba_clarify_requirements / ba_write_spec (62-business-analyst.js) — before any of this
//   2. engineering_spawn_workspace (20-workspace.js) — spawn an isolated per-task git worktree
//      via this repo's workspace library, set git identity, install hooks, detect deps
//   3. Claude edits files with native Read/Edit/Write tools
//   4. Claude runs tests via bash (npm test, pytest, etc.)
//   5. Claude commits + pushes via bash; creates PR via github_create_pr
//   6. cicd_track_pr (63-ci-cd.js) — hand PR off to the durable GTD controller (CI → merge → deploy)

const fs   = require('fs');
const path = require('path');
const { readTokenValue } = require('../../token-value');
const { spawnSync } = require('child_process');
const { spawnWorkspaceForTask } = require('../../workspace');
const { tokensRoot } = require('../../data-paths');
// Credential store (trained-assist-agent#1939): legacy plaintext passes through,
// an encrypted `github` file is decrypted — a raw readFileSync would hand back
// base64 garbage once CRED_ENCRYPTION_KEY is provisioned.
const { readCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';

function tokenPath() {
  return path.join(tokensRoot(), USER_ID, 'github');
}

function getToken() {
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) return tok;
  if (USER_ID) {
    try {
      const p = tokenPath();
      if (fs.existsSync(p)) return readTokenValue(readCredentialFile(p));
    } catch (e) {
      // Encrypted file without CRED_ENCRYPTION_KEY (or an unreadable one):
      // never fall back to the base64 stub — degrade to "no token", loudly.
      if (e && e.code !== 'ENOENT') console.warn('[dev] cannot read the token file: %s', e.message);
    }
  }
  throw new Error('GitHub токен не подключён. Вызови connect({ service: "github" }) чтобы получить ссылку для ввода токена.');
}

const GH_API = 'https://api.github.com';
async function ghFetch(path, opts = {}) {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${GH_API}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trained-assist-agent',
      ...opts.headers,
    },
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || res.statusText;
    const detail = err.errors ? ` (${err.errors.map(e => e.message).join('; ')})` : '';
    throw new Error(`GitHub API ${res.status}: ${msg}${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Same hooks trained-assist-agent's own repos use (its .githooks/, copied to
// templates/githooks/ here) — installed into every workspace engineering_spawn_workspace
// touches so branch-per-session is enforced there too.
const HOOKS_TEMPLATE_DIR = path.join(__dirname, '..', '..', '..', 'templates', 'githooks');

function installGitHooks(wsPath) {
  const hooksDir = path.join(wsPath, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) return false;
  let installed = false;
  for (const name of ['pre-commit', 'pre-push']) {
    const src = path.join(HOOKS_TEMPLATE_DIR, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(hooksDir, name));
    fs.chmodSync(path.join(hooksDir, name), 0o755);
    installed = true;
  }
  return installed;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 60_000,
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
  });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    const stdout = result.stdout?.trim() || '';
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${stderr || stdout}`);
  }
  return (result.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// Isolated per-task workspaces (trained-assist-agent#1418, D1)
//
// `engineering_spawn_workspace` never clones into one shared per-VM tree: it calls
// `spawnWorkspaceForTask` (src/workspace), which forks an isolated git worktree +
// branch (`eng/<principal>-<rootTaskId>`) off a per-repository mirror. One
// workspace per (principal, repository, rootTaskId) — two tasks never share a
// tree or branch.
// ---------------------------------------------------------------------------

// `owner/repo` → clone URL; a full git URL or local path is passed through as-is
// (lets tests and on-VM local mirrors work without a GitHub round-trip).
function repositoryUrlOf(repo) {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|\/)/i.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

// The engineering library clones with whatever git credentials the process has.
// Rather than embedding the token in a persisted remote URL (the leak #1418
// removes), inject it for the duration of the synchronous spawn as an ephemeral
// git credential helper: token stays in env, never on disk. Reset the helper
// list first so an inherited global helper cannot shadow this profile's token.
const GIT_TOKEN_HELPER = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$AGENT_GIT_TOKEN"; }; f';

function withGitCredentials(token, fn) {
  if (!token) return fn();
  const overrides = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: GIT_TOKEN_HELPER,
    AGENT_GIT_TOKEN: token,
  };
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function spawnTaskWorkspace({ repositoryUrl, rootTaskId, ref, token }) {
  // No pre-check on USER_ID: spawnWorkspaceForTask owns that validation and raises the typed
  // INVALID_BINDING error. A generic throw here would mask it (the tool-call layer relies on it).
  // Read USER_ID at call time, not from the module constant: callers and tests set it per call,
  // and "env wins over a smuggled principal argument" is the contract.
  return withGitCredentials(token, () => spawnWorkspaceForTask({
    principal: process.env.USER_ID || '',
    repositoryUrl,
    rootTaskId,
    ref,
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
    mirrorsRoot: process.env.ENGINEERING_MIRRORS_ROOT || undefined,
  }));
}

function prepareWorkspace(codePath) {
  run('git', ['config', 'user.email', 'agent@recruiter-assistant.ru'], { cwd: codePath });
  run('git', ['config', 'user.name', 'AI Agent'], { cwd: codePath });
  // Useful on its own (not part of the isolation fix) — kept from the old flow.
  installGitHooks(codePath);
}

function detectDependencies(wsPath) {
  let deps = 'none';
  const depsLog = [];
  if (fs.existsSync(path.join(wsPath, 'package.json'))) {
    const pkgManager = fs.existsSync(path.join(wsPath, 'yarn.lock')) ? 'yarn' :
                       fs.existsSync(path.join(wsPath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    try {
      run(pkgManager, pkgManager === 'npm' ? ['ci', '--prefer-offline'] : ['install'], { cwd: wsPath, timeout: 180_000 });
      deps = pkgManager;
      depsLog.push(`${pkgManager} install OK`);
    } catch (e) {
      depsLog.push(`${pkgManager} install failed: ${e.message}`);
    }
  } else if (fs.existsSync(path.join(wsPath, 'requirements.txt'))) {
    try {
      run('pip', ['install', '-r', 'requirements.txt', '-q'], { cwd: wsPath, timeout: 180_000 });
      deps = 'pip';
      depsLog.push('pip install OK');
    } catch (e) {
      depsLog.push(`pip install failed: ${e.message}`);
    }
  } else if (fs.existsSync(path.join(wsPath, 'Cargo.toml'))) {
    deps = 'cargo';
    depsLog.push('Cargo project detected — run `cargo build` when ready');
  }
  return { deps, depsLog };
}

module.exports = {
  // Shared GitHub plumbing — the registry only reads `.tools`/`.isReady`/
  // `.setupTools`, so extra exports here are inert (same as 60-github.js).
  getToken,
  // Workspace mechanics shared with 20-workspace.js's engineering_spawn_workspace,
  // which is the single "create a workspace" tool. They live here because
  // dev_new_repo/dev_supersede_pr need them too.
  spawnTaskWorkspace,
  prepareWorkspace,
  detectDependencies,
  isReady: () => {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (!USER_ID) return false;
    return fs.existsSync(tokenPath());
  },
  setupTools: [],

  tools: {

    dev_new_repo: {
      description: 'Create a new GitHub repository, then prepare an isolated per-task workspace for it. Use when the user wants to start a project from scratch and doesn\'t have an existing repo.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Repository name (lowercase, hyphens ok)' },
          description: { type: 'string', description: 'Short repo description' },
          private: { type: 'boolean', description: 'Private repo (default true)' },
          org: { type: 'string', description: 'Create under this org instead of personal account' },
        },
      },
      handler: async ({ name, description, private: isPrivate = true, org }) => {
        const token = getToken();

        // Create via GitHub API
        const apiBase = 'https://api.github.com';
        const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';
        const body = JSON.stringify({
          name,
          description,
          private: isPrivate,
          auto_init: true,
          gitignore_template: 'Node',
        });

        const res = await fetch(`${apiBase}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'trained-assist-agent',
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`GitHub API ${res.status}: ${err.message || res.statusText}`);
        }
        const repoData = await res.json();
        const fullName = repoData.full_name;

        // Fork an isolated per-task workspace off the freshly created repo
        const result = spawnTaskWorkspace({
          repositoryUrl: `https://github.com/${fullName}.git`,
          rootTaskId: name,
          token,
        });
        const workspace = result.codePath;
        prepareWorkspace(workspace);

        return {
          repo: fullName,
          url: repoData.html_url,
          workspace,
          codePath: workspace,
          workspaceId: result.workspaceId,
          branch: result.branch,
          status: 'created',
          next_steps: [
            `cd ${workspace}`,
            '# ... add files, write code ...',
            'git add . && git commit -m "feat: initial implementation"',
            `git push -u origin ${result.branch}`,
            '# Then call github_create_pr',
          ],
        };
      },
    },

    dev_supersede_pr: {
      description: 'Supersede an open PR per the immutable-PR protocol (trained-assist-engineering#27): the replacement PR #M must already be open; then comment "Superseded by #M" on the old PR, add the `superseded` label, and close it. Optionally appends "attempt K → #M" as a comment on the tracking issue #T. Idempotent — skips without re-commenting/re-closing if the PR is already closed/merged or already carries the `superseded` label. GitHub stays the single source of truth. Call github_pr_checks first to confirm the old PR is actually broken before superseding.',
      inputSchema: {
        type: 'object',
        required: ['repo', 'pr_number', 'new_pr_number'],
        properties: {
          repo: { type: 'string', description: 'owner/repo' },
          pr_number: { type: 'number', description: 'Old PR number to supersede' },
          new_pr_number: { type: 'number', description: 'Replacement PR number that is already open' },
          issue_number: { type: 'number', description: 'Optional: tracking issue #T — appends "attempt K → #M" log line' },
          attempt: { type: 'string', description: 'Optional attempt id (e.g. "3") used in the issue log line' },
        },
      },
      handler: async ({ repo, pr_number, new_pr_number, issue_number, attempt }) => {
        if (!repo || !pr_number || !new_pr_number) throw new Error('repo, pr_number and new_pr_number are required');
        const pr = await ghFetch(`/repos/${repo}/pulls/${pr_number}`);
        if (pr.state !== 'open') {
          return { status: 'skipped', reason: `PR #${pr_number} is already ${pr.state}`, url: pr.html_url };
        }
        if ((pr.labels || []).some(l => l.name === 'superseded')) {
          return { status: 'skipped', reason: `PR #${pr_number} already carries the superseded label`, url: pr.html_url };
        }
        await ghFetch(`/repos/${repo}/issues/${pr_number}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: `Superseded by #${new_pr_number} — closing in favour of the new PR.` }),
        });
        try {
          await ghFetch(`/repos/${repo}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'superseded', color: 'ededed', description: 'This PR is superseded by a newer one' }),
          });
        } catch (e) {
          if (!/422|already taken|already exists/i.test(String(e.message))) throw e; // 422 = label exists — fine
        }
        await ghFetch(`/repos/${repo}/issues/${pr_number}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels: ['superseded'] }),
        });
        await ghFetch(`/repos/${repo}/pulls/${pr_number}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'closed' }),
        });
        let issue_log = null;
        if (issue_number) {
          const line = `attempt ${attempt || '?'} → PR #${new_pr_number}`;
          await ghFetch(`/repos/${repo}/issues/${issue_number}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: line }),
          });
          issue_log = { issue: issue_number, comment: line };
        }
        return { status: 'superseded', pr: pr_number, new_pr: new_pr_number, url: pr.html_url, issue_log };
      },
    },

  },
};
