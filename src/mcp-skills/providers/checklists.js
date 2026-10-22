'use strict';

// The checklist surface of this repository, as a PROVIDER.
//
// It used to be a server of its own (src/mcp-checklists/index.js): a second
// stdio process, a second copy of the JSON-RPC frame, a second tool list. Now
// it is a provider the single entry point (src/mcp-skills/index.js) can serve
// — opt-in, because the checklist surface is user-local and adding it to the
// default catalog would widen the surface every host of trained-assist-agent
// registers.
//
// The provider owns its TOOLS and its calls. The transport owns the frame.

const { prepareChecklist } = require('../../checklists/prepare');
const { waitForCi } = require('../../github/ci-wait');
const { createTransport, initializeResult, jsonrpc } = require('../../mcp-protocol');

let agentRunStart = null;
let agentRunWait = null;
let configuration = () => null;
try {
  const runModule = require('../../serverless-agent/run');
  if (runModule && typeof runModule.configuration === 'function') {
    agentRunStart = runModule.agentRunStart || null;
    agentRunWait = runModule.agentRunWait || null;
    configuration = runModule.configuration;
  }
} catch (error) {
  agentRunStart = null;
  agentRunWait = null;
  configuration = () => null;
}

// The runner is optional. The tools stay DECLARED either way (a declared tool
// with an honest "not configured" error beats an invisible one), so the agent
// can tell "the runner is not wired up" from "this API does not exist".
function runnerMissingError(toolName) {
  return {
    ok: false,
    error: 'RUNNER_NOT_CONFIGURED',
    tool: toolName,
    message: 'Remote agent runner is not configured: set SERVERLESS_AGENT_API_URL and SERVERLESS_AGENT_API_KEY in the MCP server environment.',
  };
}

const TOOL = {
  name: 'engineering_checklist_prepare',
  description: 'Use before planning a bug fix, code change, or test strategy when the engineering checklist MCP is enabled. Inspects project files read-only and returns a short, adaptable checklist plus evidence-backed test and runtime options. For an ordinary development task the checklist includes the default delivery path (separate branch/worktree -> PR -> green CI -> merge -> deploy/verify) unless the user explicitly asks for a narrower deliverable. It never runs commands or changes files. Pass the current repository root and the user task; do not use for purely informational questions.',
  inputSchema: {
    type: 'object',
    required: ['task', 'repo_path'],
    properties: {
      task: { type: 'string', description: 'The user task, in their original language.' },
      repo_path: { type: 'string', description: 'Absolute path to the relevant local repository/worktree.' },
      intent: { type: 'string', enum: ['auto', 'debugging', 'test-path', 'change'], description: 'Optional task kind. Use auto unless the task kind is clear.' },
      delivery: { type: 'boolean', description: 'Optional. Defaults to true for ordinary development tasks; set false only when the user explicitly asks for a narrower deliverable (for example local-only or no PR).' },
    },
    additionalProperties: true,
  },
};

const CI_WAIT_TOOL = {
  name: 'engineering_ci_wait',
  description: 'Wait for GitHub Actions or commit checks to finish, then wake this tool call with a concise success/failure/timeout report. Always pass repo and exactly what to observe: run_id, sha, or pr_number. When GITHUB_EVENT_RELAY_URL and GITHUB_EVENT_RELAY_TOKEN are configured, GitHub webhook events wake this wait immediately; GitHub API reconciliation still runs at the configured interval. Otherwise it polls GitHub directly every three minutes by default. Timeout defaults to 15 minutes and is capped at 90. Public repositories can be read without a GitHub token; private repositories need a read-capable token. A failed check returns immediately so the agent can inspect/fix it.',
  inputSchema: {
    type: 'object',
    required: ['repo'],
    anyOf: [{ required: ['run_id'] }, { required: ['sha'] }, { required: ['pr_number'] }],
    properties: {
      repo: { type: 'string', description: 'GitHub owner/repo.' },
      run_id: { type: ['string', 'integer'], description: 'A specific Actions workflow run to wait for.' },
      sha: { type: 'string', description: 'Commit SHA whose check runs should be observed.' },
      pr_number: { type: 'integer', description: 'PR number; its head SHA is resolved before reading checks.' },
      check_names: { type: 'array', items: { type: 'string' }, description: 'Optional exact check names to wait for; absent means all checks returned for the ref.' },
      interval_seconds: { type: 'integer', minimum: 180, maximum: 3600, default: 180 },
      timeout_minutes: { type: 'integer', minimum: 1, maximum: 90, default: 15 },
    },
    additionalProperties: false,
  },
};

const AGENT_RUN_START_TOOL = {
  name: 'agent_run_start',
  description: 'Start a remote serverless agent task and immediately return a stable run_id. Use a stable idempotency_key for retries. The API principal determines the repository; never put API keys or other secrets in task. Then call agent_run_wait with run_id.',
  inputSchema: {
    type: 'object', required: ['task', 'idempotency_key'],
    properties: {
      task: { type: 'string', minLength: 1, maxLength: 100000 },
      idempotency_key: { type: 'string', description: 'Unique key for this logical task; reuse unchanged on retry.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Remote execution limit; default is 300 seconds.' },
      connection_id: { type: 'string', description: 'Optional registered OpenAI BYOK connection ID. Omit for managed model.' },
    }, additionalProperties: false,
  },
};

const AGENT_RUN_WAIT_TOOL = {
  name: 'agent_run_wait',
  description: 'Wait for a serverless agent run, then return its final answer, outcome and artifact links to this OpenCode session. On timeout, call again with the same run_id. Cancelling this tool call stops local waiting only; it does not cancel the remote run.',
  inputSchema: {
    type: 'object', required: ['run_id'],
    properties: {
      run_id: { type: 'string', description: 'Stable ID returned by agent_run_start.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 4800, default: 900 },
      interval_seconds: { type: 'integer', minimum: 2, maximum: 60, default: 3 },
    }, additionalProperties: false,
  },
};

// The complete tool surface of this provider, in the order it is served.
// One list, so the wire format, the manifest check and the composition
// declaration cannot drift apart (the names used to be repeated in three
// places).
const TOOLS = [TOOL, CI_WAIT_TOOL, AGENT_RUN_START_TOOL, AGENT_RUN_WAIT_TOOL];

const PROVIDER_ID = 'checklists';
const SERVER_INFO = { name: 'engineering-checklists', version: '1.2.0' };

/**
 * Create the checklist provider.
 *
 * Every dependency is injectable so the provider can be exercised without a
 * network, a runner and a real cancellation.
 */
function createChecklistsProvider(deps = {}) {
  const {
    pending = new Map(),
    wait = waitForCi,
    startRun = agentRunStart,
    waitRun = agentRunWait,
  } = deps;
  // "not provided" means "read the environment"; an explicit null means "there
  // is no runner" — the difference is what the NOT_CONFIGURED error is about.
  const resolveRunnerConfig = () => (Object.prototype.hasOwnProperty.call(deps, 'runnerConfig')
    ? deps.runnerConfig
    : configuration());

  return {
    id: PROVIDER_ID,
    serverInfo: SERVER_INFO,
    pending,
    listTools: () => TOOLS,

    async callTool(name, args = {}, { signal, requestId } = {}) {
      const config = resolveRunnerConfig();
      let result;

      if (name === TOOL.name) {
        result = prepareChecklist({ task: args.task, repoPath: args.repo_path, intent: args.intent || 'auto', ...args });
      } else if ((name === AGENT_RUN_START_TOOL.name || name === AGENT_RUN_WAIT_TOOL.name) && !config) {
        result = runnerMissingError(name);
      } else {
        const controller = new AbortController();
        if (signal) {
          if (signal.aborted) controller.abort();
          else signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        // The pending call is keyed by the id of the request that started it:
        // that is the id a notifications/cancelled message names.
        pending.set(String(requestId), controller);
        try {
          result = name === CI_WAIT_TOOL.name
            ? await wait(args, { signal: controller.signal })
            : name === AGENT_RUN_START_TOOL.name
              ? await startRun(args, { ...config, signal: controller.signal })
              : await waitRun(args, { ...config, signal: controller.signal });
        } finally {
          pending.delete(String(requestId));
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      };
    },
  };
}

// The handlers of the provider as an MCP server: they answer the method names
// of the protocol, the provider answers the tools.
function providerHandlers(provider, { serverInfo = provider.serverInfo } = {}) {
  return {
    initialize: () => initializeResult({ name: serverInfo.name, version: serverInfo.version }),
    'tools/list': () => ({ tools: provider.listTools() }),
    'tools/call': async (params, message) => {
      const name = params && params.name;
      if (!provider.listTools().some(tool => tool.name === name)) {
        throw new jsonrpc.JsonRpcError(jsonrpc.RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name || ''}`);
      }
      return provider.callTool(name, (params && params.arguments) || {}, { requestId: message && message.id });
    },
  };
}

// The cancellation bridge: a notification cancels the call it names.
function cancellationHandler(provider) {
  return message => {
    if (message.method !== 'notifications/cancelled') return;
    const requestId = message.params && message.params.requestId;
    provider.pending.get(String(requestId))?.abort();
  };
}

/**
 * Handle one MCP request against the checklist provider.
 *
 * Kept as the public entry of the provider: the tests and the standalone view
 * of this surface call it directly, and it goes through the SAME transport as
 * the merged entry point — there is no second implementation of the frame.
 */
function handleRequest(request, deps = {}) {
  const provider = createChecklistsProvider(deps);
  const transport = createTransport({
    handlers: providerHandlers(provider),
    onNotification: cancellationHandler(provider),
  });
  return transport.handle(request);
}

module.exports = {
  PROVIDER_ID,
  SERVER_INFO,
  TOOL,
  CI_WAIT_TOOL,
  AGENT_RUN_START_TOOL,
  AGENT_RUN_WAIT_TOOL,
  TOOLS,
  createChecklistsProvider,
  providerHandlers,
  cancellationHandler,
  handleRequest,
};
