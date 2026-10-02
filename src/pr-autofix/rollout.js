'use strict';

// Batch rollout of the pr-autofix workflow (issue #95).
//
// Before this module, adopting pr-autofix in one repository was a five-step manual
// procedure with three hidden traps: call `engineering_pr_autofix_register`, then
// `engineering_pr_autofix_install` (which hard-fails NOT_FOUND without the first),
// pass the one known-good ref by hand (the installer default points elsewhere), get a
// human to review and merge the install PR, and finally regenerate the coverage table
// that the install itself turned red. Across 25 repositories that is 18 repetitions
// of the same dance.
//
// `rolloutAutofix()` is the "раз и вжик" replacement: one call, driven by the org
// inventory, that registers what is missing, installs with the known-good ref, and
// prints a per-repo status table in which every repository appears with the reason it
// was skipped. `dryRun` does every read and prints the plan without a single write.
//
// Repo defaults (default branch, watched CI workflow name) come from the installer's
// own `autodetectRepoDefaults()` rather than a second implementation, so a rollout and
// a single-repo `setup:devbaseline` can never disagree about what to watch. The one
// thing autodetect cannot know is whether the chosen workflow actually runs on pull
// requests — it matches on the *name* — so the rollout verifies that separately.
//
// Transport-neutral like the installer: all GitHub access goes through an injected
// capability with `ghFetch`, so tests use an in-memory fake.

const { fail } = require('./errors');
const {
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  DEFECTIVE_AUTOFIX_REFS,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  INVENTORY_REPO,
  INVENTORY_PATH,
} = require('./constants');
const { registerAutofix, getAutofixRegistration } = require('./registry');
const {
  installAutofixWorkflow,
  autodetectRepoDefaults,
  buildWorkflowFiles,
  filesMatch,
  assertAutofixRef,
} = require('./installer');

// A rollout never installs the tool into itself: pr-autofix is the fixer, not a
// consumer, and a self-referential workflow_run trigger cannot fire.
const SELF_REPO = 'trained-assist/pr-autofix';

// R-18. The refusal lives here, not in the installer's shared `assertAutofixRef`:
// moving that default is an org-wide policy decision — it would change what every
// existing `setup:devbaseline --repo X` without an explicit `--ref` installs — and
// the installer's own callability check is a separate safety net. A rollout pins 25
// repositories in one pass, so it is exactly the place a bad ref must never pass
// silently.
function assertRolloutRef(ref) {
  const value = assertAutofixRef(ref);
  if (DEFECTIVE_AUTOFIX_REFS.has(value)) {
    fail(
      'DEFECTIVE_AUTOFIX_REF',
      `autofix_ref ${value} is in the defective v1.7.4…v1.7.7 window (fixed in v1.7.8, pr-autofix R-15); `
      + 'a rollout pins many repositories at once, so it refuses the window — pass '
      + `--ref ${ROLLOUT_DEFAULT_AUTOFIX_REF} or newer`,
    );
  }
  return value;
}

function logLine(logger, line) {
  if (typeof logger === 'function') logger(line);
}

async function ghJson(github, method, endpoint) {
  const res = await github.ghFetch(method, endpoint);
  if (!res.ok) {
    const detail = res.data && (res.data.message || res.data.error);
    fail('GITHUB_ERROR', `GitHub ${method} ${endpoint} failed with status ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.data === undefined ? null : res.data;
}

async function inventoryRepos(github, { inventoryRepo, inventoryPath } = {}) {
  const repo = inventoryRepo || INVENTORY_REPO;
  const filePath = inventoryPath || INVENTORY_PATH;
  const data = await ghJson(github, 'GET', `/repos/${repo}/contents/${filePath}`);
  if (!data || typeof data.content !== 'string') {
    fail('NOT_FOUND', `inventory ${filePath} not found in ${repo}`);
  }
  const parsed = JSON.parse(Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  const repos = Array.isArray(parsed.repos) ? parsed.repos.map((row) => row && row.repo).filter(Boolean) : [];
  if (repos.length === 0) fail('NOT_FOUND', `inventory ${filePath} in ${repo} lists no repositories`);
  // Sorted, like an explicit repo list, so the report order does not depend on how
  // the inventory happens to be laid out today.
  return [...new Set(repos)].sort();
}

function normalizeRepoList(repos) {
  const out = [];
  for (const entry of repos) {
    const value = String(entry == null ? '' : entry).trim();
    if (!value) continue;
    if (!/^[^/\s]+\/[^/\s]+$/.test(value)) fail('INVALID_REGISTRATION', `repo must be in "owner/name" form, got "${value}"`);
    out.push(value);
  }
  if (out.length === 0) fail('INVALID_REGISTRATION', 'at least one repository is required');
  return [...new Set(out)].sort();
}

// Does this workflow file run on pull requests? The installed `workflow_run` trigger
// only acts on a PR-originated run, so watching a tag- or schedule-only workflow is a
// silent mis-wire: the install looks green and never fires. `autodetectRepoDefaults`
// matches on the workflow *name* ("Build & Release" reads as CI), which is not the same
// thing as running on PRs — so the rollout verifies the trigger before installing.
function runsOnPullRequest(content) {
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^on:\s*$/.test(lines[i]) && !/^on:\s*\[/.test(lines[i]) && !/^on:\s*\{\s*$/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (!/^\s+/.test(line)) break; // left the `on:` block
      if (/^\s+pull_request\s*:/.test(line) || /^\s+pull_request\s*$/.test(line)) return true;
    }
  }
  return false;
}

async function readWorkflowByPath(github, repo, workflowPath) {
  const res = await github.ghFetch('GET', `/repos/${repo}/contents/${encodeURIComponent(workflowPath)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = res.data && (res.data.message || res.data.error);
    fail('GITHUB_ERROR', `GitHub GET /repos/${repo}/contents/${workflowPath} failed with status ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = res.data || {};
  return typeof data.content === 'string'
    ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
    : null;
}

// The `actions/workflows` listing carries each workflow's `path`, which is what the
// rollout needs in order to read the file and check its triggers.
async function listWorkflows(github, repo) {
  const data = await ghJson(github, 'GET', `/repos/${repo}/actions/workflows`);
  const list = Array.isArray(data && data.workflows) ? data.workflows : [];
  return list.filter((row) => row && typeof row.path === 'string' && row.path);
}

// The two workflow files this service installs. They must never be treated as a CI to
// watch: `ci-fix-cleanup.yml` is named "CI Fix Cleanup", outranks the real CI by name,
// and runs on `pull_request: closed`, so picking it would make the installed trigger
// fire when a pull request closes. Without this exclusion a second rollout run would
// try to re-install against the cleanup workflow and never converge.
const SERVICE_WORKFLOW_PATHS = new Set([WORKFLOW_PATH, CLEANUP_WORKFLOW_PATH]);

// GitHub reports a workflow's `name` as its path when the file has no `name:` field,
// and the listing also keeps entries for workflows that no longer exist on disk. Both
// are invisible to a name-based heuristic and both silently win it.
function hasRealName(entry) {
  if (!entry || !entry.name) return false;
  if (entry.name !== entry.path) return true;
  return !SERVICE_WORKFLOW_PATHS.has(entry.path);
}

function isServiceWorkflow(entry) {
  return Boolean(entry && entry.path && SERVICE_WORKFLOW_PATHS.has(entry.path));
}

// Rank a workflow name as a CI candidate. The signal that matters is whether "ci" is
// the name's own subject rather than a prefix glued onto something else: "CI" and
// "CI + Deploy" are the pull-request CI in our repositories, while "CI-Fix Cleanup"
// is the branch-cleanup job that merely runs on `pull_request: closed` — wiring the
// trigger to it makes autofix fire on a PR closing. A hyphen after "ci" means the rest
// of the name qualifies CI itself, which is never the check we want.
function ciRank(entry) {
  const name = String(entry && entry.name ? entry.name : '');
  if (isServiceWorkflow(entry) || !hasRealName(entry)) return -1;
  const lower = name.toLowerCase();
  if (lower === 'ci') return 3;
  if (/^ci[^a-z]/.test(lower) && name.slice(2, 3) !== '-') return 2;
  if (/(^|[^a-z])ci([^a-z]|$)/.test(lower)) return 1;
  return 0;
}

// Choose the CI workflow to watch. The installer's `autodetectRepoDefaults` picks by
// name alone, which is not enough here: `trained-assist-agent` has a stale, nameless
// listing entry that sorts ahead of its real "CI + Deploy" workflow, and several of our
// repositories keep a cleanup/merge workflow that *does* run on `pull_request` while
// having nothing to do with CI. So the rollout ranks by name, then requires the chosen
// file to exist and to run on pull requests.
async function selectCiWorkflow(github, repo) {
  const list = await listWorkflows(github, repo);
  const ranked = list
    .map((entry) => ({ entry, rank: ciRank(entry) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => b.rank - a.rank);
  for (const { entry } of ranked) {
    const content = await readWorkflowByPath(github, repo, entry.path);
    if (content === null) continue; // listed but gone on disk
    if (!runsOnPullRequest(content)) continue;
    return { name: entry.name, path: entry.path };
  }
  return null;
}

// Read-only per-repo plan. Shared by `dryRun` and the live path so the plan that was
// printed is exactly what gets executed. `detected` is the installer's own autodetect
// result, used for the default branch; the watched CI workflow is chosen by
// `selectCiWorkflow`, which verifies the trigger instead of trusting a name.
async function planRepo({ github, repo, detected, baseBranch, autofixRef, ciName, withCleanup }) {
  // Choose the CI workflow to watch: the caller's explicit name when given, otherwise
  // the best candidate this repository actually has.
  const selected = ciName ? { name: ciName, path: null } : await selectCiWorkflow(github, repo);

  // A repository with no pull-request CI is a fact, not a guess: the installed
  // `workflow_run` trigger would never fire, so installing would look green forever
  // while fixing nothing. Report it and let a human decide (`--ci-workflow`).
  if (!selected) {
    return {
      repo,
      status: 'skipped',
      reason: ciName ? 'ci_not_pull_request' : 'no_ci_workflow',
      baseBranch,
      ciName: ciName || null,
      ciPath: null,
      alreadyInstalled: false,
    };
  }

  // Whatever the name's origin, the file it points at must exist and must run on pull
  // requests. An explicit `--ci-workflow` is the caller's decision about *which* name,
  // not a licence to wire the trigger to a tag-only workflow.
  let ciPath = selected.path;
  if (ciName) {
    const list = await listWorkflows(github, repo);
    const entry = list.find((row) => row && row.name === ciName);
    ciPath = entry && entry.path ? entry.path : null;
  }
  const content = ciPath ? await readWorkflowByPath(github, repo, ciPath) : null;
  if (content === null || !runsOnPullRequest(content)) {
    return {
      repo,
      status: 'skipped',
      reason: 'ci_not_pull_request',
      baseBranch,
      ciName: selected.name,
      ciPath,
      alreadyInstalled: false,
    };
  }

  const effectiveCi = selected.name;
  const desired = buildWorkflowFiles({
    repo,
    autofix_ref: autofixRef,
    ci_workflow_name: effectiveCi,
    features: { fix: true, cleanup: withCleanup },
  });
  const alreadyInstalled = await filesMatch(github, repo, desired, baseBranch);
  return {
    repo,
    status: alreadyInstalled ? 'installed' : 'pr_opened',
    reason: alreadyInstalled ? 'already_pinned' : null,
    baseBranch,
    ciName: effectiveCi,
    ciPath,
    alreadyInstalled,
    files: Object.keys(desired),
  };
}

async function rolloutAutofix({
  profileId,
  root,
  repos,
  autofix_ref: autofixRef,
  ci_workflow_name: ciWorkflowName,
  github,
  dryRun = false,
  withCleanup = true,
  inventoryRepo,
  inventoryPath,
  logger,
} = {}) {
  if (!profileId) fail('INVALID_PROFILE', 'profileId is required');
  const cap = github;
  if (!cap) fail('GITHUB_NOT_CONFIGURED', 'a GitHub capability is required for the pr-autofix rollout');

  const effectiveRef = assertRolloutRef(autofixRef || ROLLOUT_DEFAULT_AUTOFIX_REF);

  const targets = repos ? normalizeRepoList(repos) : await inventoryRepos(cap, { inventoryRepo, inventoryPath });
  logLine(logger, `pr-autofix rollout: ${targets.length} repositories, ref ${effectiveRef}${dryRun ? ' (dry run)' : ''}`);

  const report = [];
  for (const repo of targets) {
    if (repo === SELF_REPO) {
      report.push({ repo, status: 'skipped', reason: 'self', baseBranch: null, ciName: null, alreadyInstalled: false });
      logLine(logger, `  ${repo}: skipped (self)`);
      continue;
    }

    const detected = ciWorkflowName
      ? { default_branch: null, ci_workflow_name: ciWorkflowName, detected: { ci_workflow_name: true } }
      : await autodetectRepoDefaults(cap, repo);
    const baseBranch = detected.default_branch || (await ghJson(cap, 'GET', `/repos/${repo}`)).default_branch;

    const plan = await planRepo({
      github: cap,
      repo,
      detected,
      baseBranch,
      autofixRef: effectiveRef,
      ciName: ciWorkflowName || null,
      withCleanup,
    });

    if (plan.status === 'skipped') {
      report.push(plan);
      logLine(logger, `  ${repo}: skipped (${plan.reason})`);
      continue;
    }

    if (dryRun) {
      report.push({ ...plan, dryRun: true });
      logLine(logger, `  ${repo}: ${plan.alreadyInstalled ? 'already installed' : 'would open a PR'} for "${plan.ciName}" @ ${baseBranch}`);
      continue;
    }

    // R-17: registration must not be a hidden prerequisite. Register when missing,
    // re-use the existing record when present (its install state is preserved).
    if (!getAutofixRegistration({ profileId, root, repo })) {
      registerAutofix({
        profileId,
        root,
        registration: {
          repo,
          base_branch: baseBranch,
          features: { fix: true, cleanup: withCleanup, batch: false },
          autofix_ref: effectiveRef,
          ci_workflow_name: plan.ciName,
        },
      });
    }

    const result = await installAutofixWorkflow({
      profileId,
      root,
      repo,
      base_branch: baseBranch,
      autofix_ref: effectiveRef,
      ci_workflow_name: plan.ciName,
      github: cap,
    });

    const entry = {
      repo,
      status: result.changed ? 'pr_opened' : 'installed',
      reason: result.reason,
      baseBranch,
      ciName: plan.ciName,
      ciPath: plan.ciPath,
      alreadyInstalled: !result.changed,
      pr: result.pr,
    };
    report.push(entry);
    logLine(logger, `  ${repo}: ${entry.status}${entry.pr ? ` (${entry.pr.url})` : ''}`);
  }

  const summary = {
    total: report.length,
    pr_opened: report.filter((row) => row.status === 'pr_opened').length,
    installed: report.filter((row) => row.status === 'installed').length,
    skipped: report.filter((row) => row.status === 'skipped').length,
  };
  logLine(logger, `pr-autofix rollout: ${summary.pr_opened} PR(s) opened, ${summary.installed} already installed, ${summary.skipped} skipped`);
  return { ref: effectiveRef, dryRun, summary, report };
}

module.exports = {
  SELF_REPO,
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  assertRolloutRef,
  rolloutAutofix,
  inventoryRepos,
  normalizeRepoList,
  runsOnPullRequest,
  selectCiWorkflow,
};
