# Requirements log

Living list of requirements/features and their status. Statuses: `реализовано`,
`отклонено (почему)`, `планируется`, `в работе`.

## Workspace accelerator (E1 / Track A, issue #3)

- [реализовано] `spawnWorkspace()` core: git worktree from exact committed revision via
  registered source checkout, outside the live checkout; no reset/stash/clean; dirty source not
  carried; unique branch/worktree without force; atomic metadata; verified HEAD → `code_ready`.
- [реализовано] Ownership/lease `(principal, repository, rootTaskId)` with lease generation;
  idempotency by operation key (repeat → same workspace / in-progress; incompatible args → conflict).
- [реализовано] `statusWorkspace()` and `releaseWorkspace()` via the same API.
- [реализовано] Crash recovery: reconcile provisioning intents with `git worktree list --porcelain`;
  orphans retained, never auto-deleted.
- [реализовано] Conservative release: dirty/untracked/unpushed/stash/unknown remote/delivery →
  retained/needs_review; squash-merge requires host delivery evidence; TTL is not `rm -rf`.
- [реализовано] Library-first boundary: no MCP dependency; binding is host-resolved; optional
  `allowedRoots` host policy; symlink/path escape rejected.
- [реализовано] CLI adapter (`workspace-spawn`/`workspace-status`/`workspace-release`/
  `workspace-reconcile`), tests, local proof script.
- [планируется] E2 `runtime_ready`: dependencies/cache, fixtures, ports, dev-server/health,
  supervision, cleanup.
- [отклонено (в этой задаче)] MCP runtime wiring, provider manifest/lockfile packaging,
  core handoff (cwd/env/resume) — Track B / A2, не нужны для библиотечных тестов и proof.

## Minimal self-service `engineering_spawn_workspace` (2026-09-26, revises PR #4's original design)

Requirements re-derived from the actual task (two agents under one profile silently corrupting
each other's shared git checkout/branch), not from the earlier multi-tenant/security-hardening plan
in trained-assist-agent#1353 that this originally inherited its shape from. See that issue's
2026-09-26 status block for the full reasoning; `spawnWorkspace()`'s crash-safe state machine
itself was judged genuinely earned complexity and is untouched.

- [реализовано] `layoutFor()` branch naming: `eng/<principal>-<rootTaskId>` (readable — a session
  or a human can tell whose task a branch/PR is by name) instead of an opaque `eng/ws-<hash>`.
  Uniqueness still comes from git's own `BRANCH_COLLISION` on the git-worktree layer, unchanged.
- [реализовано] `src/workspace/for-task.js`: `spawnWorkspaceForTask()` / `statusWorkspaceForTask()`
  / `releaseWorkspaceForTask()` — the actual session-facing surface. Takes only
  `{principal, repositoryUrl, rootTaskId}`; resolves `sourceCheckout` (clone-if-missing mirror,
  fetched on every call), `baseRevision` (default branch tip), `idempotencyKey` (= `rootTaskId`),
  `hostId` (= `os.hostname()`) automatically. `spawnWorkspace()`/`statusWorkspace()`/
  `releaseWorkspace()` remain available directly for callers that need the low-level fields.
- [отклонено] `rootTaskId` as a host-injected/hidden field — it's the session's own readable task
  label and a legitimate required argument, not something to hide (see #1353 thread).
- [отклонено] `allowedRoots` host-issued filesystem binding / "LLM must never set repo_path" as a
  hard requirement for this same-company, first-party repository — access is already gated by the
  calling profile's own git credentials. Deferred, not designed away: `allowedRoots` still exists
  and works in `spawnWorkspace()` if a less-trusted source ever needs it.

## MCP wrapper: `engineering_spawn_workspace` / `_status` / `_release` (issue #6)

- [реализовано] `src/mcp-skills/tools/20-workspace.js` exposes the three `for-task.js` functions as
  MCP tools, same shape as `engineering_prepare_task`. Inputs are only `repository_url` +
  `root_task_id` (spawn also `ref`; release adds `processes_stopped`/`force`/`delivery_evidence`).
  `principal` is never an argument — read from `process.env.USER_ID` inside the handler (matching
  trained-assist-agent's `mcpToolEnv`, so an argument can't override profile identity).
- [реализовано] Registered in `src/mcp-skills/registry.js`; `tests/mcp-workspace-tools.test.js`
  drives spawn→status→release through `registry.callTool()` against a bare-repo fixture, asserting
  env-wins and typed `INVALID_BINDING` errors for missing fields.
- [реализовано] Optional host override of workspace/mirror roots via
  `ENGINEERING_WORKSPACE_ROOT` / `ENGINEERING_MIRRORS_ROOT` (defaults to `~/agent-data/...`); needed
  so tests stay hermetic, and lets a host place workspaces outside the default home.

## Repository indexer v1 + engineering_repo_context + QA logs (issue #11)

- [реализовано] Deterministic index v1: `buildIndex()` writes `.engineering/index/`
  (`revision.json` with schemaVersion/repo identity/indexed revision/generatedAt; `files.json`;
  `modules.json` + hotspots; `symbols.json`; `tests.json`). No LLM; git tree metadata +
  regex symbol scan + test mapping + git-history hotspots. `scripts/index-repo.js`
  (`--check` for the refresh/check helper); `npm run index:build` / `index:check`.
- [реализовано] `prepare_task` keeps `prefer_index` (default true) but now rejects/falls back
  from an index that is missing, corrupt, schema-incompatible, for another repo, or stale for
  the current HEAD. Indexing is never a correctness dependency; raw fallback is untouched.
- [реализовано] `engineering_repo_context({repo_path, keywords, max_results?, budget?})`:
  queries a fresh index, otherwise the deterministic raw keyword ranking; returns ranked
  `{ path, line, snippet, why }`. No network, no LLM. Registered in the MCP registry +
  provider manifest.
- [реализовано] QA logs library: per-profile JSON registry at
  `ENGINEERING_QA_LOGS_ROOT/<profile>.json` (default `~/agent-data/qa-logs`), tools
  `qa_log_register` / `qa_log_lookup` / `qa_log_list`, profile from `USER_ID` (env wins).
  Entries store location + how-to-read only; a credential-material guard rejects secrets.
  Contract: `contracts/qa-log.schema.json`.
- [реализовано] CI contract: `tests/contract.test.js` guards registry↔provider-manifest drift
  and the dual context-source contract; `npm run manifest:check` validates the manifest against
  the registry.
- [отклонено (non-goals)] Embedding/vector index, nightly scheduler infra, credential binding,
  workspace-lifecycle changes. Semantic module summaries stay optional/off by default.

## pr-autofix service slice 1 — registration store + status (issue #15)

Design: `docs/PR-AUTOFIX-SERVICE.md` §1/§6. Additive, zero credential writes, no external GitHub
writes.

- [реализовано] `src/pr-autofix/registry.js`: per-profile JSON store keyed by `(profileId, repo)`
  at `ENGINEERING_PR_AUTOFIX_ROOT/<profile>.json` (default `~/agent-data/pr-autofix`). Record fields:
  `repo, base_branch, features{fix,cleanup,batch}, autofix_ref, capabilities, status,
  created_at, updated_at`. State enum `registered → credentials_bound → workflow_installed →
  active → disabled|error`; slice 1 only produces `registered`/`disabled`.
- [реализовано] `registerAutofix` = idempotent upsert (one record per repo, `created_at` stable,
  `updated_at` monotonic bump); it never lets the caller set `status` (no auto-enable) and keeps a
  `disabled` registration disabled. `disableAutofix` = kill-switch to `disabled`, idempotent.
- [реализовано] MCP tools `engineering_pr_autofix_register` / `_status` / `_disable`
  (`src/mcp-skills/tools/50-pr-autofix.js`), registered in the MCP registry + `provider-manifest.json`.
  Profile identity from `USER_ID` (env wins); local state only — no workflow install, no secret push.
  Descriptions note a later external-write slice will require approval.
- [реализовано] Capability records only: `capabilities` is a name→description map; a
  credential-material guard rejects raw secrets (`CREDENTIAL_REJECTED`) and no secret field is ever
  persisted. Contract: `contracts/pr-autofix-registration.schema.json`.
- [реализовано] Tests: upsert idempotency + `updated_at` bump, no-auto-enable, per-profile
  isolation, disable transition + idempotency, secret rejection/persistence guard, MCP env-identity
  round-trip; contract guards tool/manifest sync + schema enum.
- [отклонено (non-goals slice 1)] Workflow install, credential/secret delivery, `credential_refs` /
  `installed_workflow` fields, run-event lifecycle, notifications, reimplementing the fixer —
  slices 2/3.

## pr-autofix service slice 2a — workflow install/update, no credential writes (issue #17)

Design: `docs/PR-AUTOFIX-SERVICE.md` §3. Additive; external write = a PR to the target repo, but
**no** credential/Actions-secret writes.

- [реализовано] `src/pr-autofix/constants.js` + `installer.js`: given a registration and an injected
  GitHub capability (`ghFetch`/`ghToken`, injectable so tests never hit the network), builds
  `.github/workflows/pr-autofix.yml` pinned to an immutable `autofix_ref`, plus
  `.github/workflows/ci-fix-cleanup.yml` when `features.cleanup`. Opens a PR (base = `base_branch`)
  or updates the open install PR on `pr-autofix/install`. Idempotent: identical pinned job present
  → no PR; ref bump → update PR; deterministic single install branch.
- [реализовано] Trigger shape: dedicated `on: workflow_run` of the target CI workflow
  (`types: [completed]`), matched by `ci_workflow_name` (default `"CI"`, `workflow_run.workflows`
  uses the workflow `name:`, not filename). Job guard: failed run + pull_request event + a PR +
  head branch not `fix/ci-*`. `autofix_ref` must be `vX.Y.Z` or a 40-hex SHA; floating refs
  (`v1`, `main`, `HEAD`) are rejected (`INVALID_AUTOFIX_REF`). Default pinned ref `v1.2.1`.
- [реализовано] Tool `engineering_pr_autofix_install` (`{ repo, base_branch?, autofix_ref?,
  ci_workflow_name? }`), registered in the MCP registry + `provider-manifest.json` with
  `requiresApproval: true` (external write). On success advances `status` to `workflow_installed`
  and stores `installed_workflow { path, pinned_ref, installed_at, pr_url }`; `status` reflects it.
- [реализовано] GitHub capability resolved lazily from host env
  (`ENGINEERING_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN`) or an injected factory; the token is never
  persisted, returned or logged. `assertNoCredentialMaterial` still guards every write.
- [реализовано] Tests with an in-memory fake GitHub: exactly one PR with the pinned callable job,
  second install no-op, ref bump updates the open PR, post-merge bump opens a new PR, identical job
  present → no PR, cleanup workflow, immutable-ref + disabled/unregistered errors, status
  reflection, no-secret invariant, MCP round-trip + `GITHUB_NOT_CONFIGURED`.
- [отклонено (non-goals slice 2b)] ZeroCreds credential binding and pushing `OPENROUTER_API_KEY` /
  `AUTOFIX_PAT` to repo Actions secrets, run-event lifecycle, notifications, `disable` removing the
  installed workflow.
