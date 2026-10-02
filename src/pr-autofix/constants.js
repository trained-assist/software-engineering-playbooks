'use strict';

// Shared pr-autofix service constants (slice 2a). Kept in its own module so the
// registration store and the workflow installer agree on defaults without a
// circular require.

// The pinned pr-autofix revision is an *immutable* ref. A concrete version tag
// (vX.Y.Z) or a full commit SHA is accepted; floating refs (main, v1, HEAD,
// latest) are rejected so an installed job cannot silently drift.
// Must name a ref where every reusable workflow this service installs IS callable
// (see REQUIRED_CALLABLES). v1.7.2 predates the cleanup callable: installing against it
// produced a green PR whose cleanup job could never resolve in GitHub. The installer
// verifies this before opening anything, so a bad pin fails here rather than in the org.
const DEFAULT_AUTOFIX_REF = 'v1.7.4';

const IMMUTABLE_REF = /^(?:v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|[0-9a-f]{40})$/;

// `workflow_run.workflows` matches the target repo CI workflow's `name:` (not
// its filename), which is why the install tool exposes `ci_workflow_name`.
// It is a *pattern* filter, so the installer escapes glob metacharacters in the
// name before emitting it — see escapeWorkflowFilterPattern in installer.js and
// issue #120 (`CI + Deploy` matched nothing, so the trigger never fired).
const DEFAULT_CI_WORKFLOW_NAME = 'CI';

const WORKFLOW_PATH = '.github/workflows/pr-autofix.yml';
const CLEANUP_WORKFLOW_PATH = '.github/workflows/ci-fix-cleanup.yml';

// Reusable workflows an installed repo will reference via `uses: …@<ref>`. Every one of
// them must exist AT that ref, otherwise GitHub rejects the consuming workflow file.
// Checked before install — an unresolvable `uses:` is a 5-minute round trip and a red PR.
const REQUIRED_CALLABLES = [
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
];

const AUTOFIX_OWNER = 'trained-assist/pr-autofix';

// A single deterministic install branch keeps re-installs idempotent and makes
// the open install PR discoverable for updates.
const INSTALL_BRANCH = 'pr-autofix/install';

// Rollout default (issue #95, R-18). Distinct from DEFAULT_AUTOFIX_REF on purpose:
// that one is the installer's historical baseline, while the org has exactly one ref
// proven end-to-end. A rollout that silently pinned anything else is how a 25-repo
// adoption turns into 25 pins nothing has verified.
const ROLLOUT_DEFAULT_AUTOFIX_REF = 'v1.7.8';

// v1.7.4…v1.7.7 shipped the R1/R2 iteration-4 regressions, fixed in v1.7.8
// (pr-autofix R-15). The org scan in R-15 found no consumer pinned to the window.
const DEFECTIVE_AUTOFIX_REFS = new Set(['v1.7.4', 'v1.7.5', 'v1.7.6', 'v1.7.7']);

// The org inventory is the source of truth for "which repositories exist". The
// rollout reads it instead of hard-coding a list that drifts the day a repo is
// created, renamed or added to the org.
const INVENTORY_REPO = 'trained-assist/trained-agent-architecture';
const INVENTORY_PATH = 'docs/inventory/repo-coverage.json';

module.exports = {
  DEFAULT_AUTOFIX_REF,
  IMMUTABLE_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  REQUIRED_CALLABLES,
  AUTOFIX_OWNER,
  INSTALL_BRANCH,
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  DEFECTIVE_AUTOFIX_REFS,
  INVENTORY_REPO,
  INVENTORY_PATH,
};
