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

module.exports = {
  DEFAULT_AUTOFIX_REF,
  IMMUTABLE_REF,
  DEFAULT_CI_WORKFLOW_NAME,
  WORKFLOW_PATH,
  CLEANUP_WORKFLOW_PATH,
  REQUIRED_CALLABLES,
  AUTOFIX_OWNER,
  INSTALL_BRANCH,
};
