'use strict';

// Z01 · T10 (issue software-engineering-playbooks#78). The behaviours the one-command procedure
// exists for, asserted as outcomes rather than as code paths:
//
//   1. a ref whose reusable workflows do not resolve is REFUSED before any write
//   2. the target repo's own base branch and CI workflow name are read, not assumed
//   3. a repeat on an unchanged repository is EVIDENCE (exit 0, changed:false), not an error
//   4. a repeat that changes content after a no-op is reported as non-idempotent
//
// Everything runs against an in-memory capability; nothing here touches the network or a token.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerAutofix,
  installAutofixWorkflow,
  setupDevbaseline,
  assertRefCallable,
  autodetectRepoDefaults,
  setGithubCapabilityFactory,
  PrAutofixError,
  DEFAULT_AUTOFIX_REF,
} = require('../src/pr-autofix');

const TOOL_REPO = 'trained-assist/pr-autofix';
const CALLABLES = [
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
];

const cleanup = [];
test.after(() => {
  setGithubCapabilityFactory(null);
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Fake GitHub with just enough surface: the tool repo's callables (per ref), the target repo's
// metadata + workflows for autodetect, and the content/ref/pull endpoints the installer uses.
function fake({ base = 'main', repo = 'trained-assist/demo', defaultBranch = null, workflowNames = ['CI'], callableRefs = null, files = {} } = {}) {
  const state = { refs: { [base]: 'sha0' }, snapshots: { sha0: { ...files } }, pulls: [], shaSeq: 0, prSeq: 0, base };
  const snapshotOf = (b) => state.snapshots[state.refs[b]] || {};

  async function ghFetch(method, endpoint, body) {
    const upper = String(method || 'GET').toUpperCase();
    const url = new URL(endpoint, 'https://api.github.com');
    const route = url.pathname;
    const q = url.searchParams;
    let m;

    if (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/)) {
      if (`${m[1]}/${m[2]}` === TOOL_REPO && upper === 'GET') {
        const ref = q.get('ref');
        const ok = callableRefs === null || callableRefs.includes(ref);
        const fp = decodeURIComponent(m[3]);
        if (!ok || !CALLABLES.includes(fp)) return { status: 404, ok: false, data: { message: 'Not Found' } };
        return { status: 200, ok: true, data: { content: b64('# callable\n'), sha: 'blob:tool' } };
      }
      const fp = decodeURIComponent(m[3]);
      if (upper === 'GET') {
        const content = snapshotOf(q.get('ref'))[fp];
        if (content === undefined) return { status: 404, ok: false, data: { message: 'Not Found' } };
        return { status: 200, ok: true, data: { content: b64(content), sha: `blob:${fp}` } };
      }
      const branch = body.branch;
      if (snapshotOf(branch)[fp] !== undefined && !body.sha) return { status: 422, ok: false, data: { message: 'Invalid request' } };
      const next = { ...snapshotOf(branch) };
      next[fp] = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = `sha${++state.shaSeq}`;
      state.snapshots[sha] = next;
      state.refs[branch] = sha;
      return { status: 200, ok: true, data: { content: { sha }, commit: { sha } } };
    }
    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
      if (`${m[1]}/${m[2]}` === repo) return { status: 200, ok: true, data: { default_branch: defaultBranch || base, full_name: repo } };
    }
    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows$/))) {
      if (`${m[1]}/${m[2]}` === repo) return { status: 200, ok: true, data: { workflows: workflowNames.map((n) => ({ name: n, path: `.github/workflows/${n}.yml` })) } };
    }
    if (upper === 'GET' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/))) {
      const b = decodeURIComponent(m[3]);
      if (!state.refs[b]) return { status: 404, ok: false, data: { message: 'Not Found' } };
      return { status: 200, ok: true, data: { object: { sha: state.refs[b] } } };
    }
    if (upper === 'PATCH' && (m = route.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/))) {
      const b = decodeURIComponent(m[3]);
      if (!state.refs[b]) return { status: 422, ok: false, data: { message: 'Reference does not exist' } };
      state.refs[b] = body.sha;
      return { status: 200, ok: true, data: { object: { sha: body.sha } } };
    }
    if (upper === 'POST' && /\/git\/refs$/.test(route)) {
      const b = String(body.ref).replace(/^refs\/heads\//, '');
      if (state.refs[b]) return { status: 422, ok: false, data: { message: 'Reference already exists' } };
      state.refs[b] = body.sha;
      if (!state.snapshots[body.sha]) state.snapshots[body.sha] = {};
      return { status: 201, ok: true, data: { ref: body.ref, object: { sha: body.sha } } };
    }
    if (upper === 'GET' && /\/pulls$/.test(route)) {
      const want = q.get('state') || 'open';
      const head = q.get('head');
      const baseQ = q.get('base');
      return {
        status: 200, ok: true,
        data: state.pulls.filter((p) => p.state === want
          && (!head || p.head.ref === head.split(':').pop())
          && (!baseQ || p.base.ref === baseQ)),
      };
    }
    if (upper === 'POST' && /\/pulls$/.test(route)) {
      const n = ++state.prSeq;
      const pr = {
        number: n,
        state: 'open',
        html_url: `https://example.test/${repo}/pull/${n}`,
        head: { ref: body.head },
        base: { ref: body.base },
        title: body.title,
        body: body.body,
        // A real PR merge lands the content on the base branch under a NEW commit.
        merge: () => {
          const merged = { ...(state.snapshots[state.refs[body.base]] || {}), ...snapshotOf(body.head) };
          const next = `sha${++state.shaSeq}`;
          state.snapshots[next] = merged;
          state.refs[body.base] = next;
          pr.state = 'closed';
        },
      };
      state.pulls.push(pr);
      return { status: 201, ok: true, data: pr };
    }
    if (upper === 'PATCH' && /\/pulls\/\d+$/.test(route)) return { status: 200, ok: true, data: { number: 1 } };
    return { status: 404, ok: false, data: { message: `unhandled ${upper} ${route}` } };
  }
  return { ghToken: 'fake', ghFetch, state };
}

// Registered WITHOUT base_branch on purpose: an explicit base branch in the registration is a
// decision, and the installer must not second-guess it. Autodetect is what fills the gap when
// nobody decided.
function registered(repo = 'trained-assist/demo', root = tmp('pb-setup-'), overrides = {}) {
  registerAutofix({
    profileId: 'default',
    root,
    registration: { repo, features: { fix: true, cleanup: true, batch: true }, ...overrides },
  });
  return { root, repo };
}

test('a ref whose reusable workflows do not resolve is refused before any write', async () => {
  const gh = fake({ callableRefs: ['v1.7.4'] });
  await assert.rejects(
    () => assertRefCallable(gh, 'v1.7.2'),
    (e) => e instanceof PrAutofixError && e.code === 'REF_NOT_CALLABLE' && /autofix-callable\.yml/.test(e.message),
  );
  // Nothing was written to the target repository.
  assert.equal(gh.state.shaSeq, 0, 'no file was written');
  assert.equal(gh.state.pulls.length, 0, 'no PR was opened');
});

test('the default pin is one where every required callable exists', async () => {
  const gh = fake({ callableRefs: ['v1.7.4'] });
  assert.equal(await assertRefCallable(gh, DEFAULT_AUTOFIX_REF), DEFAULT_AUTOFIX_REF);
});

test('base branch and CI workflow name are read from the repository, not assumed', async () => {
  const gh = fake({ base: 'main', defaultBranch: 'master', workflowNames: ['Node.js CI'] });
  const d = await autodetectRepoDefaults(gh, 'trained-assist/demo');
  assert.equal(d.default_branch, 'master');
  assert.equal(d.ci_workflow_name, 'Node.js CI');
  assert.equal(d.detected.workflow_count, 1);
});

test('a repository with no workflows reports the constant and says detection found nothing', async () => {
  const gh = fake({ defaultBranch: 'main', workflowNames: [] });
  const d = await autodetectRepoDefaults(gh, 'trained-assist/demo');
  assert.equal(d.ci_workflow_name, 'CI');
  assert.equal(d.detected.ci_workflow_name, false);
});

test('installing against a repo on master targets master', async () => {
  const { root, repo } = registered();
  // The fake's own default branch IS master, so a PR against `main` would fail loudly.
  const gh = fake({ base: 'master', defaultBranch: 'master', workflowNames: ['CI'] });
  const r = await installAutofixWorkflow({ profileId: 'default', root, repo, github: gh });
  assert.equal(r.pr.base, 'master', 'the install PR must target the repository default branch');
  assert.ok(r.notes.some((n) => /registration said "main"/.test(n)), 'the override is recorded, not silent');
});

test('setup → run → evidence → teardown completes and opens one PR', async () => {
  const { root, repo } = registered();
  const gh = fake({ defaultBranch: 'main', workflowNames: ['CI'] });
  const r = await setupDevbaseline({ repo, profileId: 'default', root, github: gh, callableRefs: null });
  assert.equal(r.code, 0);
  assert.deepEqual(r.phases.map((p) => p.phase), ['setup', 'run', 'evidence', 'teardown']);
  assert.ok(r.phases.every((p) => p.ok === true), `every phase observed a result: ${JSON.stringify(r.phases)}`);
  assert.equal(r.evidence.changed, true);
  assert.equal(r.evidence.reason, 'pr_opened');
  assert.equal(r.evidence.pinned_ref, DEFAULT_AUTOFIX_REF);
  assert.ok(r.evidence.pr && /^https:\/\//.test(r.evidence.pr.url));
  assert.equal(r.teardown.repository_touched, false, 'teardown must not touch the repository');
});

test('a repeat on an unchanged repository is evidence, not an error (exit 0)', async () => {
  const { root, repo } = registered();
  const gh = fake({ defaultBranch: 'main', workflowNames: ['CI'] });
  const first = await setupDevbaseline({ repo, profileId: 'default', root, github: gh });
  assert.equal(first.code, 0);
  // Land the PR: content is now on the base branch.
  gh.state.pulls[0].merge();

  const second = await setupDevbaseline({ repo, profileId: 'default', root, github: gh });
  assert.equal(second.code, 0, 'a no-op repeat must not be reported as a failure');
  assert.equal(second.evidence.changed, false);
  assert.equal(second.evidence.reason, 'already_pinned');
  assert.equal(second.evidence.idempotent, true);
  assert.equal(second.evidence.pr, null, 'no second PR is opened for identical content');
});

test('a repeat that changes content after a no-op is reported as non-idempotent', async () => {
  const { root, repo } = registered();
  const gh = fake({ defaultBranch: 'main', workflowNames: ['CI'] });
  const probe = await setupDevbaseline({ repo, profileId: 'default', root, github: gh });
  assert.equal(probe.code, 0);
  gh.state.pulls[0].merge();

  // The base branch drifts under us: setup sees pinned content (no-op), run sees other bytes.
  let calls = 0;
  const flaky = {
    ghToken: 'fake',
    ghFetch: async (...args) => {
      calls += 1;
      const res = await gh.ghFetch(...args);
      if (calls === 12) {
        const main = gh.state.refs.main;
        gh.state.snapshots[main] = { ...gh.state.snapshots[main], '.github/workflows/pr-autofix.yml': '# tampered\n' };
      }
      return res;
    },
  };
  const r = await setupDevbaseline({ repo, profileId: 'default', root, github: flaky });
  assert.notEqual(r.code, 0, 'non-idempotency must not exit 0');
  assert.equal(r.error && r.error.code, 'REPEAT_NOT_IDEMPOTENT');
});

test('an unresolvable ref stops the procedure at setup with a named code', async () => {
  const { root, repo } = registered();
  const gh = fake({ callableRefs: [] });
  const r = await setupDevbaseline({ repo, profileId: 'default', root, github: gh });
  assert.equal(r.code, 5);
  assert.equal(r.error.code, 'REF_NOT_CALLABLE');
  assert.equal(gh.state.pulls.length, 0, 'nothing is opened when the pin cannot resolve');
});

test('no code path stores or prints credential material', () => {
  const src = [
    fs.readFileSync(path.join(__dirname, '..', 'src', 'pr-autofix', 'setup.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'pr-autofix', 'installer.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'devbaseline-setup.js'), 'utf8'),
  ].join('\n');
  assert.ok(!/ghp_[A-Za-z0-9]{10}/.test(src), 'no hard-coded token');
  assert.ok(!/console\.(log|stdout)\([^)]*ghToken/.test(src), 'ghToken is never printed');
});