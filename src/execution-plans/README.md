# execution-plans — reference layer, not the production runtime

This directory implements an execution-plan engine for real playbooks (P24, epic E5 #21,
acceptance AC-143): a pinned playbook definition compiles into a plan with stable step IDs,
required gates, wait kinds, external-operation refs and a GTD port.

**It has no production caller.** Outside this directory the only consumers are
`tests/execution-plans.test.js` and `scripts/sandbox/real-playbooks.mjs`. Nothing in
`trained-assist-agent` imports it, and no MCP tool starts a plan from it. The running agent uses
its own durable runtime (`durable-task-store.js` + `gtd-controller.js`), which does not read
these modules.

Consequences to keep in mind:

- The guarantees declared here — `GATE_NOT_DISABLEABLE`, `effectReceipt` required for writes,
  fresh-evidence acceptance, `unknown` external effect → reconcile instead of blind retry — are
  enforced by **this repo's CI and tests only**. Do not describe them as live policy; the live
  agent enforces a different (weaker) set. See README, "Where the policy is actually enforced".
- `contracts/execution-plan.schema.json` is validated in `tests/execution-plans.test.js`; the
  runtime never validates a saved `plan.json` against it.
- This layer is kept as a reference and as a source of three ideas worth porting into the agent:
  non-disableable required gates, receipt-verified external effects, and fresh-evidence
  acceptance. Whether it is eventually removed is an owner decision, not a cleanup default.

Do not extend this layer to fix a live playbook problem — fix the live path in
`trained-assist-agent` first.
