# GitHub Event Relay

Small Cloudflare Worker service that accepts GitHub App webhook deliveries and fans out minimized, versioned event envelopes to active MCP wait calls. It does not own task subscriptions, evaluate CI, or start/resume agents.

## Endpoints

- `POST /github/webhook` — verify GitHub HMAC signature, normalize supported CI events, enqueue, return `202` only after queue acceptance.
- `GET /v1/events/stream?repo=owner/repo` — authenticated SSE stream for an active MCP wait call. It wakes on repository events and holds no task or wait state.
- `GET /healthz` — Worker liveness only; it does not verify Queue or event channel health.

Supported source events: `check_run`, `check_suite`, `workflow_run`, `workflow_job`, `status`, and `pull_request`. Unsupported event types are acknowledged and ignored. Supported events without a repository ID/name receive `422` so GitHub reports the delivery failure.

## Configuration

Create the queue and DLQ, then deploy the Worker:

```sh
npx wrangler queues create trained-assist-github-events
npx wrangler queues create trained-assist-github-events-dlq
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put MCP_EVENT_TOKEN
npx wrangler deploy
```

`GITHUB_WEBHOOK_SECRET` and `MCP_EVENT_TOKEN` must each be random values of at least 32 characters. Configure the GitHub App webhook secret to the first value and URL to `https://<worker-host>/github/webhook`. Subscribe only to the supported events needed by CI. Configure `GITHUB_EVENT_RELAY_URL=https://<worker-host>` and `GITHUB_EVENT_RELAY_TOKEN` to the same MCP token in the MCP process environment. Secrets belong in Wrangler's secret store and MCP process environment, never in task parameters.

The Worker uses one hibernatable Durable Object per repository only to fan out events to currently connected wait calls. It keeps no task or wait records; its per-repository DO retains a bounded 24-hour event cursor log (up to 5,000 events) for reconnect replay. If an MCP process disconnects, its wait falls back to GitHub polling/reconciliation; on reconnect the same call replays from `Last-Event-ID` within the 24-hour log window. The Control Panel does not receive GitHub events or need a GitHub inbox.

## Envelope

```json
{
  "schema_version": 1,
  "event_id": "github:<X-GitHub-Delivery>",
  "source": "github",
  "app_id": 123,
  "installation_id": 456,
  "repository_id": 789,
  "repository_full_name": "owner/name",
  "event_type": "check_run",
  "action": "completed",
  "received_at": "...",
  "subject": { "head_sha": "...", "check_run_id": 101, "status": "completed", "conclusion": "failure" }
}
```

The envelope deliberately contains no user, task, wait, or runner IDs. MCP checks GitHub access using its existing credential before waiting and re-reads the GitHub API after each event; events are wake-up hints, not CI verdicts. Queue redeliveries can produce duplicate wake-ups, which are harmless because the MCP wait takes a fresh snapshot.

## Delivery behavior

Queue consumer broadcasts to the repository's active event channel and acknowledges after successful fan-out. Any channel error is retried; the configured retry limit sends exhausted messages to the DLQ. Configure an alert before enabling the GitHub App webhook. GitHub's 10-second response requirement is met by returning after queue acceptance.

## Local verification

From the repository root, run `node --test tests/github-event-relay.test.js`. This tests signature validation, event normalization, queue acknowledgement, and channel fan-out retry behavior without Cloudflare account access. It does not prove deployment or real GitHub webhook delivery.
