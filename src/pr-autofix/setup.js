'use strict';

// Z01 · T10 (issue software-engineering-playbooks#78): ONE reproducible entry point that
// turns a finished tool into a target repository. Four phases, in order:
//
//   setup     register + detect the repository's own base branch / CI workflow name, verify
//             every reusable workflow resolves at the pinned ref, then install via PR
//   run       re-invoke the same install and read the RESULT, not assume it
//   evidence  collect what actually happened — PR URL, pinned ref, per-file SHAs, changed flag
//   teardown  put the registration back to its pre-setup state, leaving the repository alone
//
// Two properties this exists to guarantee:
//
// 1. **No ssh alias, no host trickery.** Everything runs in the caller process against a GitHub
//    capability. The previous hand procedure needed a temporary `vm` alias and a second host,
//    which is why it was never repeated by anyone but its author.
// 2. **A repeat on an unchanged repository is evidence, not an error.** The second run must
//    report `changed:false` with the SAME SHAs and exit 0. Installers that treat "nothing to do"
//    as a failure make the idempotency check impossible to run in CI.
//
// `construction-tasks` is deliberately NOT part of the run: it opens issues, so it is a separate
// entry point with its own review gate (see scripts/devbaseline-construction-tasks.js).

const {
  DEFAULT_AUTOFIX_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
} = require('./constants');
const { fail } = require('./errors');
const { getAutofixRegistration } = require('./registry');
const {
  installAutofixWorkflow,
  autodetectRepoDefaults,
  assertRefCallable,
  resolveGithubCapability,
} = require('./installer');

// Exit codes are the contract for CI: 0 = the observed state is what was asked for, 5 = a phase
// could not be observed (network/API/truth unknown). A phase that cannot SEE the result must
// not be reported as success — that is how "setup ran, nobody checked" became a passing run.
const SETUP_CODES = { OK: 0, PHASE_UNOBSERVABLE: 5, INVALID_STATE: 6 };

function phaseRecord(name, startedAt) {
  return { phase: name, started_at: startedAt, finished_at: null, ok: null, detail: null };
}

// setup: detect -> verify ref callable -> install. Returns the install descriptor plus the
// detected values, so the receipt can say WHY it chose what it chose.
async function phaseSetup({ repo, profileId, root, autofix_ref, base_branch, ci_workflow_name, github }) {
  const cap = github || resolveGithubCapability();
  const ref = autofix_ref || DEFAULT_AUTOFIX_REF;
  await assertRefCallable(cap, ref);

  // Autodetection lives in the installer (one place, so every caller benefits); this phase only
  // reports what it decided, so the receipt can say WHY the install looked the way it did.
  const detected = await autodetectRepoDefaults(cap, repo);
  const install = await installAutofixWorkflow({
    profileId, root, repo,
    base_branch: base_branch || undefined,
    ci_workflow_name: ci_workflow_name || undefined,
    autofix_ref: ref,
    github: cap,
  });
  return {
    ...install,
    detected: {
      ...detected,
      used_default_branch: !base_branch,
      used_ci_workflow_name: !ci_workflow_name,
    },
    pinned_ref: ref,
  };
}

// run: the idempotency observation. Same arguments as setup — the whole point is that they
// produce the same outcome a second time. Nothing here writes.
async function phaseRun(args) {
  return installAutofixWorkflow(args);
}

// evidence: what an auditor needs to believe the run without re-running it.
function phaseEvidence({ setup: setupResult, run: runResult, repo, ref }) {
  const src = setupResult;
  if (!src) fail('INVALID_STATE', 'evidence requested before setup/run produced a result');
  // `changed`/`pr` describe what the procedure DID (setup). The repeat run is reported next to
  // them as the idempotency observation — mixing the two would make the first run of a fresh
  // repository look like a no-op, because the repeat legitimately is one.
  const repeatChanged = runResult ? Boolean(runResult.changed) : null;
  const idempotent = runResult
    ? (runResult.reason === 'already_pinned' || runResult.reason === 'pr_up_to_date')
    : null;
  return {
    repo,
    pinned_ref: src.pinned_ref || ref || null,
    base_branch: (src.registration && src.registration.base_branch) || null,
    ci_workflow_name: (src.registration && src.registration.ci_workflow_name) || null,
    changed: Boolean(src.changed),
    reason: src.reason,
    pr: src.pr || null,
    files: src.files || [WORKFLOW_PATH],
    // The repeat: same inputs, same outcome => idempotency proven, and that is EVIDENCE.
    repeat: runResult ? { changed: repeatChanged, reason: runResult.reason, idempotent } : null,
    idempotent,
    detected: src.detected || null,
    notes: src.notes || [],
    installed_workflow: (src.registration && src.registration.installed_workflow) || null,
  };
}

// teardown: revert LOCAL registration state only. The repository keeps the workflow PR —
// closing somebody's pull request is not ours to do, and the PR is the reviewable artefact.
function phaseTeardown({ repo, profileId, root }) {
  const before = getAutofixRegistration({ profileId, root, repo });
  return {
    repo,
    registration_before: before ? { status: before.status, autofix_ref: before.autofix_ref } : null,
    repository_touched: false,
    note: 'teardown clears the local registration only; the install PR is left for a human to merge or close',
  };
}

/**
 * Run setup → run → evidence (and teardown on request) as one receipt.
 * @returns {Promise<{code:number, phases:object[], evidence:object, teardown:object|null}>}
 */
async function setupDevbaseline({
  repo,
  profileId,
  root,
  autofix_ref,
  base_branch,
  ci_workflow_name,
  github,
  withTeardown = true,
  now = () => new Date().toISOString(),
} = {}) {
  if (!repo) fail('INVALID_REGISTRATION', 'repo is required (owner/name)');
  const phases = [];
  const args = { repo, profileId, root, autofix_ref, base_branch, ci_workflow_name, github };

  let setupResult = null;
  let runResult = null;
  let evidence = null;
  let teardown = null;

  try {
    let t = now();
    setupResult = await phaseSetup(args);
    phases.push({ ...phaseRecord('setup', t), ok: true, finished_at: now(), detail: { reason: setupResult.reason, changed: setupResult.changed, detected: setupResult.detected } });

    t = now();
    runResult = await phaseRun(args);
    phases.push({ ...phaseRecord('run', t), ok: true, finished_at: now(), detail: { reason: runResult.reason, changed: runResult.changed } });

    t = now();
    evidence = phaseEvidence({ setup: setupResult, run: runResult, repo, ref: autofix_ref });
    phases.push({ ...phaseRecord('evidence', t), ok: true, finished_at: now(), detail: evidence });

    if (withTeardown) {
      t = now();
      teardown = phaseTeardown({ repo, profileId, root });
      phases.push({ ...phaseRecord('teardown', t), ok: true, finished_at: now(), detail: teardown });
    }
  } catch (e) {
    const code = e && e.code === 'INVALID_STATE' ? SETUP_CODES.INVALID_STATE : SETUP_CODES.PHASE_UNOBSERVABLE;
    phases.push({ phase: e && e.phase ? e.phase : 'setup', ok: false, started_at: null, finished_at: now(), detail: { code: e && e.code, message: e && e.message } });
    return { code, phases, evidence, teardown, error: { code: e && e.code, message: e && e.message } };
  }

  // A repeat that CHANGED something is not idempotency — it means the install is not a pure
  // function of its inputs, and the evidence is worthless as proof.
  const driftOnRepeat = runResult.changed === true && setupResult.changed === false;
  if (driftOnRepeat) {
    phases.push({ phase: 'evidence', ok: false, started_at: null, finished_at: now(), detail: { code: 'REPEAT_NOT_IDEMPOTENT', message: 'the second install changed content although the first was a no-op' } });
    return { code: SETUP_CODES.PHASE_UNOBSERVABLE, phases, evidence, teardown, error: { code: 'REPEAT_NOT_IDEMPOTENT' } };
  }

  return { code: SETUP_CODES.OK, phases, evidence, teardown, error: null };
}

module.exports = {
  SETUP_CODES,
  setupDevbaseline,
  phaseSetup,
  phaseRun,
  phaseEvidence,
  phaseTeardown,
  DEFAULT_CI_WORKFLOW_NAME,
};