# PR coordination: immutable PRs ↔ auto-fix (supersede protocol)

Status: **approved & implemented** (owner decision 2026-09-27).
Issue: trained-assist-engineering#27. Related: `docs/PR-AUTOFIX-SERVICE.md`,
`docs/ARCHITECTURE.md` ("GitHub owns issue/PR/CI state").

## Problem

PRs are immutable (`.githooks/pre-push` blocks pushing to a branch that has an
open PR): a broken PR is **closed**, the change moves to a **new** branch/PR.
The coordination between "the agent supersedes a broken PR with a new one" and
"the auto-fix pipeline `trained-assist/pr-autofix` is still working on it" has a
race:

> The fixer reaches an old PR that is **still open**, but the agent has already
> decided to supersede it. Between "decided" and "actually closed" the fixer
> keeps acting on a stale branch — it may create a fix PR that merges and
> closes the wrong original, or land on an abandoned branch.

The existing `fail:race_pr_closed` guard only catches "reached a PR that is
already closed" — not this window.

An endpoint-log (a second source of truth) was proposed and **rejected**: it
drifts from GitHub, doesn't remove the need for check-then-act, costs
infrastructure, and contradicts `docs/ARCHITECTURE.md`.

## Approved protocol (GitHub = the single source of truth)

1. **Task-id = issue #T.** The agent creates an issue once; each attempt PR
   carries `Refs #T` in the body + a hidden marker `<!-- task:T attempt:K -->`;
   the branch is deterministic `agent/T-K`. A PR number changes, the issue does
   not.

2. **Supersede in order:** the agent opens the new PR #M **first**, then on the
   old PR: comment `Superseded by #M` → label `superseded` → close. In issue #T
   append a log line `attempt K → #M`. The forward link lives in GitHub itself.

3. **Fixer guard against live GitHub:** before every mutating step the fixer
   does `GET /pulls/{n}` and aborts when the PR is not open, carries the
   `superseded` label, or its `head_sha` differs from the one it started with;
   the merge is issued with a `sha` binding so an out-of-date branch physically
   cannot merge.

4. **Serialization:** the fixer workflow uses a `concurrency` group
   (`autofix-task-T`, `cancel-in-progress`); the agent waits for the `autofix`
   check-run on task T to finish before acting on the same task.

5. **Log:** a check-run `autofix` on the head_sha
   (queued / in_progress / completed + `output.summary` pointing at the fix PR)
   and a single fixer comment in issue #T.

An endpoint is justified only as a read-only observability projection (a
reconciler rebuilds it from the GitHub API), never as a source of truth.

## Implementation

| Piece | Where | Status |
|---|---|---|
| Fixer guard (`fail:race_pr_superseded`, head_sha pin, merge locked to SHA) | `trained-assist/pr-autofix` `scripts/autofix.mjs` | PR #18 |
| Agent supersede template (`dev_supersede_pr`: comment → label → close, issue log, idempotent) + `github_pr_checks` | `trained-assist/trained-assist-agent` `src/mcp-skills/tools/61-dev.js` | PR #1585 |
| This protocol document | `trained-assist/trained-assist-engineering` `docs/` | here |

### Serialization note

Point 4's per-task `concurrency` group needs the task id `T` at the workflow
level (from the `<!-- task:T attempt:K -->` marker in the PR body). It is
design-approved; the installed workflow (see `docs/PR-AUTOFIX-SERVICE.md` §3.1)
can adopt a branch-level group today and upgrade to per-task once the marker
plumbing is in place.