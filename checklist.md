# Checklist — pr-autofix service slice 2a: workflow install/update (issue #17)

Design: `docs/PR-AUTOFIX-SERVICE.md` §3 (workflow install/update), §3.1 (workflow_run shape).
Additive; one external write (a PR to the target repo); **no** credential/Actions-secret writes.

## Goal

Let the service install/update the pr-autofix workflow in a target repository cleanly and
idempotently, replacing per-repo hand-wiring — without touching credentials (that is slice 2b).

## Definition of done

- [x] CI green on https://github.com/trained-assist/trained-assist-engineering/pull/18
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Slices

- [x] Installer core (`src/pr-autofix/installer.js` + `constants.js`): build the pinned
      `.github/workflows/pr-autofix.yml` (+ `ci-fix-cleanup.yml` when `features.cleanup`) and open /
      update a PR through an injected `ghFetch`/`ghToken` capability (tests use a fake, no network).
      Idempotent: identical pinned job → no PR; ref bump → update PR; one deterministic install
      branch.
- [x] Trigger choice: dedicated `workflow_run` of the target CI workflow (`types: [completed]`,
      matched by `ci_workflow_name`, default `"CI"`), guarded on failed + pull_request + non-`fix/ci-*`.
- [x] Immutable pinning: `autofix_ref` must be `vX.Y.Z` or a 40-hex SHA; floating refs rejected;
      default `v1.2.1`.
- [x] Tool `engineering_pr_autofix_install` + provider manifest (`requiresApproval: true`),
      `status → workflow_installed`, `installed_workflow { path, pinned_ref, installed_at, pr_url }`.
- [x] `engineering_pr_autofix_status` reflects `installed_workflow`; `disable` unchanged.
- [x] Tests: one PR with pinned callable job, second install no-op, open-PR ref bump, post-merge ref
      bump opens new PR, identical job present → no PR, cleanup workflow, configurable CI name,
      immutability/disabled/unregistered errors, no-secret invariant (incl. token rejected in
      `installed_workflow`), MCP round-trip + `GITHUB_NOT_CONFIGURED`.
- [x] `npm run check`, `npm test`, `npm run manifest:check`

## Non-goals (slice 2b, separate + approval-gated)

ZeroCreds credential binding and pushing `OPENROUTER_API_KEY` / `AUTOFIX_PAT` to repo Actions
secrets; run-event lifecycle/notifications; `disable` removing the installed workflow.
