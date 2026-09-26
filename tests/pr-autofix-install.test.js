'use strict';

// Slice 2a (issue #17): workflow install/update in a target repo, driven by an
// injected in-memory GitHub capability so nothing here touches the network.
// Covers: one PR with the pinned callable job, idempotent second install, ref
// bump -> update PR (open and after merge), identical job already present ->
// no PR, cleanup workflow, status reflection, and the no-secret invariant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  registerAutofix,
  statusAutofix,
  disableAutofix,
  installAutofixWorkflow,
  buildWorkflowFiles,
  recordWorkflowInstalled,
  setGithubCapabilityFactory,
  assertAutofixRef,
  registrationFile,
  PrAutofixError,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  INSTALL_BRANCH,
} = require('../src/pr-autofix');
const { DEFAULT_AUTOFIX_REF } = require('../src/pr-autofix/constants');
const { callTool } = require('../src/mcp-skills/registry');

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

function register(profileId, root, overrides = {}) {
  return registerAutofix({
    profileId,
    root,
    registration: { repo: 'trained-assist/demo', base_branch: 'main', autofix_ref: 'v1.2.1', ...overrides },
  });
}

// --- In-memory GitHub ---------------------------------------------------------

function makeFakeGithub({ base = 'main', repo = 'trained-assist/demo', files = {} } = {}) {
  const state = {
    refs: { [base]: 'sha0' },
    snapshots: { sha0: { ...files } },
    pulls: [],
    shaSeq: 0,
    prSeq: 0,
    calls: [],
  };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const snapshotOf = (branch) => state.snapshots[state.refs[branch]] || {};
  const newSha = () => `sha${++state.shaSeq}`;

  async function ghFetch(method, endpoint, body) {
    const upper = String(method || 'GET').toUpperCase();
    state.calls.push({ method: upper, endpoint });
    const url = new URL(endpoint, 'https://api.github.com');
    const route = url.pathname;
    const q = url.searchParams;
    let m;

    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[3]);
      if (!state.refs[branch]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { object: { sha: state.refs[branch] } } };
    }
    if (upper === 'PATCH' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[3]);
      if (!state.refs[branch]) return { status: 422, ok: false, data: { message: 'Reference does not exist' } };
      state.refs[branch] = body.sha;
      return { status: 200, ok: true, data: { object: { sha: body.sha } } };
    }
    if (upper === 'POST' && /\/git\/refs$/.test(route)) {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      if (state.refs[branch]) return { status: 422, ok: false, data: { message: 'Reference already exists' } };
      state.refs[branch] = body.sha;
      if (!state.snapshots[body.sha]) state.snapshots[body.sha] = {};
      return { status: 201, ok: true, data: { ref: body.ref, object: { sha: body.sha } } };
    }
    if ((m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const filePath = decodeURIComponent(m[3]);
      if (upper === 'GET') {
        const branch = q.get('ref');
        const content = snapshotOf(branch)[filePath];
        if (content === undefined) return { status: 404, ok: false, data: { message: 'Not Found' } };
        return { status: 200, ok: true, data: { content: b64(content), sha: `blob:${filePath}` } };
      }
      const branch = body.branch;
      // Real GitHub: updating an existing file without its blob sha is a 422.
      if (snapshotOf(branch)[filePath] !== undefined && !body.sha) {
        return { status: 422, ok: false, data: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
      }
      const next = { ...snapshotOf(branch) };
      next[filePath] = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = newSha();
      state.snapshots[sha] = next;
      state.refs[branch] = sha;
      return { status: 200, ok: true, data: { content: { sha }, commit: { sha } } };
    }
    if (upper === 'GET' && /\/pulls$/.test(route)) {
      const wantedState = q.get('state') || 'open';
      const head = q.get('head');
      const baseQ = q.get('base');
      const items = state.pulls.filter((pr) => pr.state === wantedState
        && (!head || pr.head.ref === head.split(':').pop())
        && (!baseQ || pr.base.ref === baseQ));
      return { status: 200, ok: true, data: items };
    }
    if (upper === 'POST' && /\/pulls$/.test(route)) {
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
    fileOn(branch, filePath) {
      return snapshotOf(branch)[filePath];
    },
    openPrs() {
      return state.pulls.filter((pr) => pr.state === 'open');
    },
    mergePr(number) {
      const pr = state.pulls.find((item) => item.number === number);
      if (!pr) throw new Error(`no PR #${number}`);
      pr.state = 'closed';
      pr.merged = true;
      state.refs[pr.base.ref] = state.refs[pr.head.ref];
    },
    writeCallsSince(index) {
      return state.calls.slice(index).filter((call) => call.method !== 'GET');
    },
  };
}

// --- Core installer -----------------------------------------------------------

test('install opens exactly one PR containing the pinned callable job', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root, { features: { fix: true, cleanup: false } });
  const fake = makeFakeGithub();

  const result = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'pr_opened');
  assert.equal(result.pinned_ref, 'v1.2.1');
  assert.equal(result.path, WORKFLOW_PATH);
  assert.equal(result.pr.number, 1);
  assert.equal(fake.state.pulls.length, 1);

  const content = fake.fileOn(INSTALL_BRANCH, WORKFLOW_PATH);
  assert.match(content, /uses: trained-assist\/pr-autofix\/\.github\/workflows\/autofix-callable\.yml@v1\.2\.1/);
  assert.match(content, /workflow_run:/);
  assert.match(content, /workflows: \["CI"\]/);
  assert.match(content, /types: \[completed\]/);
  assert.match(content, /conclusion == 'failure'/);
  assert.match(content, /!startsWith\(github\.event\.workflow_run\.head_branch, 'fix\/ci-'\)/);
  assert.equal(fake.fileOn(INSTALL_BRANCH, CLEANUP_WORKFLOW_PATH), undefined);

  const status = statusAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  const record = status.registrations[0];
  assert.equal(record.status, 'workflow_installed');
  assert.equal(record.installed_workflow.path, WORKFLOW_PATH);
  assert.equal(record.installed_workflow.pinned_ref, 'v1.2.1');
  assert.equal(record.installed_workflow.pr_url, result.pr.url);
  assert.equal(typeof record.installed_workflow.installed_at, 'string');
  assert.equal(record.autofix_ref, 'v1.2.1');
});

test('a second identical install is a no-op — no PR, no write', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  const fake = makeFakeGithub();
  const first = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  const mark = fake.state.calls.length;
  const again = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  assert.equal(again.changed, false);
  assert.equal(again.created, false);
  assert.equal(again.reason, 'pr_up_to_date');
  assert.equal(again.pr.number, first.pr.number);
  assert.equal(fake.state.pulls.length, 1);
  assert.equal(fake.writeCallsSince(mark).length, 0, 'a no-op install must not write');
});

test('bumping autofix_ref updates the open install PR in place', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  const fake = makeFakeGithub();
  await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  const bump = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', autofix_ref: 'v1.3.0', github: fake.github });

  assert.equal(bump.changed, true);
  assert.equal(bump.created, false);
  assert.equal(bump.updated, true);
  assert.equal(bump.reason, 'pr_updated');
  assert.equal(bump.pinned_ref, 'v1.3.0');
  assert.equal(fake.state.pulls.length, 1, 'still one PR');
  assert.match(fake.fileOn(INSTALL_BRANCH, WORKFLOW_PATH), /autofix-callable\.yml@v1\.3\.0/);
});

test('after the install PR is merged, bumping autofix_ref opens an update PR', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  const fake = makeFakeGithub();
  await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });
  fake.mergePr(1);
  assert.equal(fake.openPrs().length, 0);

  const bump = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', autofix_ref: 'v1.3.0', github: fake.github });

  assert.equal(bump.created, true);
  assert.equal(bump.reason, 'pr_opened');
  assert.equal(fake.state.pulls.length, 2);
  assert.match(fake.fileOn(INSTALL_BRANCH, WORKFLOW_PATH), /autofix-callable\.yml@v1\.3\.0/);
  assert.equal(statusAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' }).registrations[0].installed_workflow.pr_url, bump.pr.url);
});

test('an identical pinned job already present on the base branch opens no PR', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  const fake = makeFakeGithub({
    files: buildWorkflowFiles({ repo: 'trained-assist/demo', autofix_ref: 'v1.2.1', ci_workflow_name: 'CI', features: { cleanup: false } }),
  });

  const mark = fake.state.calls.length;
  const result = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  assert.equal(result.changed, false);
  assert.equal(result.created, false);
  assert.equal(result.pr, null);
  assert.equal(result.reason, 'already_pinned');
  assert.equal(fake.state.pulls.length, 0);
  assert.equal(fake.writeCallsSince(mark).length, 0);
  const record = statusAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' }).registrations[0];
  assert.equal(record.status, 'workflow_installed');
  assert.equal(record.installed_workflow.pr_url, null);
});

test('features.cleanup also installs the cleanup workflow in the same PR', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root, { features: { fix: true, cleanup: true } });
  const fake = makeFakeGithub();

  const result = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  assert.deepEqual(result.files.sort(), [CLEANUP_WORKFLOW_PATH, WORKFLOW_PATH].sort());
  assert.equal(fake.state.pulls.length, 1);
  assert.match(fake.fileOn(INSTALL_BRANCH, CLEANUP_WORKFLOW_PATH), /ci-fix-cleanup\.yml@v1\.2\.1/);
});

test('the pinned CI workflow name is configurable via ci_workflow_name', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root, { ci_workflow_name: 'Build & Test' });
  const fake = makeFakeGithub();
  const result = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  assert.match(fake.fileOn(INSTALL_BRANCH, WORKFLOW_PATH), /workflows: \["Build & Test"\]/);
  assert.equal(result.registration.ci_workflow_name, 'Build & Test');
});

test('install requires an immutable autofix ref and a prior registration', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root, { autofix_ref: 'v1' });

  await assert.rejects(
    () => installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: makeFakeGithub().github }),
    (e) => e instanceof PrAutofixError && e.code === 'INVALID_AUTOFIX_REF',
  );
  await assert.rejects(
    () => installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/unknown', github: makeFakeGithub().github }),
    (e) => e instanceof PrAutofixError && e.code === 'NOT_FOUND',
  );
  assert.throws(() => assertAutofixRef('main'), (e) => e.code === 'INVALID_AUTOFIX_REF');
  assert.throws(() => assertAutofixRef('v1'), (e) => e.code === 'INVALID_AUTOFIX_REF');
  assert.equal(assertAutofixRef('a'.repeat(40)), 'a'.repeat(40));
});

test('install is refused for a disabled registration', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  disableAutofix({ profileId: 'alice', root, repo: 'trained-assist/demo' });
  await assert.rejects(
    () => installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: makeFakeGithub().github }),
    (e) => e.code === 'INVALID_STATE',
  );
});

test('no code path stores credential material', async () => {
  const root = tmp('pr-autofix-');
  register('alice', root);
  const fake = makeFakeGithub();
  const result = await installAutofixWorkflow({ profileId: 'alice', root, repo: 'trained-assist/demo', github: fake.github });

  const raw = fs.readFileSync(registrationFile({ profileId: 'alice', root }), 'utf8');
  assert.equal(raw.includes(fake.github.ghToken), false, 'GitHub token must never be persisted');
  assert.equal(JSON.stringify(result).includes(fake.github.ghToken), false, 'token must not appear in the result');
  assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw), false);
  assert.equal(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(raw), false);

  const record = JSON.parse(raw).registrations[0];
  assert.deepEqual(Object.keys(record.installed_workflow).sort(), ['installed_at', 'path', 'pinned_ref', 'pr_url']);

  assert.throws(
    () => recordWorkflowInstalled({
      profileId: 'alice',
      root,
      repo: 'trained-assist/demo',
      pinnedRef: 'v1.2.1',
      path: WORKFLOW_PATH,
      prUrl: `https://x:${fake.github.ghToken}@github.com/trained-assist/demo/pull/1`,
    }),
    (e) => e instanceof PrAutofixError && e.code === 'CREDENTIAL_REJECTED',
  );
});

// --- MCP tool -----------------------------------------------------------------

test('engineering_pr_autofix_install runs through the registry with an injected capability', async () => {
  process.env.USER_ID = 'alice';
  process.env.ENGINEERING_PR_AUTOFIX_ROOT = tmp('pr-autofix-');
  const fake = makeFakeGithub();
  setGithubCapabilityFactory(() => fake.github);

  await callTool('engineering_pr_autofix_register', { repo: 'trained-assist/demo' });
  const installed = await callTool('engineering_pr_autofix_install', { repo: 'trained-assist/demo' });
  assert.equal(installed.created, true);
  assert.equal(installed.pinned_ref, DEFAULT_AUTOFIX_REF); // tool default, not a fixture literal

  const status = await callTool('engineering_pr_autofix_status', { repo: 'trained-assist/demo' });
  assert.equal(status.registrations[0].status, 'workflow_installed');
  assert.equal(status.registrations[0].installed_workflow.path, WORKFLOW_PATH);

  setGithubCapabilityFactory(null);
  delete process.env.ENGINEERING_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  await assert.rejects(
    () => callTool('engineering_pr_autofix_install', { repo: 'trained-assist/demo' }),
    (e) => e instanceof PrAutofixError && e.code === 'GITHUB_NOT_CONFIGURED',
  );
});
