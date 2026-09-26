# trained-assist-engineering

Reusable software-engineering control plane for the `trained-assist` ecosystem.

This repository exists to make coding agents **faster, safer and easier to coordinate** across many repositories and many concurrent tasks.

It is intentionally separate from product/runtime repositories such as `trained-assist-agent`, `trained-assist-web`, and future domain repositories.

Its job is not to serve end users. Its job is to improve how software is built.

---

## The simple idea

A Git branch is **not** an isolated working environment.

If several coding agents share one checkout:

```text
/home/vova/trained-assist-agent/
```

they also share the same physical working tree, untracked files, temporary files, runtime configs, test data, processes and ports.

Even if every agent creates its own branch, they can still interfere with each other:

```text
Agent A: git checkout feature-a
Agent B: git checkout feature-b
```

Both commands operate on the same directory.

That leads to the familiar failure modes:

- checkout conflicts;
- accidental carry-over of uncommitted changes;
- emergency stashes;
- duplicate or orphan branches;
- manually-created worktrees nobody owns;
- runtime files leaking into diffs;
- two dev servers fighting for the same port;
- two tests using the same DB or test user;
- an agent resuming later in the wrong checkout;
- work being implemented locally but never actually delivered.

The control plane changes the unit of work from **"a branch in a shared folder"** to **"a managed engineering workspace for one task"**.

---

# Core development flow

The preferred order for the first accelerator slice is:

```text
dev_spawn_workspace(issue)
        ↓
prepare_task
        ↓
coding
        ↓
fast_verify
        ↓
review / full CI
        ↓
merge / deploy / verify
```

The first three capabilities are intentionally prioritized in that order:

1. **Workspace first** — isolate the task physically.
2. **Prepare task** — give the model compact, relevant context.
3. **Fast verify** — shorten the edit → feedback loop.

The larger scheduler, repository index, engineering memory and background gardener build on top of this flow.

---

# 1. Workspace Accelerator

User-facing concept:

```text
dev_spawn_workspace(issue)
```

Canonical provider capability:

```text
engineering_spawn_workspace
```

A coding task receives its own physical directory and its own runtime area.

For example:

```text
trained-assist-agent/                 # registered source/base repository

engineering-workspaces/
  ws-1353/
    code/                             # git worktree, coding cwd
    runtime/
      data/
      logs/
      tmp/
      config/

  ws-1354/
    code/
    runtime/
      data/
      logs/
      tmp/
      config/
```

Agent A can edit `src/server.js` in `ws-1353/code` while Agent B edits its own copy of the same file in `ws-1354/code`.

They no longer mutate the same working directory.

## Why git worktree

We do not need a full `git clone` for every task.

Git worktrees share the repository object database/history while giving every task a separate working directory and branch:

```text
                    shared git objects
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
        main/           ws-1353/         ws-1354/
        main            branch A         branch B
```

This is faster and cheaper than repeated full clones while still isolating filesystem edits.

A worktree is **not a security sandbox**. Untrusted/multi-tenant execution still requires OS/container isolation. Workspace isolation is primarily engineering isolation.

## Workspace lifecycle

A workspace is not just a directory. It is a managed resource with identity and ownership:

```text
issue/root task
  ↔ workspace id
  ↔ exact base revision
  ↔ branch
  ↔ current owner / lease generation
  ↔ runtime resources
  ↔ process supervision
```

The operation must be idempotent.

If the same durable task retries after a crash, it should recover the same workspace instead of silently creating another one.

## Readiness levels

We distinguish two stages.

### `code_ready`

- exact base commit materialized;
- branch/worktree created;
- ownership persisted;
- coding cwd available;
- crash recovery possible.

### `runtime_ready`

Adds the environment needed for actual work:

- dependencies;
- isolated test data;
- fixtures/test users;
- runtime config;
- logs;
- ports when needed;
- dev server/health check for web tasks;
- browser profile only when required.

A CLI-only task should not pay the cost of starting a browser and web server.

## Cleanup is conservative

TTL does not mean "delete this folder".

Before release, engineering checks for:

- dirty files;
- untracked files;
- local commits;
- unpushed work;
- active processes;
- unresolved delivery/PR state.

Unknown state means **retain and reconcile**, not `rm -rf`.

---

# 2. Task Preparation

Canonical capability:

```text
engineering_prepare_task
```

Once the workspace exists, the model should not waste expensive tokens rediscovering the repository from scratch.

`prepare_task` builds a compact Task Packet for the exact base revision.

Typical packet content:

- repository/base SHA;
- likely files;
- relevant symbols/search hits;
- related tests;
- related docs/specs;
- recent relevant history;
- uncertainty/fallback diagnostics.

Example flow:

```text
Issue / task
   ↓
workspace at exact SHA
   ↓
prepare_task
   ↓
Task Packet
   ↓
coding model
```

The Task Packet is guidance, not a cage. It must never imply that only the predicted files are allowed to be inspected.

## Deterministic first

The default source should remain cheap and reproducible:

- git metadata;
- file names;
- literal/content search;
- test/docs relationships;
- recent history.

Later, a repository index can enrich this with:

- symbols;
- references;
- dependencies;
- module ownership;
- test-to-code relationships;
- architecture summaries;
- historical hotspots.

If the index is stale or broken, the public contract stays the same and `prepare_task` falls back to raw-repository discovery.

---

# 3. Fast Verify

Canonical capability:

```text
engineering_fast_verify
```

The goal is to shorten the developer feedback loop without weakening integration safety.

Instead of running the entire CI suite after every small edit:

```text
edit
  ↓
detect affected area
  ↓
run minimal relevant checks
  ↓
continue coding
```

Then, at the integration boundary:

```text
full CI / staging / required checks
```

still run normally.

## What Fast Verify considers

A verification snapshot includes more than the latest commit:

- committed changes since base;
- staged changes;
- unstaged changes;
- allowed untracked files;
- renames/deletions;
- lockfile/config changes;
- project manifest/toolchain version.

The result must be tied to an exact input fingerprint.

If files change while checks are running, the result becomes **stale**, not green for the new code.

## Conservative fallback

Unknown impact is not success.

Changes to shared runtime, schemas, dependency config, test configuration or dynamic boundaries may require broader tests or `full_required`.

For `trained-assist-agent`, verification must understand that tests are not only Vitest: there are also Node/CJS scripts and staging scenarios.

Fast Verify accelerates iteration. It does **not** replace merge protection.

---

# 4. Work Admission / Engineering Scheduler

Once workspaces exist, the next problem is deciding **what should start now**.

Canonical capability:

```text
engineering_request_work
```

The scheduler is not merely a brake. Its purpose is to maximize throughput of verified results.

Possible decisions:

```text
CODE
RESEARCH
REVIEW
HELP
MAINTAIN
WAIT
```

Examples:

- start a new implementation;
- investigate a failing PR instead;
- prepare context for another writer;
- review an active change;
- fix CI/tooling;
- wait because another overlapping change is already integrating.

## Two different limits

We distinguish:

1. **executor slots** — how many expensive processes are actively running;
2. **WIP slots** — how many unfinished product changes are currently in flight.

An agent waiting for CI may release compute, but the unfinished change still occupies WIP.

Admission must use atomic reservation/leases so five agents cannot simultaneously observe one free slot and all start.

---

# 5. Parallel research, controlled writes

The system should parallelize reading much more aggressively than writing.

Preferred pattern:

```text
                  one writer
                     |
       +-------------+-------------+
       |             |             |
   test scout    API scout     history/log scout
   read-only     read-only      read-only
```

Helpers can prepare:

- tests;
- API contracts;
- similar implementations;
- logs;
- regression cases;
- compatibility risks.

One main writer owns mutations for the task.

This gives useful parallelism without multiplying merge conflicts.

---

# 6. Reproduce → Fix → Verify

Bug fixing should converge toward a reusable workflow:

```text
bug report
   ↓
reproduce automatically
   ↓
save failing evidence/scenario
   ↓
prepare_task
   ↓
implementation
   ↓
rerun exact scenario
   ↓
regression test
   ↓
PR evidence
```

A coding model works much faster when the problem is represented as:

```text
input → observed wrong behavior → expected behavior
```

instead of a vague natural-language suspicion.

---

# 7. Review and PR intelligence

Review should reuse what the system already knows.

A Review Evidence Packet can include:

- original task/spec;
- base SHA;
- Task Packet;
- diff;
- fast verification evidence;
- full CI/staging status;
- unrelated changes;
- affected contracts;
- active overlapping changes.

The reviewer should not rediscover the entire repository when the existing evidence is sufficient.

Existing PR coherence and per-file coherence logic from `trained-assist-agent` is expected to migrate/adapt here.

---

# 8. CI / autofix / merge lifecycle

Engineering owns the **policy**, while independently deployable workers can remain separate.

Examples:

- `trained-assist/pr-autofix` can remain its own worker;
- Merge Relay can remain a separately deployed worker/API;
- this repository defines how and when they are used.

Important policies:

- bounded autofix attempts;
- transient infrastructure errors retry later instead of rewriting code;
- repeated identical failure stops and triggers re-plan/escalation;
- one shared base failure should not create five competing fixes;
- merge integration should have one owner;
- draft/conflicted PRs must not permanently block queue progress.

A coding session finishing is not the same as feature delivery.

Desired lifecycle:

```text
agreed behavior
  → task
  → workspace
  → implementation
  → verified revision
  → PR
  → merge
  → required deploy
  → live verification
```

---

# 9. Engineering Memory / Known Fixes

The system should not repeatedly pay to rediscover known infrastructure failures.

Knowledge format:

```text
failure signature
  → diagnosis
  → fix
  → evidence
  → affected versions
```

Lookup order:

1. exact/hash/signature;
2. regex/structured match;
3. semantic search;
4. LLM investigation.

Example: once the system has proven a particular GitHub Actions/token failure mode, future agents should retrieve that evidence instead of spending another research cycle on it.

## Logs library

Alongside known fixes, a model should not have to re-discover *where the logs are*. The QA logs
library is a per-profile JSON registry of log locations (`qa_log_register` /
`qa_log_lookup` / `qa_log_list`), keyed by `USER_ID` under `~/agent-data/qa-logs/`
(host override: `ENGINEERING_QA_LOGS_ROOT`). An entry records only metadata —
`{ name, location, ttl, fields, how_to_read, owner, source, added_at }` — never log
contents and never raw credentials; registrations that look like they contain secrets are
rejected. See `contracts/qa-log.schema.json`.

## pr-autofix service (slice 1)

`pr-autofix` is registered per profile as a capability record, not a secret store. Slice 1 adds the
registration store + state machine and three tools (`engineering_pr_autofix_register` /
`engineering_pr_autofix_status` / `engineering_pr_autofix_disable`), keyed by `(USER_ID, repo)`
under `~/agent-data/pr-autofix/` (host override: `ENGINEERING_PR_AUTOFIX_ROOT`). A registration
records `{ repo, base_branch, features{fix,cleanup,batch}, autofix_ref, capabilities,
ci_workflow_name, installed_workflow, status, created_at, updated_at }` and moves through
`registered → credentials_bound → workflow_installed → active → disabled|error`. `register` is an
idempotent upsert that never auto-enables; `disable` is the kill-switch. Raw secrets are rejected
(`CREDENTIAL_REJECTED`) and never persisted. See `docs/PR-AUTOFIX-SERVICE.md` and
`contracts/pr-autofix-registration.schema.json`.

Slice 2a adds `engineering_pr_autofix_install` (external write, approval required): given a
registration it builds the dedicated `.github/workflows/pr-autofix.yml` (plus
`.github/workflows/ci-fix-cleanup.yml` when `features.cleanup`) pinned to an immutable
`autofix_ref`, and opens — or updates — a reviewable PR to the target repo's `base_branch`. The
installed job triggers on `workflow_run` of the repo CI workflow named by `ci_workflow_name`
(default `"CI"`), only for failed pull-request runs that are not already `fix/ci-*`. Install is
idempotent (identical pinned job → no PR; ref bump → update PR) and never writes credentials or
repository Actions secrets — that is the separate, approval-gated slice 2b.

---

# 10. Repository Gardener

Cheap/background jobs can continuously reduce friction for future coding agents.

The gardener looks for things such as:

- unclear ownership;
- duplicate patterns;
- stale/contradictory docs;
- weak naming;
- repeated workarounds;
- missing architecture invariants;
- missing regression tests;
- oversized/confusing modules.

Its output should be a **small targeted PR** or a deduplicated issue.

It must not generate noise for its own sake.

The goal is compounding improvement:

```text
today's coding task
      ↓
repository becomes slightly easier to understand
      ↓
tomorrow's coding task is faster
```

---

# 11. Golden paths / scaffolding

Common component types should not be reinvented by an LLM every time.

Future scaffolds may cover:

- MCP tools;
- actions;
- endpoints;
- durable tasks;
- tests;
- adapters.

The scaffold generates standard structure:

- registration;
- telemetry;
- error handling;
- test skeleton;
- expected directories/contracts.

The coding model then spends its reasoning budget on business logic rather than boilerplate architecture.

---

# 12. Repository intelligence

A future repository index maintains reusable context:

- modules;
- symbols and references;
- dependencies;
- test relationships;
- architecture responsibilities;
- historical hotspots.

It is an acceleration layer, not a new source of truth.

v1 is deterministic and shipped: a `buildIndex` entry writes `.engineering/index/`
(revision identity/schema/timestamp, files, modules, symbols, tests, hotspots); `prepare_task`
prefers it via `prefer_index` and falls back to raw whenever it is missing, stale or
incompatible; `engineering_repo_context(keywords)` answers "give me context by keys, super
fast" from the index or, failing that, the raw keyword ranking. See `docs/INDEXER.md`.

Canonical product state remains:

- Git → source/revision;
- GitHub → issues/PR/checks;
- product/runtime systems → domain state;
- engineering → derived cache/index/workspace lifecycle/leases.

---

# Multi-surface by design

Capabilities are not MCP-only.

The same core operation should be reusable through:

- **Node library** — orchestration/tests;
- **CLI** — OpenCode/Codex/scripts/cron/CI;
- **MCP** — controlled agent tool surface;
- **playbooks** — reusable engineering workflows;
- **CI/reusable workflows** where appropriate.

MCP is an adapter, not the architecture.

---

# Project-specific mechanics

Product repositories may provide:

```text
.engineering/project.yml
```

It can describe trusted project mechanics such as:

- dependency/setup commands;
- quick/full tests;
- fixtures;
- dev server;
- health probes;
- required docs;
- deployment environments;
- optional hooks.

Engineering owns the generic policy.

The product repository owns its own mechanics.

Project manifests must not become a way for changed branch content to grant itself arbitrary host permissions.

---

# GitHub onboarding

GitHub integration should be capability-based.

Preferred path:

```text
engineering feature
   ↓
logical GitHub capability request
   ↓
ZeroCreds credential binding
   ↓
repository capability probe
   ↓
GitHub adapter / Merge Relay
```

Raw credentials must not enter:

- Task Packets;
- repository indexes;
- prompts;
- project manifests;
- logs.

See `docs/GITHUB-ONBOARDING.md`.

---

# Integration with trained-assist-agent

`trained-assist-agent` already has the external provider mechanism we want to reuse:

- immutable approved artifact;
- `provider-manifest.json`;
- exact revision pinning;
- per-profile allowlist;
- separate provider process;
- action policy.

Engineering capabilities should plug into that mechanism rather than introducing a second loader.

Current integration epic:

- `trained-assist-agent#1353`
- `trained-assist-engineering#1`

See `docs/INTEGRATION.md`.

---

# Current implementation status

Implemented today:

- workspace `code_ready` core (`spawnWorkspace`/`statusWorkspace`/`releaseWorkspace`) with
  ownership/lease, idempotency, crash recovery, conservative release and a local proof;
- raw-repository `prepare_task` core;
- deterministic repository index v1 (`buildIndex` → `.engineering/index/`) plus
  `prepare_task` `prefer_index` with automatic stale/incompatible fallback to raw;
- `engineering_repo_context(keywords)` — fast keyword context from a fresh index or the raw
  keyword ranking;
- QA logs library (`qa_log_register` / `qa_log_lookup` / `qa_log_list`);
- pr-autofix registration store + state machine (slice 1:
  `engineering_pr_autofix_register` / `_status` / `_disable`, local state only);
- Task Packet contract;
- CLI surface;
- MCP surface;
- raw/index context-source abstraction;
- provider manifest;
- integration/onboarding architecture documents.

See `docs/WORKSPACE-LIFECYCLE.md` for the workspace contract (E1) and `docs/requirements-log.md`
for the current requirements status.

Current priority order:

```text
1. Workspace Accelerator
2. prepare_task hardening/integration
3. Fast Verify
4. Work Admission / Scheduler
5. Review / PR intelligence
6. Issue → PR orchestration
7. CI/merge lifecycle hardening
8. Engineering Memory
9. Repository Gardener
10. Specification/product-owner automation
```

A roadmap item is not considered implemented merely because it exists in this README.

---

# Repository layout

```text
src/
  prepare-task.js
  workspace/
    workspace.js        # spawn/status/release/reconcile
    git.js
    store.js
    paths.js
    errors.js
  index/
    build.js            # deterministic index builder
    status.js           # compatibility / staleness checks
    lang.js             # language detection + regex symbol scan
    schema.js
  context-sources/
    raw-repo.js
    indexed-repo.js
    repo-context.js     # engineering_repo_context keyword query
  qa-logs/
    registry.js         # per-profile log-location registry
  pr-autofix/
    registry.js         # per-profile pr-autofix registration store + state machine
  mcp-skills/

contracts/
playbooks/
docs/
examples/
scripts/                # index-repo.js, manifest-check.js
```

Expected future top-level capability areas include workspace management, verification, scheduler/admission, repository intelligence and engineering memory.

---

# Boundary

Belongs here:

- isolated engineering workspaces;
- task preparation / specification support;
- repository intelligence;
- work admission / WIP gate;
- impact / fast verification;
- review/coherence;
- CI/merge/deploy orchestration policy;
- GitHub onboarding;
- issue-to-PR engineering automation;
- engineering memory;
- repository gardener;
- reusable engineering scaffolds/playbooks.

Does **not** belong here:

- Telegram delivery;
- user personas/conversations;
- generic durable conversation execution;
- recruiter/HH/legal/freelance business logic;
- product-specific runtime behavior;
- product-specific deployment implementation.

Those stay in core/domain/product repositories and are referenced through stable contracts/manifests.

---

# North Star

The goal is not maximum agent activity.

The goal is:

> **minimum time from accepted task to verified delivered result, without losing work or creating uncontrolled rework.**

A coding model should spend expensive tokens on reasoning and implementation — not on rediscovering the repository, repairing environment collisions, repeatedly diagnosing known failures, or reconstructing what another agent was doing.

The engineering layer exists so that coding agents can be aggressive **inside a controlled, observable and recoverable development system**.
