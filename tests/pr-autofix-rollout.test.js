'use strict';

// Issue #95 — the one-command rollout. Driven by an in-memory GitHub capability so
// nothing here touches the network. Covers: the plan/execute split (`--dry-run` writes
// nothing), registration not being a hidden prerequisite, the known-good ref default,
// the defective-window refusal, CI workflow name detection, the no-CI skip, the
// self-repo skip, and the already-installed no-op.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerAutofix,
  setGithubCapabilityFactory,
  rolloutAutofix,
  detectCiWorkflow,
  workflowNameFromContent,
  normalizeRepoList,
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  PrAutofixError,
} = require('../src/pr-autofix');

const cleanup = [];
const savedEnv = {};
for (const key of ['USER_ID', 'ENGINEERING_PR_AUTOFIX_ROOT', 'ENGINEERING_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
  savedEnv[key] = process.env[key];
}

test.after(() => {
  setGithubCapabilityFactory(null);
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

// A small org: each repository has a default branch and a set of workflow files.
// `files` maps a path to its content; workflow paths are exposed both through the
// directory listing and through the per-file read, exactly as the real API does.
function makeOrg({ repos = {} } = {}) {
  const state = {
    repos,
    pulls: [],
    prSeq: 0,
    shaSeq: 0,
    calls: [],
  };

  const workflowsOf = (repo) => Object.keys(repos[repo].files)
    .filter((p) => p.startsWith('.github/workflows/'))
    .sort();
  const contentOf = (repo, filePath) => {
    const value = repos[repo].files[filePath];
    return value === undefined ? null : value;
  };

  async function ghFetch(method, endpoint, body) {
    const upper = String(method || 'GET').toUpperCase();
    state.calls.push({ method: upper, endpoint });
    const url = new URL(endpoint, 'https://api.github.com');
    const route = url.pathname;
    const q = url.searchParams;
    let m;

    if (upper === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(route)) {
      const repo = route.slice('/repos/'.length);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { default_branch: repos[repo].default_branch } };
    }

    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const filePath = decodeURIComponent(m[3]);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      if (filePath === '.github/workflows') {
        return {
          status: 200,
          ok: true,
          data: workflowsOf(repo).map((p) => ({ name: p.split('/').pop(), type: 'file' })),
        };
      }
      const content = contentOf(repo, filePath);
      if (content === null) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { content: b64(content), sha: `blob:${filePath}` } };
    }

    if ((m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/))) {
      const repo = `${m[1]}/${m[2]}`;
      const branch = decodeURIComponent(m[3]);
      if (!repos[repo]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      if (!repos[repo].refs[branch]) return { status: 404, ok: false, data: { message: 'Not Found' } };
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
      const m2 = route.match(/^\/repos\/([^/]+)\/([^/]+)\//);
      const repo = `${m2[1]}/${m2[2]}`;
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
      const current = contentOf(repo, filePath);
      if (current !== null && current !== undefined && !body.sha) {
        return { status: 422, ok: false, data: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
      }
      const sha = `sha${++state.shaSeq}`;
      repos[repo].snapshots[sha] = { ...repos[repo].snapshots[repos[repo].refs[branch]], [filePath]: Buffer.from(body.content, 'base64').toString('utf8') };
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
      const m2 = route.match(/^\/repos\/([^/]+)\/([^/]+)\//);
      const repo = `${m2[1]}/${m2[2]}`;
      const number = ++state.prSeq;
      const owner = repo.split('/')[0];
      const pr = {
        number,
        html_url: `https://github.com/${repo}/pull/${number}`,
        state: 'open',
        title: body.title,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
        user: { login: owner },
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

function repoFixture({ defaultBranch = 'main', workflows = {} } = {}) {
  const files = {};
  for (const [name, content] of Object.entries(workflows)) files[`.github/workflows/${name}`] = content;
  return {
    default_branch: defaultBranch,
    files,
    refs: { [defaultBranch]: 'sha0' },
    snapshots: { sha0: { ...files } },
  };
}

const CI_WORKFLOW = 'name: CI\non:\n  pull_request:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n';

// --- Detection ----------------------------------------------------------------

test('workflowNameFromContent reads only the top-level name', () => {
  assert.equal(workflowNameFromContent('name: CI\non:\n  pull_request:\n'), 'CI');
  assert.equal(workflowNameFromContent('name: "CI + Deploy"\n'), 'CI + Deploy');
  assert.equal(workflowNameFromContent('on:\n  pull_request:\njobs:\n  ci:\n    name: CI\n'), null);
  assert.equal(workflowNameFromContent(''), null);
});

test('detectCiWorkflow finds the workflow whose name matches, not the first file', async () => {
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: {
          'aaa-first.yml': 'name: Release\non:\n  push:\n',
          'ci.yml': CI_WORKFLOW,
        },
      }),
    },
  });
  const found = await detectCiWorkflow(org.github, 'trained-assist/demo', 'CI');
  assert.equal(found.name, 'CI');
  assert.equal(found.file, 'ci.yml');
});

test('detectCiWorkflow returns null when no workflow carries the name', async () => {
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'release.yml': 'name: Release\non:\n' } }) },
  });
  assert.equal(await detectCiWorkflow(org.github, 'trained-assist/demo', 'CI'), null);
});

test('detectCiWorkflow falls back to a pull-request workflow when the preferred name is absent', async () => {
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: {
          'release.yml': 'name: Release\non:\n  push:\n',
          'ci.yml': 'name: CI + Deploy\non:\n  pull_request:\n',
        },
      }),
    },
  });
  const found = await detectCiWorkflow(org.github, 'trained-assist/demo', {});
  assert.equal(found.name, 'CI + Deploy');
  assert.equal(found.file, 'ci.yml');
  assert.equal(found.matched, 'fallback');
});

test('detectCiWorkflow returns null when nothing runs on pull requests', async () => {
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'release.yml': 'name: Release\non:\n  push:\n' } }) },
  });
  assert.equal(await detectCiWorkflow(org.github, 'trained-assist/demo', {}), null);
});

test('an explicit ci_workflow_name is never silently replaced by the fallback', async () => {
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': 'name: CI + Deploy\non:\n  pull_request:\n' } }) },
  });
  assert.equal(await detectCiWorkflow(org.github, 'trained-assist/demo', { preferred: 'CI' }), null);
});

test('normalizeRepoList deduplicates, sorts and rejects a malformed entry', () => {
  assert.deepEqual(normalizeRepoList(['b/x', 'a/y', 'b/x', '  ']), ['a/y', 'b/x']);
  assert.throws(() => normalizeRepoList(['not-a-repo']), PrAutofixError);
  assert.throws(() => normalizeRepoList([]), PrAutofixError);
});

// --- Rollout ------------------------------------------------------------------

test('the rollout default ref is the org-known-good v1.7.8, not the installer default', () => {
  assert.equal(ROLLOUT_DEFAULT_AUTOFIX_REF, 'v1.7.8');
});

test('a dry run plans every repository and writes nothing', async () => {
  const root = tmp('rollout-dry-');
  const org = makeOrg({
    repos: {
      'trained-assist/has-ci': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }),
      'trained-assist/no-ci': repoFixture({ workflows: { 'release.yml': 'name: Release\non:\n' } }),
      'trained-assist/pr-autofix': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }),
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
  assert.equal(byRepo['trained-assist/has-ci'].ciMatched, 'exact');
  assert.equal(byRepo['trained-assist/no-ci'].reason, 'no_ci_workflow');
  assert.equal(byRepo['trained-assist/pr-autofix'].reason, 'self');
  assert.equal(org.writesSince(before).length, 0);
});

test('the live rollout registers a missing repository and opens exactly one PR', async () => {
  const root = tmp('rollout-live-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    github: org.github,
  });

  assert.equal(result.summary.pr_opened, 1);
  const row = result.report[0];
  assert.equal(row.status, 'pr_opened');
  assert.equal(row.ciName, 'CI');
  assert.equal(row.baseBranch, 'main');
  assert.ok(row.pr && row.pr.url.includes('/pull/1'));

  // R-17: registration is not a hidden prerequisite — the rollout created it.
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'tester.json'), 'utf8'));
  const record = stored.registrations.find((entry) => entry.repo === 'trained-assist/demo');
  assert.equal(record.autofix_ref, 'v1.7.8');
  assert.equal(record.ci_workflow_name, 'CI');
  assert.equal(record.base_branch, 'main');
  assert.equal(record.status, 'workflow_installed');
  assert.equal(record.installed_workflow.pinned_ref, 'v1.7.8');

  // The install PR carries both workflow files, pinned.
  const pr = org.state.pulls[0];
  assert.match(pr.title, /install pr-autofix workflow \(v1\.7\.8\)/);
  const written = org.state.calls.filter((call) => call.method === 'PUT');
  const paths = written.map((call) => new URL(call.endpoint, 'https://x').pathname.split('/').pop());
  assert.ok(paths.includes('pr-autofix.yml'));
  assert.ok(paths.includes('ci-fix-cleanup.yml'));
});

test('an existing registration is reused and its install state is preserved', async () => {
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
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    github: org.github,
  });

  assert.equal(result.summary.pr_opened, 1);
  // No second registration write: the rollout must not duplicate the record.
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'tester.json'), 'utf8'));
  assert.equal(stored.registrations.filter((entry) => entry.repo === 'trained-assist/demo').length, 1);
});

test('an identical pinned job already on the base branch is a no-op, not a second PR', async () => {
  const root = tmp('rollout-noop-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  // Pre-install the exact files the rollout would write.
  const { buildWorkflowFiles } = require('../src/pr-autofix/installer');
  const desired = buildWorkflowFiles({
    repo: 'trained-assist/demo',
    autofix_ref: 'v1.7.8',
    ci_workflow_name: 'CI',
    features: { fix: true, cleanup: true },
  });
  org.repos['trained-assist/demo'].files = { ...org.repos['trained-assist/demo'].files, ...desired };
  org.repos['trained-assist/demo'].snapshots.sha0 = { ...org.repos['trained-assist/demo'].files };

  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    github: org.github,
  });

  assert.equal(result.summary.installed, 1);
  assert.equal(result.report[0].reason, 'already_pinned');
  assert.equal(org.state.pulls.length, 0);
});

test('the defective v1.7.4…v1.7.7 window is refused with an explicit error', async () => {
  const root = tmp('rollout-defective-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  for (const ref of ['v1.7.4', 'v1.7.5', 'v1.7.6', 'v1.7.7']) {
    await assert.rejects(
      rolloutAutofix({ profileId: 'tester', root, repos: ['trained-assist/demo'], autofix_ref: ref, github: org.github }),
      (error) => error.code === 'DEFECTIVE_AUTOFIX_REF',
    );
  }
  assert.equal(org.state.pulls.length, 0);
});

test('a non-defective override ref is honoured', async () => {
  const root = tmp('rollout-override-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    autofix_ref: 'v1.7.9',
    github: org.github,
  });
  assert.equal(result.ref, 'v1.7.9');
  assert.equal(result.summary.pr_opened, 1);
});

test('the CI workflow name is detected from the repository, not assumed', async () => {
  const root = tmp('rollout-ciname-');
  const org = makeOrg({
    repos: {
      'trained-assist/demo': repoFixture({
        workflows: { 'ci.yml': 'name: CI + Deploy\non:\n  pull_request:\n' },
      }),
    },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    github: org.github,
  });
  assert.equal(result.report[0].ciName, 'CI + Deploy');
  assert.equal(result.report[0].ciMatched, 'fallback');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'tester.json'), 'utf8'));
  assert.equal(stored.registrations[0].ci_workflow_name, 'CI + Deploy');
});

test('an explicit ci_workflow_name wins over detection', async () => {
  const root = tmp('rollout-ciname-explicit-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    ci_workflow_name: 'Nightly CI',
    github: org.github,
  });
  assert.equal(result.report[0].ciName, 'Nightly CI');
});

test('a repository whose default branch is not main is registered with that branch', async () => {
  const root = tmp('rollout-master-');
  const org = makeOrg({
    repos: { 'trained-assist/demo': repoFixture({ defaultBranch: 'master', workflows: { 'ci.yml': CI_WORKFLOW } }) },
  });
  const result = await rolloutAutofix({
    profileId: 'tester',
    root,
    repos: ['trained-assist/demo'],
    github: org.github,
  });
  assert.equal(result.report[0].baseBranch, 'master');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'tester.json'), 'utf8'));
  assert.equal(stored.registrations[0].base_branch, 'master');
});
