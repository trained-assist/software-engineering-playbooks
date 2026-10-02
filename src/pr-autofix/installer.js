'use strict';

// Slice 2a of the pr-autofix service (issue #17): install/update the dedicated
// `.github/workflows/pr-autofix.yml` in a target repository, pinned to an
// immutable pr-autofix ref, via a reviewable pull request. This module performs
// an external write (opens/updates a PR) but **never** writes credentials or
// repository Actions secrets — secret delivery is the separate, approval-gated
// slice 2b.
//
// Transport-neutral: all GitHub access goes through an injected capability with
// `ghFetch`/`ghToken`, so tests use an in-memory fake and never touch the
// network. `createGithubCapability()` is the production implementation; the
// capability is resolved lazily so hosts (MCP) can override the token source.
//
// Why a `workflow_run`-triggered dedicated file (docs/PR-AUTOFIX-SERVICE.md §3):
// the callable only fixes a PR whose CI failed. Triggering on `workflow_run`
// (type `completed`) of the target repo's CI workflow avoids editing arbitrary
// `ci.yml` files, keeps the fixer job isolated, and is still reviewable. The CI
// workflow is matched by its `name:` (GitHub's `workflow_run.workflows`
// semantics), which is what the `ci_workflow_name` field configures (default
// "CI"). The job guards on a failed run, a pull_request-originated run, and a
// non-`fix/ci-*` head branch so it never re-fixes its own fix branches.

const {
  DEFAULT_AUTOFIX_REF,
  IMMUTABLE_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  REQUIRED_CALLABLES,
  AUTOFIX_OWNER,
  INSTALL_BRANCH,
} = require('./constants');
const { fail } = require('./errors');
const { getAutofixRegistration, recordWorkflowInstalled } = require('./registry');

const DEFAULT_BASE_BRANCH = 'main';
const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'trained-assist-engineering';

let capabilityFactory = null;

// Test/host seam: override how a GitHub capability is resolved when the caller
// does not inject one explicitly. `fn` returns a capability (or undefined for
// "not configured"). Pass null/undefined to reset to the env-token default.
function setGithubCapabilityFactory(fn) {
  capabilityFactory = typeof fn === 'function' ? fn : null;
}

function resolveGithubCapability() {
  if (capabilityFactory) {
    const capability = capabilityFactory();
    if (!capability) fail('GITHUB_NOT_CONFIGURED', 'GitHub capability is not configured for pr-autofix install');
    return capability;
  }
  const token = process.env.ENGINEERING_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    fail('GITHUB_NOT_CONFIGURED', 'no GitHub token available: set ENGINEERING_GITHUB_TOKEN (or GITHUB_TOKEN/GH_TOKEN) on the host to install a workflow');
  }
  return createGithubCapability({ token });
}

// Production GitHub capability. `ghToken` is carried on the object (the API
// needs it) but is never persisted, logged or returned by the installer.
function createGithubCapability({ token, fetchImpl = globalThis.fetch, apiBase = GITHUB_API_BASE } = {}) {
  if (!token) fail('GITHUB_NOT_CONFIGURED', 'createGithubCapability requires a token');
  if (typeof fetchImpl !== 'function') fail('GITHUB_NOT_CONFIGURED', 'no fetch implementation available for GitHub capability');
  return {
    ghToken: token,
    async ghFetch(method, endpoint, body) {
      const url = /^https?:\/\//.test(endpoint) ? endpoint : `${apiBase}${endpoint}`;
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      return { status: res.status, ok: res.ok, data };
    },
  };
}

function githubError(action, res) {
  const detail = res && res.data && (res.data.message || res.data.error);
  fail('GITHUB_ERROR', `GitHub ${action} failed with status ${res && res.status}${detail ? `: ${detail}` : ''}`);
}

function assertAutofixRef(ref) {
  const value = String(ref == null ? '' : ref).trim();
  if (!value) fail('INVALID_AUTOFIX_REF', 'autofix_ref is required');
  if (!IMMUTABLE_REF.test(value)) {
    fail('INVALID_AUTOFIX_REF', `autofix_ref must be an immutable tag (e.g. v1.2.1) or a full commit SHA, got "${value}"`);
  }
  return value;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

// `on.<event>.workflows` is a PATTERN filter, not a string comparison. GitHub documents it
// next to branches/tags/paths: these filters "accept glob patterns that use characters like
// `*`, `**`, `+`, `?`, `!` and others... If a name contains any of these characters and you
// want a literal match, you need to escape each of these special characters with `\`", where
// `+` means "one or more of the preceding character" (Filter pattern cheat sheet).
//
// So the raw name is not the pattern: `CI + Deploy` asks for two-or-more spaces and matches
// nothing, and the installed `pr-autofix.yml` then never fires while install/rollout report
// a healthy pin (issue #120 — trained-assist-agent and tg-bot had 0 runs, ever). Escaping
// keeps the filter narrow (one workflow, not "every completed workflow in the repo") while
// making it match the name that actually exists.
const FILTER_PATTERN_SPECIAL = /[\\*?+[\]]/g;

// `!` negates only as the first character of a pattern, so that is the only place escaping it
// is needed — escaping it mid-pattern would be noise GitHub's matcher has no use for.
function escapeWorkflowFilterPattern(name) {
  const text = String(name);
  return text.replace(FILTER_PATTERN_SPECIAL, (c) => `\\${c}`).replace(/^!/, '\\!');
}

function mainWorkflow({ repo, autofix_ref, ci_workflow_name }) {
  return [
    '# Managed by the trained-assist-engineering pr-autofix service.',
    `# Installed for ${repo} — change the service registration, not this file.`,
    '#',
    '# Trigger: the repository CI workflow named below completes. The pinned',
    '# callable only acts on a pull-request CI run that failed, and never on an',
    "# already-fix branch (fix/ci-*), so it cannot loop on its own fixes.",
    '#',
    '# The name below is a pattern filter, so glob metacharacters in it (+, *, ?, [, ])',
    '# are escaped for a literal match. `quoteYaml` doubles those backslashes for YAML.',
    'name: PR Autofix',
    '',
    'on:',
    '  workflow_run:',
    `    workflows: [${quoteYaml(escapeWorkflowFilterPattern(ci_workflow_name))}]`,
    '    types: [completed]',
    '',
    'permissions:',
    '  contents: write',
    '  pull-requests: write',
    '',
    'jobs:',
    '  autofix:',
    '    if: >-',
    "      github.event.workflow_run.conclusion == 'failure' &&",
    "      github.event.workflow_run.event == 'pull_request' &&",
    '      github.event.workflow_run.pull_requests[0] != null &&',
    "      !startsWith(github.event.workflow_run.head_branch, 'fix/ci-')",
    '    permissions:',
    '      contents: write',
    '      pull-requests: write',
    `    uses: trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@${autofix_ref}`,
    '    with:',
    '      pr_number: ${{ github.event.workflow_run.pull_requests[0].number }}',
    '      original_branch: ${{ github.event.workflow_run.head_branch }}',
    '      run_id: ${{ github.event.workflow_run.id }}',
    '    secrets:',
    '      llm_ladder_token: ${{ secrets.LLM_LADDER_TOKEN }}',
    '      gh_token: ${{ secrets.AUTOFIX_PAT || github.token }}',
    '',
  ].join('\n');
}

function cleanupWorkflow({ repo, autofix_ref }) {
  return [
    '# Managed by the trained-assist-engineering pr-autofix service.',
    `# Cleanup for ${repo} — change the service registration, not this file.`,
    '# Delegates to the pinned pr-autofix cleanup callable when a PR closes.',
    'name: CI Fix Cleanup',
    '',
    'on:',
    '  pull_request:',
    '    types: [closed]',
    '',
    'permissions:',
    '  contents: write',
    '  pull-requests: write',
    '',
    'jobs:',
    '  cleanup:',
    `    uses: trained-assist/pr-autofix/.github/workflows/ci-fix-cleanup.yml@${autofix_ref}`,
    '    secrets:',
    '      gh_token: ${{ secrets.AUTOFIX_PAT || github.token }}',
    '',
  ].join('\n');
}

// A ref is only usable if every reusable workflow we are about to reference resolves AT
// that ref. `uses: owner/repo/.github/workflows/x.yml@ref` is resolved by GitHub at run
// time, not at install time, so an unresolvable pin used to surface as a red install PR
// (or worse, a merge that only broke later). Refuse before anything is written.
async function assertRefCallable(github, ref, { required = REQUIRED_CALLABLES } = {}) {
  for (const rel of required) {
    const res = await github.ghFetch(
      'GET',
      `/repos/${AUTOFIX_OWNER}/contents/${rel}?ref=${encodeURIComponent(ref)}`,
    );
    const text = res.ok && typeof res.data?.content === 'string'
      ? Buffer.from(res.data.content.replace(/\n/g, ''), 'base64').toString('utf8') : '';
    // Accept the block/inline forms emitted by our pinned workflows, fail closed otherwise.
    const onBlock = text.match(/^(?:on|'on'|"on"):\s*\n((?:[ \t]+[^\n]*\n|\n)*)/m);
    if (res.ok && ((onBlock && /^  workflow_call\s*:/m.test(onBlock[1]))
      || /^(?:on|'on'|"on"):\s*(?:workflow_call|\[[^\]\n]*\bworkflow_call\b[^\]\n]*\]|\{\s*workflow_call:.*\})\s*$/m.test(text))) continue;
    fail(
      'REF_NOT_CALLABLE',
      `autofix_ref "${ref}" does not contain ${AUTOFIX_OWNER}/${rel} (HTTP ${res.status}); `
      + 'pick a release where every required reusable workflow exists — installing against '
      + 'an older ref produces a workflow GitHub cannot resolve',
      { ref, missing: rel, status: res.status },
    );
  }
  return ref;
}

// `main` is only the usual default branch: part of the org still lives on `master`, and a
// silent wrong base branch is an install PR against nothing. Likewise the watched CI
// workflow is matched by its `name:`, so it has to be read, not guessed.
async function autodetectRepoDefaults(github, repo) {
  const meta = await github.ghFetch('GET', `/repos/${repo}`);
  if (!meta.ok) githubError(`read repository ${repo}`, meta);
  const defaultBranch = (meta.data && meta.data.default_branch) || 'main';

  const workflows = await github.ghFetch('GET', `/repos/${repo}/actions/workflows`);
  if (!workflows.ok) githubError(`list workflows of ${repo}`, workflows);
  const list = Array.isArray(workflows.data && workflows.data.workflows)
    ? workflows.data.workflows
    : [];

  // Preference order, most specific first: an exact "CI" name, then anything that reads as
  // CI, then the most frequently run workflow, then the constant. A repo with no workflows
  // at all is a fact, not a guess — we say so and fall back to the constant.
  const byName = (n) => list.find((w) => (w.name || '').toLowerCase() === n);
  const exact = byName('ci');
  const ciish = list.filter((w) => /(^|[^a-z])ci([^a-z]|$)|test|check|build|lint|verify|node\.js/i.test(`${w.name || ''} ${w.path || ''}`));
  const fallback = ciish.sort((a, b) => (b.badge_url ? 0 : 0) - (a.badge_url ? 0 : 0) || 0)[0];
  const chosen = exact || ciish[0];
  const ciWorkflowName = (chosen && chosen.name) || DEFAULT_CI_WORKFLOW_NAME;

  return {
    default_branch: defaultBranch,
    ci_workflow_name: ciWorkflowName,
    detected: {
      default_branch: Boolean((meta.data && meta.data.default_branch)),
      ci_workflow_name: Boolean(chosen),
      workflow_count: list.length,
    },
  };
}

// Build the map of workflow-path -> content for a registration. Pure and
// deterministic so idempotency can be decided by exact content comparison.
function buildWorkflowFiles({ repo, autofix_ref, ci_workflow_name, features } = {}) {
  if (!repo) fail('INVALID_REGISTRATION', 'repo is required');
  const ref = assertAutofixRef(autofix_ref === undefined || autofix_ref === '' ? DEFAULT_AUTOFIX_REF : autofix_ref);
  const ciName = ci_workflow_name === undefined || ci_workflow_name === '' ? DEFAULT_CI_WORKFLOW_NAME : String(ci_workflow_name);
  const files = { [WORKFLOW_PATH]: mainWorkflow({ repo, autofix_ref: ref, ci_workflow_name: ciName }) };
  if (features && features.cleanup) files[CLEANUP_WORKFLOW_PATH] = cleanupWorkflow({ repo, autofix_ref: ref });
  return files;
}

async function getRef(github, repo, branch) {
  const res = await github.ghFetch('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) githubError(`lookup ref ${branch}`, res);
  return res.data;
}

async function getFile(github, repo, filePath, ref) {
  const res = await github.ghFetch('GET', `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) githubError(`read ${filePath}@${ref}`, res);
  const data = res.data || {};
  const content = typeof data.content === 'string'
    ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
    : '';
  return { content, sha: data.sha || null };
}

async function putFile(github, repo, filePath, { content, branch, sha, message }) {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await github.ghFetch('PUT', `/repos/${repo}/contents/${filePath}`, body);
  if (!res.ok) githubError(`write ${filePath}@${branch}`, res);
  return res.data;
}

// No open install PR here, so an existing INSTALL_BRANCH is a leftover of a
// merged/closed PR (squash merges keep the branch). Reset it to the base tip —
// building on the stale head re-proposes old content and conflicts.
async function ensureBranch(github, repo, branch, baseSha) {
  const existing = await getRef(github, repo, branch);
  if (existing) {
    const res = await github.ghFetch('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: baseSha, force: true });
    if (!res.ok) githubError(`reset branch ${branch}`, res);
    return res.data;
  }
  const res = await github.ghFetch('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  if (!res.ok) githubError(`create branch ${branch}`, res);
  return res.data;
}

async function findOpenInstallPr(github, repo, baseBranch) {
  const owner = repo.slice(0, repo.indexOf('/'));
  const head = encodeURIComponent(`${owner}:${INSTALL_BRANCH}`);
  const base = encodeURIComponent(baseBranch);
  const res = await github.ghFetch('GET', `/repos/${repo}/pulls?state=open&head=${head}&base=${base}`);
  if (!res.ok) githubError('list pull requests', res);
  return Array.isArray(res.data) ? res.data[0] || null : null;
}

async function createPull(github, repo, { title, head, base, body }) {
  const res = await github.ghFetch('POST', `/repos/${repo}/pulls`, { title, head, base, body });
  if (!res.ok) githubError('create pull request', res);
  return res.data;
}

async function updatePull(github, repo, number, { title, body }) {
  const res = await github.ghFetch('PATCH', `/repos/${repo}/pulls/${number}`, { title, body });
  if (!res.ok) githubError(`update pull request #${number}`, res);
  return res.data;
}

async function filesMatch(github, repo, desired, ref) {
  for (const [filePath, content] of Object.entries(desired)) {
    const current = await getFile(github, repo, filePath, ref);
    if (!current || current.content !== content) return false;
  }
  return true;
}

function prView(pr) {
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.html_url,
    head: pr.head && pr.head.ref,
    base: pr.base && pr.base.ref,
    state: pr.state,
  };
}

function prTitle({ ref }) {
  return `chore(ci): install pr-autofix workflow (${ref})`;
}

function prBody({ repo, ref, ciName, files }) {
  return [
    'Installed by the trained-assist-engineering pr-autofix service.',
    '',
    `- Target repo: \`${repo}\``,
    `- Pinned pr-autofix ref: \`${ref}\``,
    `- CI workflow watched: \`${ciName}\``,
    `- Files: ${files.map((f) => `\`${f}\``).join(', ')}`,
    '',
    'This PR only adds workflow files. It does **not** create or change repository',
    'secrets: `LLM_LADDER_TOKEN` (org-level in trained-assist) and `AUTOFIX_PAT` are referenced by name and must',
    'be provisioned separately (approval-gated slice 2b).',
    '',
  ].join('\n');
}

// Install or update the pr-autofix workflow for a registered repo. Returns a
// descriptor; on any success (including a no-op) it advances the registration
// to `workflow_installed` and persists `installed_workflow`.
async function installAutofixWorkflow({
  profileId,
  root,
  repo,
  base_branch,
  autofix_ref,
  ci_workflow_name,
  github,
} = {}) {
  const registration = getAutofixRegistration({ profileId, root, repo });
  if (!registration) {
    fail('NOT_FOUND', `no pr-autofix registration for ${repo}; register it before installing`);
  }
  if (registration.status === 'disabled') {
    fail('INVALID_STATE', `pr-autofix for ${registration.repo} is disabled; re-register before installing`);
  }

  const effectiveRef = assertAutofixRef(
    autofix_ref || registration.autofix_ref || DEFAULT_AUTOFIX_REF,
  );
  // Start from the EXPLICIT arguments only. The registration's value is applied below, after
  // autodetection, because a stored default is not a decision.
  let effectiveBase = base_branch || '';
  let effectiveCi = ci_workflow_name || '';
  const cap = github || resolveGithubCapability();

  // Both before the ref is baked into any file: a wrong pin or a wrong base branch is
  // cheap to reject here and expensive to discover in a review round trip.
  await assertRefCallable(cap, effectiveRef);

  // Autodetect reads two objective facts about the repository: its default branch, and the
  // `name:` of the CI workflow `workflow_run.workflows` will match on. An explicit argument
  // always wins — a human asked for that value. Otherwise the detected fact wins over the
  // stored default, because "main"/"CI" in a fresh registration are DEFAULTS, not decisions,
  // and part of the org still lives on `master`. When the two disagree the receipt says so,
  // so a wrong configuration is visible rather than silently rewritten.
  const detected = await autodetectRepoDefaults(cap, registration.repo);
  const registeredBase = registration.base_branch || '';
  const registeredCi = registration.ci_workflow_name || '';
  const explicitBase = Boolean(base_branch);
  const explicitCi = Boolean(ci_workflow_name);
  const before = { base_branch: registeredBase, ci_workflow_name: registeredCi };
  if (!effectiveBase) {
    effectiveBase = (registeredBase && registeredBase !== DEFAULT_BASE_BRANCH)
      ? registeredBase
      : detected.default_branch;
  }
  if (!effectiveCi) {
    effectiveCi = (registeredCi && registeredCi !== DEFAULT_CI_WORKFLOW_NAME)
      ? registeredCi
      : detected.ci_workflow_name;
  }
  const notes = (before.base_branch && before.base_branch !== effectiveBase)
    ? [`base_branch: registered "${before.base_branch}" -> detected "${effectiveBase}"${explicitBase ? '' : ' (no explicit argument)'}`.replace(': registered', ': registration said')]
    : [];
  if (before.ci_workflow_name && before.ci_workflow_name !== effectiveCi && !explicitCi) {
    notes.push(`ci_workflow_name: registration said "${before.ci_workflow_name}", detected "${effectiveCi}"`);
  }

  const desired = buildWorkflowFiles({
    repo: registration.repo,
    autofix_ref: effectiveRef,
    ci_workflow_name: effectiveCi,
    features: registration.features,
  });
  const filePaths = Object.keys(desired);

  const persist = (prUrl) => recordWorkflowInstalled({
    profileId,
    root,
    repo: registration.repo,
    pinnedRef: effectiveRef,
    path: WORKFLOW_PATH,
    prUrl,
    ciWorkflowName: effectiveCi,
    baseBranch: effectiveBase,
  });

  const common = {
    repo: registration.repo,
    pinned_ref: effectiveRef,
    path: WORKFLOW_PATH,
    files: filePaths,
    base_branch: effectiveBase,
    ci_workflow_name: effectiveCi,
    detected,
    notes,
  };

  // Already merged/installed on the base branch with identical pinned content.
  if (await filesMatch(cap, registration.repo, desired, effectiveBase)) {
    const updated = persist(null);
    return { ...common, changed: false, created: false, updated: false, pr: null, reason: 'already_pinned', registration: updated };
  }

  const openPr = await findOpenInstallPr(cap, registration.repo, effectiveBase);

  if (openPr) {
    if (await filesMatch(cap, registration.repo, desired, INSTALL_BRANCH)) {
      const updated = persist(openPr.html_url);
      return { ...common, changed: false, created: false, updated: false, pr: prView(openPr), reason: 'pr_up_to_date', registration: updated };
    }
    const message = prTitle({ ref: effectiveRef });
    for (const [filePath, content] of Object.entries(desired)) {
      const existing = await getFile(cap, registration.repo, filePath, INSTALL_BRANCH);
      await putFile(cap, registration.repo, filePath, {
        content,
        branch: INSTALL_BRANCH,
        sha: existing && existing.sha,
        message,
      });
    }
    await updatePull(cap, registration.repo, openPr.number, {
      title: message,
      body: prBody({ repo: registration.repo, ref: effectiveRef, ciName: effectiveCi, files: filePaths }),
    });
    const updated = persist(openPr.html_url);
    return { ...common, changed: true, created: false, updated: true, pr: prView(openPr), reason: 'pr_updated', registration: updated };
  }

  const baseRef = await getRef(cap, registration.repo, effectiveBase);
  if (!baseRef) fail('NOT_FOUND', `base branch "${effectiveBase}" not found in ${registration.repo}`);
  await ensureBranch(cap, registration.repo, INSTALL_BRANCH, baseRef.object.sha);
  const message = prTitle({ ref: effectiveRef });
  for (const [filePath, content] of Object.entries(desired)) {
    // After a merged install the file already exists on base → GitHub needs its sha.
    const existing = await getFile(cap, registration.repo, filePath, INSTALL_BRANCH);
    await putFile(cap, registration.repo, filePath, { content, branch: INSTALL_BRANCH, sha: existing && existing.sha, message });
  }
  const pr = await createPull(cap, registration.repo, {
    title: message,
    head: INSTALL_BRANCH,
    base: effectiveBase,
    body: prBody({ repo: registration.repo, ref: effectiveRef, ciName: effectiveCi, files: filePaths }),
  });
  const updated = persist(pr.html_url);
  return { ...common, changed: true, created: true, updated: false, pr: prView(pr), reason: 'pr_opened', registration: updated };
}

module.exports = {
  DEFAULT_AUTOFIX_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  INSTALL_BRANCH,
  createGithubCapability,
  setGithubCapabilityFactory,
  resolveGithubCapability,
  assertAutofixRef,
  assertRefCallable,
  autodetectRepoDefaults,
  buildWorkflowFiles,
  filesMatch,
  installAutofixWorkflow,
};
