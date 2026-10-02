'use strict';

// Shared pr-autofix service constants (slice 2a). Kept in its own module so the
// registration store and the workflow installer agree on defaults without a
// circular require.

// The pinned pr-autofix revision is an *immutable* ref. A concrete version tag
// (vX.Y.Z) or a full commit SHA is accepted; floating refs (main, v1, HEAD,
// latest) are rejected so an installed job cannot silently drift.
const DEFAULT_AUTOFIX_REF = 'v1.6.0';

const IMMUTABLE_REF = /^(?:v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|[0-9a-f]{40})$/;

// `workflow_run.workflows` matches the target repo CI workflow's `name:` (not
// its filename), which is why the install tool exposes `ci_workflow_name`.
const DEFAULT_CI_WORKFLOW_NAME = 'CI';

const WORKFLOW_PATH = '.github/workflows/pr-autofix.yml';
const CLEANUP_WORKFLOW_PATH = '.github/workflows/ci-fix-cleanup.yml';

// A single deterministic install branch keeps re-installs idempotent and makes
// the open install PR discoverable for updates.
const INSTALL_BRANCH = 'pr-autofix/install';

// Rollout default (issue #95, R-18). Distinct from DEFAULT_AUTOFIX_REF on purpose:
// the installer's default is the tool's own historical baseline, while the org has
// exactly one ref proven end-to-end. A rollout that silently pinned anything else
// is how a 25-repo adoption turns into 25 broken pins.
const ROLLOUT_DEFAULT_AUTOFIX_REF = 'v1.7.8';

// v1.7.4…v1.7.7 shipped the R1/R2 iteration-4 regressions, fixed in v1.7.8
// (pr-autofix R-15). The org scan in R-15 found no consumer pinned to the window,
// so a ref from it is always a mistake, never a legitimate choice.
const DEFECTIVE_AUTOFIX_REFS = new Set(['v1.7.4', 'v1.7.5', 'v1.7.6', 'v1.7.7']);

// The org inventory is the source of truth for "which repositories exist". The
// rollout reads it instead of hard-coding a list that drifts the day a repo is
// created or renamed.
const INVENTORY_REPO = 'trained-assist/trained-agent-architecture';
const INVENTORY_PATH = 'docs/inventory/repo-coverage.json';

module.exports = {
  DEFAULT_AUTOFIX_REF,
  IMMUTABLE_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  INSTALL_BRANCH,
  ROLLOUT_DEFAULT_AUTOFIX_REF,
  DEFECTIVE_AUTOFIX_REFS,
  INVENTORY_REPO,
  INVENTORY_PATH,
};
