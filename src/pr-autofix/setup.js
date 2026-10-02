'use strict';

const { DEFAULT_AUTOFIX_REF, DEFAULT_CI_WORKFLOW_NAME } = require('./constants');
const { fail } = require('./errors');
const { getAutofixRegistration, registerAutofix, restoreAutofixRegistration } = require('./registry');
const { installAutofixWorkflow, resolveGithubCapability } = require('./installer');
const SETUP_CODES = { OK: 0, PHASE_UNOBSERVABLE: 5, INVALID_STATE: 6 };

async function phaseSetup(args) { return installAutofixWorkflow(args); }
async function phaseRun(args) { return installAutofixWorkflow(args); }

async function observe(github, repo, result) {
  const branch = result.pr ? result.pr.head : result.base_branch;
  const ref = await github.ghFetch('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!ref.ok || !ref.data?.object?.sha) fail('OBSERVATION_FAILED', 'cannot observe installed revision');
  const sha = ref.data.object.sha;
  const files = {};
  for (const file of result.files) {
    const res = await github.ghFetch('GET', `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(sha)}`);
    if (!res.ok || !res.data?.sha) fail('OBSERVATION_FAILED', `cannot observe installed file ${file}`);
    files[file] = res.data.sha;
  }
  return { branch, sha, files };
}

function phaseEvidence({ setup, run, initial, repeated, repo }) {
  const idempotent = run.changed === false && initial.sha === repeated.sha
    && JSON.stringify(initial.files) === JSON.stringify(repeated.files);
  return {
    repo, pinned_ref: setup.pinned_ref, base_branch: setup.base_branch,
    ci_workflow_name: setup.ci_workflow_name, changed: setup.changed,
    reason: setup.reason, pr: setup.pr, files: setup.files, detected: setup.detected,
    source_sha: initial.sha, file_shas: initial.files,
    repeat: { changed: run.changed, changed_files: run.changed ? null : 0,
      reason: run.reason, sha: repeated.sha, file_shas: repeated.files, idempotent },
    idempotent,
  };
}

function phaseTeardown({ repo, profileId, root, before }) {
  const restored = restoreAutofixRegistration({ repo, profileId, root, before });
  if (JSON.stringify(restored) !== JSON.stringify(before)) fail('TEARDOWN_FAILED', 'registration was not restored');
  return { repo, registration_restored: true, repository_touched: false };
}

async function setupDevbaseline({ repo, profileId, root, autofix_ref = DEFAULT_AUTOFIX_REF,
  base_branch, ci_workflow_name, github, withTeardown = true,
  now = () => new Date().toISOString() } = {}) {
  if (!repo) fail('INVALID_REGISTRATION', 'repo is required (owner/name)');
  const before = getAutofixRegistration({ repo, profileId, root });
  const phases = [];
  let evidence = null, teardown = null, error = null, currentPhase = 'setup';
  const record = (phase, detail) => phases.push({ phase, ok: true, finished_at: now(), detail });
  try {
    const cap = github || resolveGithubCapability();
    if (!before) registerAutofix({ profileId, root, registration: {
      repo, features: { fix: true, cleanup: true, batch: true },
      autofix_ref, base_branch, ci_workflow_name,
    } });
    const args = { repo, profileId, root, autofix_ref, base_branch, ci_workflow_name, github: cap };
    const setup = await phaseSetup(args);
    const initial = await observe(cap, repo, setup);
    record('setup', { changed: setup.changed, reason: setup.reason, ...initial });
    currentPhase = 'run';
    const run = await phaseRun(args);
    const repeated = await observe(cap, repo, run);
    record('run', { changed: run.changed, reason: run.reason, ...repeated });
    currentPhase = 'evidence';
    evidence = phaseEvidence({ setup, run, initial, repeated, repo });
    if (!evidence.idempotent) fail('REPEAT_NOT_IDEMPOTENT', 'repeat changed files or revision');
    record('evidence', evidence);
  } catch (e) {
    error = { code: e.code || 'ERROR', message: e.message };
    phases.push({ phase: currentPhase, ok: false, finished_at: now(), detail: error });
  } finally {
    if (withTeardown) {
      try {
        teardown = phaseTeardown({ repo, profileId, root, before });
        record('teardown', teardown);
      } catch (e) {
        error = { code: 'TEARDOWN_FAILED', message: e.message };
        phases.push({ phase: 'teardown', ok: false, finished_at: now(), detail: error });
      }
    }
  }
  return { code: error ? SETUP_CODES.PHASE_UNOBSERVABLE : SETUP_CODES.OK, phases, evidence, teardown, error };
}
module.exports = { SETUP_CODES, setupDevbaseline, phaseSetup, phaseRun, phaseEvidence, phaseTeardown, DEFAULT_CI_WORKFLOW_NAME };
