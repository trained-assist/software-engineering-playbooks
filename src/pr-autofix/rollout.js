'use strict';

// Batch rollout of the pr-autofix workflow (issue #95).
//
// Before this module, adopting pr-autofix in one repository was a five-step manual
// procedure with three hidden traps: call `engineering_pr_autofix_register`, then
// `engineering_pr_autofix_install` (which hard-fails NOT_FOUND without the first),
// pass the one known-good ref by hand (the installer default and the coverage table
// both point elsewhere), get a human to review and merge the install PR, and finally
// regenerate the coverage table that the install itself turned red. Across 25
// repositories that is 18 repetitions of the same dance.
//
// `rolloutAutofix()` is the "раз и вжик" replacement: one call, driven by the org
// inventory, that registers what is missing, installs with the known-good ref, detects
// the CI workflow name instead of assuming it, and prints a per-repo status table.
// `--dry-run` does every read and prints the plan without a single write.
//
// Transport-neutral like the installer: all GitHub access goes through an injected
// capability with `ghFetch`, so tests use an in-memory fake.

const { fail } = require('./errors');
const {
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  INVENTORY_REPO,
  INVENTORY_PATH,
} = require('./constants');
const { registerAutofix, getAutofixRegistration } = require('./registry');
const { installAutofixWorkflow, buildWorkflowFiles, filesMatch, assertAutofixRef } = require('./installer');

// A rollout never installs the tool into itself: pr-autofix is the fixer, not a
// consumer, and a self-referential workflow_run trigger cannot fire.
const SELF_REPO = 'trained-assist/pr-autofix';

function logLine(logger, line) {
  if (typeof logger === 'function') logger(line);
}

async function ghJson(github, method, endpoint, body) {
  const res = await github.ghFetch(method, endpoint, body);
  if (!res.ok) {
    const detail = res.data && (res.data.message || res.data.error);
    fail('GITHUB_ERROR', `GitHub ${method} ${endpoint} failed with status ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.data === undefined ? null : res.data;
}

async function defaultBranch(github, repo) {
  const data = await ghJson(github, 'GET', `/repos/${repo}`);
  const branch = data && data.default_branch;
  if (!branch) fail('NOT_FOUND', `could not resolve the default branch of ${repo}`);
  return branch;
}

// `workflow_run.workflows` matches the target repo CI workflow by its `name:`, not by
// its filename, so the rollout must read the file to learn the name. Only a
// top-level `name:` counts — a nested job name would silently never trigger.
function workflowNameFromContent(content) {
  for (const line of String(content).split('\n')) {
    if (!line.startsWith('name:')) continue;
    return line.slice('name:'.length).trim().replace(/^["']|["']$/g, '') || null;
  }
  return null;
}

async function listWorkflowNames(github, repo) {
  const res = await github.ghFetch('GET', `/repos/${repo}/contents/.github/workflows`);
  // A repository with no workflows directory is a valid "nothing to watch" answer,
  // not an error — the rollout must plan the whole inventory, not stop at the first
  // repository that has no CI.
  if (res.status === 404) return [];
  if (!res.ok) {
    const detail = res.data && (res.data.message || res.data.error);
    fail('GITHUB_ERROR', `GitHub GET /repos/${repo}/contents/.github/workflows failed with status ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = res.data;
  if (!Array.isArray(data)) return [];
  const names = [];
  for (const entry of data) {
    if (!entry || entry.type !== 'file' || typeof entry.name !== 'string') continue;
    if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;
    names.push(entry.name);
  }
  return names.sort();
}

async function readWorkflow(github, repo, fileName) {
  const data = await ghJson(github, 'GET', `/repos/${repo}/contents/.github/workflows/${fileName}`);
  if (!data || typeof data.content !== 'string') return null;
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

// Find the CI workflow the installed job should watch. `preferred` is the name to
// look for first (default "CI"); when the repo uses a different name, the caller can
// pass it explicitly. Returns null when the repository has no CI workflow at all —
// there is nothing to trigger on, so installing would be a no-op that looks green.
//
// When no explicit name was requested and the preferred one is absent, fall back to
// the first workflow that actually runs on pull requests. Watching a repo's real CI
// name beats skipping: an installed job that never fires is a silent failure, and the
// rollout report shows which file was chosen.
async function detectCiWorkflow(github, repo, { preferred, allowFallback = true } = {}) {
  const wanted = preferred || DEFAULT_CI_WORKFLOW_NAME;
  const entries = [];
  for (const fileName of await listWorkflowNames(github, repo)) {
    const content = await readWorkflow(github, repo, fileName);
    if (content === null) continue;
    entries.push({ fileName, content, name: workflowNameFromContent(content) });
  }
  const exact = entries.find((entry) => entry.name === wanted);
  if (exact) return { name: wanted, file: exact.fileName, matched: 'exact' };
  if (preferred || !allowFallback) return null;
  const prWorkflow = entries.find((entry) => /^\s*pull_request\s*:/m.test(entry.content) && entry.name);
  if (prWorkflow) return { name: prWorkflow.name, file: prWorkflow.fileName, matched: 'fallback' };
  return null;
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
  return repos;
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

// Read-only per-repo plan. Shared by `--dry-run` and the live path so the plan that was
// printed is exactly what gets executed.
async function planRepo({ github, repo, baseBranch, autofixRef, ciName, withCleanup }) {
  const ci = ciName
    ? { name: ciName, file: null, matched: 'explicit' }
    : await detectCiWorkflow(github, repo, {});
  if (!ci) {
    return { repo, status: 'skipped', reason: 'no_ci_workflow', baseBranch, ciName: null, alreadyInstalled: false };
  }
  const desired = buildWorkflowFiles({
    repo,
    autofix_ref: autofixRef,
    ci_workflow_name: ci.name,
    features: { fix: true, cleanup: withCleanup },
  });
  const alreadyInstalled = await filesMatch(github, repo, desired, baseBranch);
  return {
    repo,
    status: alreadyInstalled ? 'installed' : 'pr_opened',
    reason: alreadyInstalled ? 'already_pinned' : null,
    baseBranch,
    ciName: ci.name,
    ciFile: ci.file,
    ciMatched: ci.matched,
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

  // R-18: the rollout pins the one ref the org has proven end-to-end. An explicit
  // override is honoured, but the defective window is refused either way.
  const effectiveRef = assertAutofixRef(autofixRef || ROLLOUT_DEFAULT_AUTOFIX_REF);

  const targets = repos ? normalizeRepoList(repos) : await inventoryRepos(cap, { inventoryRepo, inventoryPath });
  logLine(logger, `pr-autofix rollout: ${targets.length} repositories, ref ${effectiveRef}${dryRun ? ' (dry run)' : ''}`);

  const report = [];
  for (const repo of targets) {
    if (repo === SELF_REPO) {
      report.push({ repo, status: 'skipped', reason: 'self', baseBranch: null, ciName: null, alreadyInstalled: false });
      logLine(logger, `  ${repo}: skipped (self)`);
      continue;
    }

    const baseBranch = await defaultBranch(cap, repo);
    const plan = await planRepo({
      github: cap,
      repo,
      baseBranch,
      autofixRef: effectiveRef,
      ciName: ciWorkflowName,
      withCleanup,
    });

    if (plan.status === 'skipped') {
      report.push(plan);
      logLine(logger, `  ${repo}: skipped (${plan.reason})`);
      continue;
    }

    if (dryRun) {
      report.push({ ...plan, dryRun: true });
      logLine(logger, `  ${repo}: would ${plan.alreadyInstalled ? 'keep' : 'open a PR for'} ${plan.ciName} @ ${baseBranch}`);
      continue;
    }

    // R-17: registration must not be a hidden prerequisite. Register when missing,
    // re-use the existing record when present (its install state is preserved).
    const existing = getAutofixRegistration({ profileId, root, repo });
    if (!existing) {
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
      ciFile: plan.ciFile,
      ciMatched: plan.ciMatched,
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
  rolloutAutofix,
  inventoryRepos,
  detectCiWorkflow,
  defaultBranch,
  workflowNameFromContent,
  normalizeRepoList,
};
