# Serverless agent runner: integration contract

This document describes the local OpenCode/MCP integration for launching remote serverless agents and returning their results to the same OpenCode session. The GitHub CI waiter is the reference for the wait pattern.

## Existing implementation

The local OpenCode MCP server is `src/mcp-skills/index.js` — the single entry point of this repository. The checklist surface (`engineering_checklist_prepare`, `engineering_ci_wait`, `agent_run_start`, `agent_run_wait`) is a provider of it and is opt-in: the entry point serves it when `ENGINEERING_MCP_PROVIDERS=engineering,checklists` (or `--providers=engineering,checklists`) says so. OpenCode starts it as a local stdio process. Without runner credentials it exposes two tools:

- `engineering_checklist_prepare`: inspect a local repository and return a short adaptable task checklist.
- `engineering_ci_wait`: wait for GitHub Actions/checks and return their final state.

The CI waiter lives in `src/github/ci-wait.js`. It makes read-only GitHub REST GET requests. Given a workflow `run_id`, commit `sha`, or `pr_number`, it reads the current state immediately, then polls at a minimum interval of three minutes. The defaults are a three-minute interval and a 15-minute timeout; the maximum timeout is 90 minutes. This cadence is specific to this GitHub polling implementation and its public API rate limits.

The waiter returns a structured report with `state`, `outcome`, `summary`, elapsed time, number of polls, and the last observed run/check details. Terminal outcomes are returned immediately. A timeout returns `timed_out` plus the last known state. MCP cancellation aborts the in-flight work and returns `cancelled`, so the agent can call again with changed parameters. OpenCode's local MCP entry has a 90-minute timeout so it does not cut off the allowed maximum wait.

There is no inbound webhook receiver in this implementation. The MCP call stays open while the tool waits; when the tool returns, OpenCode resumes the agent with the result. This is a good fit for a local, long-lived OpenCode process. It is not itself a general wait API for serverless agent jobs.

## Implemented runner integration

When `SERVERLESS_AGENT_API_URL` and `SERVERLESS_AGENT_API_KEY` are configured, it also exposes two serverless tools:

1. `agent_run_start`: start a job and return as soon as the runner has accepted it.
2. `agent_run_wait`: wait for a known job ID and return a terminal report, timeout report, or cancellation report.

`agent_run_start` returns a stable `run_id`, `state: queued`, and status/result URLs. Store the ID in the task context and pass it to `agent_run_wait`. Reuse the same `idempotency_key` only when retrying the same logical start; the runner then returns the original run instead of starting a duplicate.

### OpenCode call sequence

1. Call `agent_run_start` with the task and an idempotency key. The runner chooses the repository from the authenticated API principal; this tool does not accept a repository, branch, or environment override.
2. Save the returned `run_id` and call `agent_run_wait` with it. The wait call checks immediately, then polls every three seconds by default. It returns the remote answer and run state into the same OpenCode turn.
3. If the wait times out, the remote run keeps going. Call `agent_run_wait` again with the same `run_id`. If the MCP call is cancelled, only local waiting stops; use the separate runner cancellation operation if the remote run must be stopped.
4. Report the returned outcome. `state: completed` means the run is terminal; use `outcome` to distinguish success from failure. Do not describe a timed-out or cancelled wait as a completed run.

Example start input:

```json
{
  "task": "Run the browser regression scenario against the preview",
  "idempotency_key": "browser-regression-2026-10-15-1",
  "timeout_seconds": 600
}
```

Example start result:

```json
{
  "ok": true,
  "run_id": "run_<64 lowercase hex>_<24 lowercase hex>",
  "state": "queued",
  "status_url": "https://runner.example/v1/developer/runs/<run_id>"
}
```

Wait input:

```json
{
  "run_id": "run_<64 lowercase hex>_<24 lowercase hex>",
  "timeout_seconds": 900
}
```

Recommended terminal result shape:

```json
{
  "ok": true,
  "state": "completed",
  "outcome": "success",
  "summary": "Browser regression passed.",
  "run_id": "run_<64 lowercase hex>_<24 lowercase hex>",
  "elapsed_seconds": 284,
  "result_url": "https://runner.example/v1/developer/runs/<run_id>/result",
  "events_url": "https://runner.example/v1/developer/runs/<run_id>/events",
  "artifacts": [{ "path": "agent-history.json", "download_url": "https://runner.example/v1/developer/downloads/...", "expires_at": "2026-10-16T00:00:00Z" }]
}
```

Use the same stable outcome vocabulary as the CI waiter where possible:

- `state`: `queued`, `completed`, `timed_out`, `cancelled`, `error`, or `invalid_request`.
- `outcome`: `success`, `failure`, `completed_with_non_success`, `pending`, or `error`.
- `summary`: short user-readable explanation of what happened.
- On timeout, include the last observed runner state and a way to resume waiting with the same `run_id`.
- On failure, include a concise reason and links to logs/artifacts rather than returning a large log body by default.

The local waiter currently uses bounded `GET` polling every three seconds (configurable from two to 60 seconds). Each status/result request has a 30-second timeout. The backend offers status and resumable events, but no long-poll endpoint. Future wait strategies can use, in preference order:

1. A server-side long-poll request that holds one HTTP request until state changes or a bounded timeout expires.
2. A resumable event stream with a cursor/last-event ID, if the runner already supports it.
3. Bounded GET polling with a runner-specific interval and explicit rate limits (current implementation).

Do not require a public callback URL or expose a webhook receiver just to wake a local OpenCode agent. A local MCP tool can wait on the runner's outbound status API and return to OpenCode when the job changes state. If a serverless platform imposes a short request lifetime, keep the run durable and make `agent_run_wait` resumable; do not keep a serverless invocation alive only to wait.

## Runner API requirements

- Starting a run is idempotent when the caller supplies an idempotency key, so a network retry cannot accidentally launch duplicate work.
- A run has a stable identifier and explicit lifecycle states, for example `queued`, `running`, `completed`, `failed`, and `cancelled`.
- Status reads are authenticated and scoped to the caller's run. Avoid putting credentials in prompts, tool arguments, or returned URLs.
- Results remain retrievable after completion and include concise structured metadata, logs/artifact links, and timestamps.
- Waiting has a bounded maximum duration. Timeout means “still running at the last observation,” not that the run was cancelled.
- Cancellation is explicit. Cancelling an MCP wait should stop waiting; it should not cancel the remote job unless the user or agent explicitly calls a separate cancel operation.
- Surface retry guidance for rate limits and transient errors. Do not turn temporary transport failures into a false completed result.

## OpenCode/MCP wiring

The tools live in `src/mcp-skills/providers/checklists.js`; the API client and waiter live in `src/serverless-agent/run.js`. Configure the existing local stdio MCP entry with a 90-minute tool timeout; `agent_run_wait` permits at most 80 minutes per call. Its default is 15 minutes. A timeout returns `pending` and the same `run_id` for another call. The terminal report includes the final answer or failure summary, artifact metadata and download links, and an events endpoint for the work history. The result arrives as ordinary MCP text content, which resumes the calling OpenCode agent. Cancelling the MCP request aborts the local HTTP wait, not the remote run.

Set `SERVERLESS_AGENT_API_URL` to the provisioned HTTPS API origin and `SERVERLESS_AGENT_API_KEY` to a scoped developer key in the MCP process environment. Do not put either in the task prompt or MCP tool arguments. Both variables are required for discovery; existing checklist and CI tools work unchanged without them. A registered BYOK connection can be selected by `connection_id`; omit it to use the managed model. `timeout_seconds` on start controls remote execution (default 300 seconds, maximum 3600); `timeout_seconds` on wait controls local waiting (default 900 seconds, maximum 4800).

For the current local OpenCode installation, `~/.config/opencode/opencode.json` sets the sandbox API origin in the `engineering-skills` MCP `environment` and reads the key with `{file:/Users/vova/.config/opencode/secrets/serverless-agent-api-key}`. The key is stored in a mode-`0600` file and is not part of this repository. Runner PR #341 was merged and deployed to sandbox3 by [workflow run 38740334184](https://github.com/trained-assist/ai-agent-runner/actions/runs/38740334184). `node scripts/setup-developer-sandbox.mjs status` returned `200` with managed model access. Restart OpenCode after changing its global MCP configuration; all local sessions then see the same tools. The current Codex session has a separate tool registry and does not inherit OpenCode MCP registrations.

An earlier developer API canary returned terminal `succeeded` and an `__runner/agent-history.json` artifact. Authenticated download returned `200`, 11,103 bytes, and SHA-256 `357247519fc724fa4ae4e533a56823ebd92309bf7a851fcbe1f4d99b2c7ff19f`, matching the result manifest; the JSON had schema version 1 and `truncated: false`.

The current developer API binds a repository to the authenticated principal. It does not accept per-run `repo`, `ref`, or `environment` fields, so the MCP tool does not advertise them. The client returns artifact links and expiry only when those fields are present in the API response; it does not itself download artifact bytes. Treat signed guest links as private bearer links. The developer API must be enabled and provisioned in the target environment; the existing production endpoint does not yet provide a live self-service key.

### Latest local OpenCode smoke test

On 2026-10-15, the local `build` agent called `agent_run_start`, then `agent_run_wait` in the same session. Repeating start with the same idempotency key returned `deduplicated: true`, confirming it did not create a second run. The wait correctly returned `state: completed`, `outcome: failure`, and `ENGINE_NONZERO_EXIT`; it did not misreport a failed run as success. The `agent-history.json` artifact showed the actual engine error: `unknown certificate verification error`. This identifies a runner execution/environment issue after admission, rather than an MCP start/wait transport failure.

That run also exposed an artifact contract gap in the current sandbox response: neither the result payload nor the artifact listing included an expiry timestamp, and the returned artifact download URL gave HTTP 401 without API authorization. The artifact itself was retrievable through the authenticated `/artifacts?path=...` endpoint. The MCP waiter currently reports the returned link and any expiry metadata supplied by the API; an agent cannot necessarily open an authenticated API URL by itself. Before treating guest artifact URLs/expiry as guaranteed, verify the deployed API returns a signed guest link and expiry on a fresh successful run, or add an authenticated artifact-fetch tool to this MCP.

Automated verification on the same checkout: `npm test` passed all 529 tests; `npm run check`, `npm run check:playbooks`, `npm run check:action-manifest`, and `git diff --check` passed. `opencode mcp list` showed the local MCP connected. These checks validate the adapter and its test contract; the live smoke result above is still a runner failure and must not be presented as a successful end-to-end execution.

If the runner API is remote, the MCP implementation can call it directly using a user-scoped credential. If it runs in the same environment as the runner, it can use an internal authenticated endpoint. The serverless worker itself should own execution and durable state; the local MCP waiter should only start/read/wait on that state.

Keep these tools opt-in through MCP configuration. Do not add runner-specific instructions to the global system prompt. Tool descriptions should explain when to start a run, when to wait, the required `run_id`, and how to report timeout versus completion.

## Integration test plan

Use a fake runner API in unit tests and a disposable real run for end-to-end verification:

1. Starting returns one stable `run_id` and repeated start with the same idempotency key does not create another run.
2. Waiting on a queued/running job resumes when it completes and reports the correct outcome.
3. A failed job returns a concise failure reason and log/artifact links.
4. A wait timeout returns the last state and the same `run_id` can be waited on again.
5. Cancelling the local wait leaves the remote job running unless explicit remote cancellation is requested.
6. Authorization failures, missing runs, rate limits, and temporary network failures have distinct reports.
7. An OpenCode agent can call start, retain the returned ID, call wait, then summarize the actual result without fabricating completion.

## Current implementation locations

- MCP server and tool schemas: `src/mcp-skills/providers/checklists.js`
- Serverless API client and waiter: `src/serverless-agent/run.js`
- Serverless integration tests: `tests/serverless-agent-run.test.js`
- GitHub wait/polling implementation: `src/github/ci-wait.js`
- Existing waiter documentation: `docs/checklist-preparation.md`
- Waiter unit tests: `tests/ci-wait.test.js`

