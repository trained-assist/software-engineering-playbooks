# pr-autofix as a service — design

Status: **draft** (design-only; no code). Issue: trained-assist-engineering#12.
Related: `docs/INTEGRATION.md`, `docs/GITHUB-ONBOARDING.md`, standalone `trained-assist/pr-autofix`.

## Problem

`trained-assist/pr-autofix` is a standalone GitHub Actions pipeline: a callable workflow
(`.github/workflows/autofix-callable.yml@v1`), the fixer (`scripts/autofix.mjs`) and templates
(`ci-fix-cleanup.yml`, `batch-fix-prs.yml`). It works, but every consuming repository must wire it
**by hand** — paste an `autofix` job into its `ci.yml` and add two repo secrets
(`OPENROUTER_API_KEY`, `AUTOFIX_PAT`). There is no registration, no credential binding, no
lifecycle, no observability. That is the gap this service closes.

## Principles (reuse, don't reinvent)

- Use `trained-assist-agent`'s existing **provider/source registry** (`provider-manifest.json`,
  immutable artifact, revision pinning, per-profile allowlist, action policy) — per
  `docs/INTEGRATION.md`. Do **not** add a second loader.
- Use the existing **credential-binding flow**: a feature requests a *capability*, Engineering's
  credential adapter calls ZeroCreds, then a capability probe runs before activation
  (`docs/GITHUB-ONBOARDING.md`). Engineering owns onboarding/policy; ZeroCreds owns the handoff.
- **Invariant:** raw credentials never enter Task Packets, indexes, prompts, project manifests or
  logs. Only *capability records* are persisted; secrets live in ZeroCreds / the target repo's
  Actions secrets.
- Transport-neutral core first (a library), with MCP/CLI/GitHub-Actions as thin transports.

## 1. Registration model

A registration is keyed by `(profileId, repo)` and stored as engineering state (not a secret):

```jsonc
{
  "profileId": "...",
  "repo": "owner/name",
  "base_branch": "main",
  "features": { "fix": true, "cleanup": true, "batch": false },
  "autofix_ref": "v1",              // pinned pr-autofix revision/tag
  "capabilities": { "github": "bound", "openrouter": "bound" },
  "status": "registered",           // registered → credentials_bound → workflow_installed → active → disabled|error
  "credential_refs": { "github": "<zerocreds-ref>", "openrouter": "<zerocreds-ref>" },
  "installed_workflow": null,       // { path, pinned_ref, installed_at } once slice 2 lands
  "created_at": 0, "updated_at": 0
}
```

- `register` is an **idempotent upsert**; it never auto-enables anything.
- `disable` sets `status: "disabled"` and (slice 2) proposes removal of the installed job.
- Registration alone persists no secret and performs no external write.

## 2. Credential binding

The fixer runs **inside the target repo's GitHub Actions**, so its tokens must reach that repo's
Actions secrets. Requested capabilities (not scopes):

| capability | why | maps to (pr-autofix terms) |
|---|---|---|
| read repo metadata | resolve repo/base, probe access | `Contents: read` |
| read PRs + checks | diagnose the failing run | `Pull requests: read` |
| update a PR branch | push `fix/ci-*` | `Contents: write` |
| create/close PRs | open fix PR, close original | `Pull requests: write` |
| run inference | model stages | `OPENROUTER_API_KEY` |

Flow:

```text
pr_autofix_register
  -> engineering credential adapter
  -> requestCredential({ provider: "github", purpose: "pr_autofix", requestedCapabilities })
  -> ZeroCreds secure handoff
  -> capability probe (repo reachable? PR/checks readable? push allowed?)
  -> persist capability record (NOT the secret)
  -> deliver secret to target repo Actions secrets (encrypted with the repo public key)
```

Two open points, deliberately not guessed here:

- **Delivery path.** Writing `AUTOFIX_PAT`/`OPENROUTER_API_KEY` to a target repo's Actions secrets
  needs an admin-scoped token (`secrets: write`) and explicit user consent. A hosted relay that
  injects the credential at run time would avoid writing repo secrets, but adds infrastructure;
  evaluate before slice 2.
- **OpenRouter key ownership.** A shared platform key is simplest; a per-profile key is cleaner for
  accounting. Decide with the credential contract.

## 3. Workflow install / update

- Install a dedicated `.github/workflows/pr-autofix.yml` in the target repo (keeps the fixer's job
  isolated from the repo's own `ci.yml`), pinned to `trained-assist/pr-autofix@<autofix_ref>`.
- Preferred transport: **open a PR to the target repo** (reviewable, reversible). Direct
  Contents-API commit only for repos we own and have explicitly marked trusted.
- Also install `ci-fix-cleanup.yml` when `features.cleanup`.
- Idempotent by construction: detect an existing pinned job; "upgrade" = bump the ref; never
  duplicate. Uninstall = remove the file via the same transport.

### 3.1 Installed file: `workflow_run` shape (slice 2a)

The callable only fixes a PR whose CI failed. Rather than editing an arbitrary `ci.yml` (fragile,
review-hostile), slice 2a installs a **dedicated** `.github/workflows/pr-autofix.yml` that triggers
on `on: workflow_run` of the target repo's CI workflow (`types: [completed]`) and delegates to
`trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@<immutable ref>`.

- The watched workflow is matched by its **`name:`** (GitHub's `workflow_run.workflows` semantics,
  not the filename), configured per registration as `ci_workflow_name` (default `"CI"`).
- A job-level `if` guards on: the run concluded `failure`, the run came from a `pull_request`, a PR
  is attached, and the head branch is not already a `fix/ci-*` branch (prevents fix loops).
- `autofix_ref` must be an **immutable** version tag (`vX.Y.Z`) or a full commit SHA; floating refs
  (`v1`, `main`, `HEAD`) are rejected. Install/update opens a reviewable PR to the target repo
  (base = `base_branch`); an identical pinned job is a no-op and a ref bump updates the PR.
- The install PR references `OPENROUTER_API_KEY` / `AUTOFIX_PAT` by name only. Writing those repo
  secrets is slice 2b (approval-gated); slice 2a never touches credentials.

## 4. Lifecycle & observability

- State machine as in §1. Transitions only on verified probes, never on assumption.
- Track `last_fix_attempt` (run id, result) by consuming pr-autofix run events or polling the
  target repo; surface failures to the owner via the existing bot delivery (never silently).
- **Kill-switch:** `disable` stops new fix attempts (remove the job) and records the reason; it does
  not touch already-open fix PRs.

## 5. Public contract (tools)

Follow the platform action contract (`effect` / `requiresApproval` / `retrySafety`):

| tool | effect | approval | notes |
|---|---|---|---|
| `pr_autofix_register` | write (eventually external: secrets + PR) | **required** once it writes | slice 1 = local state only, no approval needed |
| `pr_autofix_status` | read | no | list registrations + state |
| `pr_autofix_disable` | write | **required** once it removes the job | slice 1 = local state only |

## 6. First implementable slice (additive, zero credentials writes)

1. Engineering **core library**: registration store + state machine (no external writes), capability
   contract stub, `pr_autofix_register/status/disable` operating on local state.
2. MCP tools exposing those three operations (read-mostly), behind the provider mechanism.
3. Tests: upsert idempotency, per-profile isolation, disable, and that no code path writes a secret.

Nothing is installed into any repo and no credential is written in slice 1, so nothing that works
today can regress.

Slice 2 = workflow install (PR-to-repo) + secret delivery via ZeroCreds. Slice 3 = run-event
lifecycle + owner notifications.

## 7. Risks / out of scope

- **Secrets write is privileged** (`secrets: write`): approval + audit are mandatory; a bug here is
  high-impact. Keep it out of slice 1.
- **GitHub Actions needs repo secrets** (or a relay); the "capability, not secret" ideal collides
  with the fixer's in-Actions execution model — resolved by §2 open points.
- pr-autofix uses free models — failure/flakiness is expected; the service must surface, not hide it.
- Out of scope: reimplementing the fixer; auto-enabling autofix on any repo; changes to the agent's
  own CI; the Merge Relay worker (separate deployable, see `docs/GITHUB-ONBOARDING.md`).
