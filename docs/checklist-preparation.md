# Local checklist preparation

The checklist catalog is a small, opt-in aid for turning a coding request into a few useful TODO groups. It complements durable playbooks: checklists guide discovery and verification; playbooks describe longer workflows with external lifecycle steps.

For an ordinary development task the checklist now includes the default delivery path (separate branch/worktree -> PR -> green CI -> merge -> deploy/verify) unless the user explicitly asks for a narrower deliverable or passes `delivery: false`.

## Selection model

`checklists/catalog.json` selects a checklist by task intent (`debugging`, `test-path`, or `change`). Project technology labels do not select a rigid workflow. The preparation tool reports evidence-backed capabilities such as package test scripts, a local start command, browser tests, Cloudflare configuration, GitHub Actions, containers, migrations, and fixtures. The agent should choose only the capabilities relevant to the symptom and the smallest test environment that can prove the behavior.

For debugging, the checklist starts with repository/worktree and baseline discovery, then symptom evidence, test route, reproduction, fix/regression, and a concise report. Guidance covers safe restart, test data/accounts, logs, reset/cleanup, and when browser testing is useful. These are grouped TODOs; individual investigation questions stay in guidance instead of becoming a long task list. If a safe reproduction is unavailable, continue with independent code/log inspection and ask only for information that blocks the next useful step.

## Local opt-in MCP

The checklist surface is a **provider** of the single MCP entry point of this
repository (`src/mcp-skills/index.js`), and it is opt-in: the entry point serves
it only when it is asked to.

Run the server directly with Node 22 or newer:

```sh
ENGINEERING_MCP_PROVIDERS=engineering,checklists \
  node /absolute/path/to/software-engineering-playbooks/src/mcp-skills/index.js
```

`--providers=engineering,checklists` does the same thing and overrides the
environment.

Add a local MCP entry to the user's OpenCode configuration
(`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "engineering-skills": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/software-engineering-playbooks/src/mcp-skills/index.js"],
      "cwd": "/absolute/path/to/software-engineering-playbooks",
      "environment": {
        "ENGINEERING_MCP_PROVIDERS": "engineering,checklists"
      },
      "disabled": false
    }
  }
}
```

Two details in that entry are not cosmetic:

- **Use the absolute path of the node binary**, not the bare `node`. The host
  starts the server with a minimal environment, where `node` is often not on
  `PATH` — the server then fails to start and the whole MCP entry disappears
  from the agent context without an error.
- **Point the entry at a clean checkout at a pinned revision.** A working tree
  with uncommitted changes is a running server that exists nowhere else and
  cannot be reproduced. `npm run check:mcp-servers -- --host-config
  ~/.config/opencode/opencode.json` verifies both.

The `engineering_checklist_prepare` tool accepts the task and an absolute repository/worktree path. It reads shallow project metadata, package script names, selected config file names, and Git branch/change counts. It does not run project scripts, read environment file contents, modify files, or call external services. It returns checklists and capability evidence; the agent remains responsible for selecting relevant TODOs and running any explicitly appropriate project checks.

The same opt-in server exposes `engineering_ci_wait` for GitHub Actions runs, commit check-runs, or a PR's current head checks. It performs an immediate read. When `GITHUB_EVENT_RELAY_URL` and `GITHUB_EVENT_RELAY_TOKEN` are configured, webhook events wake the active wait and GitHub is reconciled at least every five minutes; otherwise it checks no more often than every three minutes. Timeout defaults to 15 minutes and is capped at 90. It returns on any terminal result, distinguishing success, failure/cancellation, and completed-but-skipped/neutral states. Timeout and rate-limit responses include the last observed state so the agent can decide whether to retry with changed parameters or investigate. The MCP wait is cancellable; OpenCode cancellation stops the current wait so the agent can submit a new call with updated check names or timeout. Public repositories can use anonymous GET. For private repositories, the tool uses an available GitHub token from its credential store/environment or `gh auth token`; it never accepts or prints a token in the prompt. Anonymous GitHub rate limits are shared by source IP, so the waiter stops before another request when its last response shows five or fewer requests remaining.

Without the optional event relay this tool uses fetch polling. When the relay URL/token are configured, the MCP call holds an authenticated SSE stream and webhook events wake it; polling remains the fallback and reconciliation path. The tool does not create GitHub App webhooks or manage repository installations.

This design is user-local and opt-in. It does not expand the system prompt or require all OpenCode users to install the MCP. The shared MCP host's current test worker is not a checklist provider, so the local stdio server is the direct integration for this setup.

## Evaluation

`tests/checklist-prepare.test.js` covers representative task intent, capability discovery, missing test affordances, read-only behavior, and the one-tool MCP surface. A live-agent smoke prompt should additionally verify that an enabled OpenCode session calls the tool before creating TODOs, selects a compact debugging checklist, works only in the named fixture, and reports actual test evidence. Tool connection alone does not prove checklist selection quality.
