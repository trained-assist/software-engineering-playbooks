'use strict';

// Issue #95 — the one-command rollout. Driven by an in-memory GitHub capability so
// nothing here touches the network. Covers: the plan/execute split (`dryRun` writes
// nothing), registration not being a hidden prerequisite, the known-good ref default,
// the defective-window refusal, the no-CI skip, the self-repo skip, the already
// installed no-op, and a non-`main` default branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerAutofix,
  rolloutAutofix,
  normalizeRepoList,
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  PrAutofixError,
} = require('../src/pr-autofix');
const { buildWorkflowFiles } = require('../src/pr-autofix/installer');

const cleanup = [];
const savedEnv = {};
for (const key of ['USER_ID', 'ENGINEERING_PR_AUTOFIX_ROOT', 'ENGINEERING_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
  savedEnv[key] = process.env[key];
}

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

// --- In-memory GitHub ---------------------------------------------------------

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const CALLABLE = 'on:\n  workflow_call:\njobs:\n  x:\n    runs-on: ubuntu-latest\n';

// Each repository has a default branch and a list of workflows as GitHub's
// `actions/workflows` endpoint reports them: `{ name, path }`. The tool repo answers
// the installer's callability preflight, so the fake serves it too.
function makeOrg({ repos = {}, callableRefs = ['v1.7.8', 'v1.7.9', 'v1.8.0'], inventory = null } = {}) {
  const state = { repos, callableRefs, inventory, pulls: [], prSeq: 0, shaSeq: 0, calls: [] };
  const repoOf = (route) => {
    const m = route.match(/^\/repos\/([^/]+)\/([^/]+)\//);
    return m ? `${m[1]}/${m[2]}` : null;
  };

  async function ghFetch(method, endpoint, body) {
    const upper = String(method || 'GET').toUpperCase();
    state.calls.push({ method: upper, endpoint });
    const url = new URL(endpoint, 'https://api.github.com');
    const route = url.pathname;
    const q = url.searchParams;
    let m;

    // The tool repo: does this ref expose the reusable workflows the install pins?
    if (upper === 'GET' && route.startsWith('/repos/trained-assist/pr-autofix/')) {
      const ref = q.get('ref') || '';
      if (state.callableRefs.includes(ref)) {
        return { status: 200, ok: true, data: { content: b64(CALLABLE), sha: `blob:${route}` } };
      }
      return { status: 404, ok: false, data: { message: 'Not Found' } };
    }

    // The org inventory the rollout reads when no repo list is passed.
    if (upper === 'GET' && route === '/repos/trained-assist/trained-agent-architecture/contents/docs/inventory/repo-coverage.json') {
      if (!state.inventory) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { content: b64(JSON.stringify(state.inventory)) } };
    }

    if (upper === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(route)) {
      const repo = route.slice('/repos/'.length);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { default_branch: repos[repo].default_branch } };
    }

    if (upper === 'GET' && (m = route.match(/^\/repos\/[^/]+\/[^/]+\/actions\/workflows$/))) {
      const repo = repoOf(route);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { workflows: repos[repo].workflows } };
    }

    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const filePath = decodeURIComponent(m[3]);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      const content = repos[repo].files[filePath];
      if (content === undefined) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { content: b64(content), sha: `blob:${filePath}` } };
    }

    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const branch = decodeURIComponent(m[3]);
      if (!repos[repo] || !repos[repo].refs[branch]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { object: { sha: repos[repo].refs[branch] } } };
    }
    if (upper === 'PATCH' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const branch = decodeURIComponent(m[3]);
      if (!repos[repo] || !repos[repo].refs[branch]) return { status: 422, ok: false, data: { message: 'Reference does not exist' } };
      repos[repo].refs[branch] = body.sha;
      return { status: 200, ok: true, data: { object: { sha: body.sha } } };
    }
    if (upper === 'POST' && /\/git\/refs$/.test(route)) {
      const repo = repoOf(route);
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      if (repos[repo].refs[branch]) return { status: 422, ok: false, data: { message: 'Reference already exists' } };
      repos[repo].refs[branch] = body.sha;
      if (!repos[repo].snapshots[body.sha]) repos[repo].snapshots[body.sha] = { ...repos[repo].files };
      return { status: 201, ok: true, data: { ref: body.ref, object: { sha: body.sha } } };
    }
    if (upper === 'PUT' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const filePath = decodeURIComponent(m[3]);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      const branch = body.branch;
      const current = repos[repo].files[filePath];
      if (current !== undefined && !body.sha) {
        return { status: 422, ok: false, data: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
      }
      const sha = `sha${++state.shaSeq}`;
      repos[repo].snapshots[sha] = {
        ...repos[repo].snapshots[repos[repo].refs[branch]],
        [filePath]: Buffer.from(body.content, 'base64').toString('utf8'),
      };
      repos[repo].refs[branch] = sha;
      return { status: 200, ok: true, data: { content: { sha }, commit: { sha } } };
    }
    if (upper === 'GET' && /\/pulls$/.test(route)) {
      const wanted = q.get('state') || 'open';
      const head = q.get('head');
      const baseQ = q.get('base');
      const items = state.pulls.filter((pr) => pr.state === wanted
        && (!head || pr.head.ref === head.split(':').pop())
        && (!baseQ || pr.base.ref === baseQ));
      return { status: 200, ok: true, data: items };
    }
    if (upper === 'POST' && /\/pulls$/.test(route)) {
      const repo = repoOf(route);
      const number = ++state.prSeq;
      const pr = {
        number,
        html_url: `https://github.com/${repo}/pull/${number}`,
        state: 'open',
        title: body.title,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
        user: { login: repo.split('/')[0] },
      };
      state.pulls.push(pr);
      return { status: 201, ok: true, data: pr };
    }
    if (upper === 'PATCH' && (m = route.match(/\/pulls\/(\d+)$/))) {
      const pr = state.pulls.find((item) => item.number === Number(m[1]));
      if (!pr) return { status: 404, ok: false, data: { message: 'Not Found' } };
      Object.assign(pr, body);
      return { status: 200, ok: true, data: pr };
    }
    return { status: 404, ok: false, data: { message: `unhandled ${upper} ${route}` } };
  }

  return {
    github: { ghToken: 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE', ghFetch },
    state,
    repos,
    writesSince(index) {
      return state.calls.slice(index).filter((call) => call.method !== 'GET');
    },
  };
}

const CI_WORKFLOW = { name: 'CI', path: '.github/workflows/ci.yml' };

// A workflow entry the rollout can read back: the `actions/workflows` listing reports
// the name and path, and the contents endpoint must serve a file that actually runs on
// pull requests — otherwise the rollout skips the repository as `ci_not_pull_request`.
function workflowFile(entry) {
  if (entry.content !== undefined) return entry.content;
  return `name: ${entry.name}\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n`;
}

function repoFixture({ defaultBranch = 'main', workflows = [CI_WORKFLOW], files = {} } = {}) {
  const materialized = { ...files };
  for (const entry of workflows) {
    const path = entry.path || '.github/workflows/ci.yml';
    if (materialized[path] === undefined) materialized[path] = workflowFile(entry);
  }
  return {
    default_branch: defaultBranch,
    workflows,
    files: materialized,
    refs: { [defaultBranch]: 'sha0' },
    snapshots: { sha0: { ...materialized } },
  };
}

const stored = (root) => JSON.parse(fs.readFileSync(path.join(root, 'tester.json'), 'utf8'));

// --- Helpers ------------------------------------------------------------------

test('the rollout default ref is the org-known-good v1.7.8', () => {
  assert.equal(ROLLOUT_DEFAULT_AUTOFIX_REF, 'v1.7.8');
});

test('normalizeRepoList deduplicates, sorts and rejects a malformed entry', () => {
  assert.deepEqual(normalizeRepoList(['b/x', 'a/y', 'b/x', '  ']), ['a/y', 'b/x']);
  assert.throws(() => normalizeRepoList(['not-a-repo']), PrAutofixError);
  assert.throws(() => normalizeRepoList([]), PrAutofixError);
});

// --- Dry run ------------------------------------------------------------------

test('a dry run plans every repository and writes nothing', async () => {
  const root = tmp('rollout-dry-');
  const org = makeOrg({
    repos: {
      'trained-assist/has-ci': repoFixture(),
      'trained-assist/no-ci': repoFixture({
        workflows: [{ name: 'Release', path: '.github/workflows/release.yml' }],
        files: { '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: ["v*"]\n' },
      }),
      'trained-assist/pr-autofix': repoFixture(),
    },
  });
  const before = org.state.calls.length;
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/has-ci', 'trained-assist/no-ci', 'trained-assist/pr-autofix'],
    github: org.github,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.ref, 'v1.7.8');
  assert.deepEqual(result.summary, { total: 3, pr_opened: 1, installed: 0, skipped: 2 });
  const byRepo = Object.fromEntries(result.report.map((row) => [row.repo, row]));
  assert.equal(byRepo['trained-assist/has-ci'].status, 'pr_opened');
  assert.equal(byRepo['trained-assist/has-ci'].ciName, 'CI');
  assert.equal(byRepo['trained-assist/no-ci'].reason, 'no_ci_workflow');
  assert.equal(byRepo['trained-assist/pr-autofix'].reason, 'self');
  assert.equal(org.writesSince(before).length, 0, 'a dry run performs no write at all');
  assert.equal(fs.existsSync(path.join(root, 'tester.json')), false, 'a dry run does not register anything');
});

// --- Live rollout -------------------------------------------------------------

test('the live rollout registers a missing repository and opens exactly one PR', async () => {
  const root = tmp('rollout-live-');
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture() } });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });

  assert.equal(result.summary.pr_opened, 1);
  const row = result.report[0];
  assert.equal(row.status, 'pr_opened');
  assert.equal(row.ciName, 'CI');
  assert.equal(row.baseBranch, 'main');
  assert.ok(row.pr && row.pr.url.includes('/pull/1'));

  // R-17: registration is not a hidden prerequisite — the rollout created it.
  const record = stored(root).registrations.find((entry) => entry.repo === 'trained-assist/demo');
  assert.equal(record.autofix_ref, 'v1.7.8');
  assert.equal(record.ci_workflow_name, 'CI');
  assert.equal(record.base_branch, 'main');
  assert.equal(record.status, 'workflow_installed');
  assert.equal(record.installed_workflow.pinned_ref, 'v1.7.8');

  assert.match(org.state.pulls[0].title, /install pr-autofix workflow \(v1\.7\.8\)/);
  const paths = org.state.calls
    .filter((call) => call.method === 'PUT')
    .map((call) => new URL(call.endpoint, 'https://x').pathname.split('/').pop());
  assert.ok(paths.includes('pr-autofix.yml'));
  assert.ok(paths.includes('ci-fix-cleanup.yml'));
});

test('an existing registration is reused and not duplicated', async () => {
  const root = tmp('rollout-reuse-');
  registerAutofix({
    profileId: 'tester',
    root,
    registration: {
      repo: 'trained-assist/demo',
      base_branch: 'main',
      autofix_ref: 'v1.7.8',
      ci_workflow_name: 'CI',
      features: { fix: true, cleanup: true },
    },
  });
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture() } });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });

  assert.equal(result.summary.pr_opened, 1);
  assert.equal(stored(root).registrations.filter((entry) => entry.repo === 'trained-assist/demo').length, 1);
});

test('an identical pinned job already on the base branch is a no-op, not a second PR', async () => {
  const root = tmp('rollout-noop-');
  const desired = buildWorkflowFiles({
    repo: 'trained-assist/demo',
    autofix_ref: 'v1.7.8',
    ci_workflow_name: 'CI',
    features: { fix: true, cleanup: true },
  });
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture({ files: desired }) } });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });

  assert.equal(result.summary.installed, 1);
  assert.equal(result.report[0].reason, 'already_pinned');
  assert.equal(org.state.pulls.length, 0);
});

test('the defective v1.7.4…v1.7.7 window is refused with an explicit error', async () => {
  const root = tmp('rollout-defective-');
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture() } });
  for (const ref of ['v1.7.4', 'v1.7.5', 'v1.7.6', 'v1.7.7']) {
    await assert.rejects(
      rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], autofix_ref: ref, github: org.github }),
      (error) => error.code === 'DEFECTIVE_AUTOFIX_REF' && /v1\.7\.8/.test(error.message),
    );
  }
  assert.equal(org.state.pulls.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'tester.json')), false);
});

test('a non-defective override ref is honoured', async () => {
  const root = tmp('rollout-override-');
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture() } });
  const result = await rolloutAutofix({
    profileId: 'tester', root, repos: ['trained-assist/demo'], autofix_ref: 'v1.7.9', github: org.github,
  });
  assert.equal(result.ref, 'v1.7.9');
  assert.equal(result.summary.pr_opened, 1);
});

test('the watched CI workflow name comes from the repository, not a guess', async () => {
  const root = tmp('rollout-ciname-');
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: [
          { name: 'Release', path: '.github/workflows/release.yml' },
          { name: 'CI + Deploy', path: '.github/workflows/ci.yml' },
        ],
      }),
    },
  });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });
  assert.equal(result.report[0].ciName, 'CI + Deploy');
  assert.equal(stored(root).registrations[0].ci_workflow_name, 'CI + Deploy');
});

test('an explicit ci_workflow_name wins over detection', async () => {
  const root = tmp('rollout-ciname-explicit-');
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture() } });
  const result = await rolloutAutofix({
    profileId: 'tester', root, repos: ['trained-assist/demo'], ci_workflow_name: 'Nightly CI', github: org.github,
  });
  assert.equal(result.report[0].ciName, 'Nightly CI');
});

test('a repository whose only workflow ignores pull requests is skipped, not mis-wired', async () => {
  const root = tmp('rollout-tagonly-');
  const org = makeOrg({
    repos: {
      // "Build & Release" reads as CI to a name heuristic, but it only fires on tags.
      'trained-assist/demo': repoFixture({
        workflows: [{ name: 'Build & Release', path: '.github/workflows/release.yml' }],
        files: { '.github/workflows/release.yml': 'name: Build & Release\non:\n  push:\n    tags: ["v*"]\n' },
      }),
    },
  });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.report[0].reason, 'no_ci_workflow');
  assert.equal(org.state.pulls.length, 0);
});

test('an explicit --ci-workflow that ignores pull requests is refused', async () => {
  const root = tmp('rollout-explicit-tagonly-');
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: [{ name: 'Build & Release', path: '.github/workflows/release.yml' }],
        files: { '.github/workflows/release.yml': 'name: Build & Release\non:\n  push:\n    tags: ["v*"]\n' },
      }),
    },
  });
  const result = await rolloutAutofix({
    profileId: 'tester', root, repos: ['trained-assist/demo'], ci_workflow_name: 'Build & Release', github: org.github,
  });
  assert.equal(result.report[0].reason, 'ci_not_pull_request');
  assert.equal(org.state.pulls.length, 0);
});

test('the CI ranking prefers the real CI over a cleanup job that also runs on PRs', async () => {
  const root = tmp('rollout-rank-');
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: [
          { name: 'CI-Fix Cleanup', path: '.github/workflows/ci-fix-cleanup.yml' },
          { name: 'CI + Deploy', path: '.github/workflows/ci.yml' },
        ],
        files: {
          '.github/workflows/ci-fix-cleanup.yml': 'name: CI-Fix Cleanup\non:\n  pull_request:\n    types: [closed]\n',
          '.github/workflows/ci.yml': 'name: CI + Deploy\non:\n  pull_request:\n',
        },
      }),
    },
  });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });
  assert.equal(result.report[0].ciName, 'CI + Deploy');
  assert.equal(result.report[0].ciPath, '.github/workflows/ci.yml');
});

test('a stale nameless listing entry does not win over the real CI', async () => {
  const root = tmp('rollout-stale-');
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: [
          // GitHub reports `name` as the path for a workflow with no `name:` field.
          { name: '.github/workflows/auto-fix-ci.yml', path: '.github/workflows/auto-fix-ci.yml' },
          { name: 'CI + Deploy', path: '.github/workflows/ci.yml' },
        ],
        files: { '.github/workflows/ci.yml': 'name: CI + Deploy\non:\n  pull_request:\n' },
      }),
    },
  });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });
  assert.equal(result.report[0].ciName, 'CI + Deploy');
});

test('a repository whose default branch is not main is registered with that branch', async () => {
  const root = tmp('rollout-master-');
  const org = makeOrg({ repos: { 'trained-assist/demo': repoFixture({ defaultBranch: 'master' }) } });
  const result = await rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], github: org.github });
  assert.equal(result.report[0].baseBranch, 'master');
  assert.equal(stored(root).registrations[0].base_branch, 'master');
});

// --- Inventory-driven ---------------------------------------------------------

test('without a repo list the rollout is driven by the org inventory', async () => {
  const root = tmp('rollout-inventory-');
  const org = makeOrg({
    repos: { 'trained-assist/a': repoFixture(), 'trained-assist/b': repoFixture({ defaultBranch: 'master' }) },
    inventory: { repos: [{ repo: 'trained-assist/b' }, { repo: 'trained-assist/a' }] },
  });
  const result = await rolloutAutofix({ profileId: 'tester', root, github: org.github, dryRun: true });
  assert.deepEqual(result.report.map((row) => row.repo), ['trained-assist/a', 'trained-assist/b']);
  assert.equal(result.summary.total, 2);
});
