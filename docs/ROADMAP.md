# Roadmap

## Phase 0 — Bootstrap and first acceleration

- raw-repository `prepare_task`;
- stable Task Packet contract;
- CLI + MCP adapters;
- existing external skill-source integration;
- GitHub onboarding contract through ZeroCreds;
- Merge Relay treated as an external API worker.

## Phase 1 — Repository index source

- nightly/incremental index builder;
- function/symbol definition and reference graph;
- module/dependency map;
- test-to-code relationships;
- architecture responsibility summaries;
- incremental refresh after merge;
- freshness/fallback semantics.

`prepare_task` external contract remains unchanged.

## Phase 2 — Work Admission / Engineering Scheduler

- `engineering_request_work`;
- atomic work reservation / lease;
- repo/domain/contract-aware WIP limits;
- decisions: CODE / RESEARCH / REVIEW / HELP / WAIT;
- release/yield + durable wait state.

## Phase 3 — Workspace Accelerator

E1 `code_ready` (done — see `docs/WORKSPACE-LIFECYCLE.md`):

- `spawnWorkspace()` (provider action `engineering_spawn_workspace`);
- exact-revision worktree from a registered source checkout, outside the live checkout;
- ownership/lease, idempotency, crash recovery;
- conservative release (`needs_review` on dirty/untracked/unpushed/stash/unknown remote).

E2 `runtime_ready` (planned):

- dependency cache reuse;
- isolated ports/temp DB/test users/logs;
- dev-server/health and process supervision;
- deterministic cleanup.

## Phase 4 — Fast Verify / Impact Analysis

- changed-file impact detection;
- affected tests;
- quick verification during iteration;
- full CI remains integration gate;
- cache reusable intermediate work.

## Phase 5 — Review and PR intelligence

Extract/adapt from `trained-assist-agent`:
- PR coherence;
- per-file coherence;
- specification/goal consistency;
- review evidence packet;
- conflict-risk detection against active changes.

## Phase 6 — Issue-to-PR orchestration

Extract/adapt current issue-fixer pipeline:
- selection;
- cheap relevance/fixability gate;
- task preparation;
- isolated coding execution;
- verification;
- PR creation;
- bounded retries and known-failure lookup.

## Phase 7 — CI / merge lifecycle and GitHub onboarding

- ZeroCreds-backed GitHub credential onboarding;
- capability validation before enabling features;
- integrate a token/API mode for the existing Merge Relay worker;
- harden Merge Relay: skip drafts, understand CI state, observable skip/wait/block reasons;
- reusable CI workflows/templates;
- bounded autofix attempts;
- integrate existing `trained-assist/pr-autofix` instead of duplicating it;
- merge admission / queue coordination through one integration owner.
- event-driven GitHub CI waiting (PR / linked issue / active repository checks), with authenticated webhook delivery, explicit subscription lifecycle, reconciliation and polling fallback — see [`ci-event-wait-epic`](user-scenarios/engineering/ci-event-wait-epic.md).

## Phase 8 — Engineering memory

- fingerprint known CI/build failures;
- diagnosis/fix/evidence records;
- deterministic lookup first, semantic lookup second;
- share across coding agents without replaying old chat history.

## Phase 9 — Repository Gardener

Cheap/background jobs identify friction for future coding agents:
- unclear ownership;
- duplicate patterns;
- stale docs;
- missing architecture checks;
- weak naming;
- repeated workaround;
- missing regression tests.

## Phase 10 — Specification / Product-owner layer

Move generic engineering task-shaping here:
- product-owner/task decomposition procedures;
- system-analysis templates;
- behavior/spec acceptance framing;
- pre-implementation challenge/review based on risk.

Domain-specific product knowledge remains in domain/product repos.
