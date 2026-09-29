'use strict';

// CI/CD skill — get an opened PR to CI-green → merged → deployed-and-verified,
// without a human (or Claude) needing to babysit it. Split out of 61-dev.js:
// dev is repo/workspace mechanics (clone, edit, install deps); this is the
// separate concern of tracking a change through to production once a PR exists.
//
// QA and deploy are NOT split into their own skills (yet): there is no dedicated
// test-runner tool (Claude runs `npm test`/`pytest`/etc. via bash directly) and
// no dedicated deploy tool (deploy is project-specific — wrangler, systemctl,
// gcloud, ad hoc). Splitting those out now would be empty files with no distinct
// behavior. If/when either gets real dedicated tooling, give it its own file then.

const fs   = require('fs');
const path = require('path');

const { hasToken, ghFetch, ghText } = require('./60-github');

// The file the GTD controller in trained-assist-agent (src/gtd-controller.js
// CHECKLIST_FILE) scans in every project dir — the only contract between them.
const CHECKLIST_FILE = 'checklist.md';

const GH_API = 'https://api.github.com';
const RED_CONCLUSIONS = new Set(['cancelled', 'skipped', 'timed_out', 'startup_failure', 'action_required', 'neutral']);
const LOG_TAIL_LINES = 50;
const RUN_LOOKUP_ATTEMPTS = 3;
const RUN_LOOKUP_DELAY_MS = 4000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isRepo = r => /^[\w.-]+\/[\w.-]+$/.test(String(r || ''));
const tailLines = text => String(text || '').split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n');

// The keys a workflow actually accepts under workflow_dispatch.inputs. Read from
// the YAML text (the API list does not expose them) so a dispatch never sends an
// input the workflow does not declare — GitHub answers 422 to extras.
// Comments are skipped; only the FIRST indentation level under `inputs:` counts,
// so `description:` / `type:` / `default:` of a key are not mistaken for keys.
function declaredDispatchInputs(yaml) {
  const keys = [];
  let inDispatch = false, inputsIndent = null, keyIndent = null;
  for (const line of String(yaml || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inDispatch) {
      if (/^workflow_dispatch\s*:/.test(trimmed)) inDispatch = true;
      continue;
    }
    if (/^inputs\s*:/.test(trimmed) && inputsIndent === null) { inputsIndent = indent; continue; }
    if (inputsIndent === null) continue;
    if (indent <= inputsIndent) break;
    if (keyIndent === null) keyIndent = indent;
    if (indent !== keyIndent) continue;
    const m = trimmed.match(/^([A-Za-z_][\w-]*)\s*:/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Candidate workflows, best first: the conventional file names for a manual
// test workflow, then anything that looks like tests, then the rest.
function workflowPriority(w) {
  const base = String(w.path || w.name || '').split('/').pop();
  if (base === 'ci.yml') return 0;
  if (base === 'manual-tests.yml') return 1;
  if (/manual|test/i.test(base)) return 2;
  return 3;
}

function readWorkflowSource(repo, workflow, defaultBranch) {
  const wfPath = workflow.path || `.github/workflows/${workflow.name}`;
  return ghFetch(`${GH_API}/repos/${repo}/contents/${wfPath}?ref=${encodeURIComponent(defaultBranch)}`)
    .then(f => (f && f.content ? Buffer.from(String(f.content).replace(/\n/g, ''), 'base64').toString('utf8') : ''))
    .catch(() => '');
}

module.exports = {
  isReady: () => true,
  setupTools: [],

  tools: {

    cicd_track_pr: {
      description: 'Call this right after opening a PR (github_create_pr / gh pr create) so the durable GTD ' +
        'controller tracks it to completion (CI green → merged → deployed) on its own — no manual "remind me in ' +
        '20 minutes" needed, and it survives restarts. Writes a checklist.md in the current project directory; the ' +
        'background controller re-checks CI/merge status directly via the GitHub API for free and only wakes an ' +
        'expensive Claude/Codex session if something actually still needs attention. Works from any MCP client ' +
        '(Claude Code, Codex, etc.) — this is the shared reflex, not a client-local convention.',
      inputSchema: {
        type: 'object',
        required: ['pr_url'],
        properties: {
          pr_url: { type: 'string', description: 'Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123' },
          goal: { type: 'string', description: 'One-line description of what the PR does (optional)' },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Checklist item texts. Default: CI green, merged to main, deployed and verified live.',
          },
        },
      },
      handler: async ({ pr_url, goal, items }) => {
        const checklistItems = (Array.isArray(items) && items.length ? items : [
          'CI зелёный',
          'Смержено в main',
          'Задеплоено и проверено вживую',
        ]);

        const checklistPath = path.join(process.cwd(), CHECKLIST_FILE);
        const goalLine = `Goal: ${goal ? `${goal} — ` : ''}${pr_url}`;
        const itemLines = checklistItems.map(t => `- [ ] ${t}`).join('\n');

        let content = `${goalLine}\n\n${itemLines}\n`;
        let mode = 'created';
        if (fs.existsSync(checklistPath)) {
          // Append below existing content instead of clobbering an in-flight checklist —
          // a project can have more than one PR being tracked over its lifetime.
          const existing = fs.readFileSync(checklistPath, 'utf8').replace(/\s*$/, '');
          content = `${existing}\n\n---\n\n${goalLine}\n\n${itemLines}\n`;
          mode = 'appended';
        }
        fs.writeFileSync(checklistPath, content);

        return {
          ok: true,
          checklist_path: checklistPath,
          mode,
          items: checklistItems,
          note: 'checklist.md written — the GTD controller picks it up automatically after this turn ends, ' +
            'no extra registration call needed.',
        };
      },
    },

    ci_run_branch: {
      description: 'Run the repository\'s full test suite in the cloud for a BRANCH (GitHub workflow_dispatch) and ' +
        'get the answer back: the run id, then its status, the failed jobs and the tail of the failing log. Use it ' +
        'instead of running a big suite locally (or polling CI by hand) — it only dispatches and reads: it never ' +
        'merges anything and never deploys. Call without run_id to START a run (branch + optional suite); call with ' +
        'run_id to CHECK one. If the repo has no manual workflow yet, the reply says so and points at the ci-setup ' +
        'playbook that adds it.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name, e.g. trained-assist/trained-assist-agent' },
          ref: { type: 'string', description: 'Branch to test (dispatch mode). Omit for the default branch.' },
          suite: { type: 'string', description: 'Optional test suite input the workflow declares (unit|scenario|staging|all).' },
          run_id: { type: ['integer', 'string'], description: 'Existing run to CHECK (status mode). Omit to dispatch a new run.' },
        },
      },
      handler: async (args = {}) => {
        const repo = args.repo;
        if (!isRepo(repo)) return { ok: false, error: 'no-repo', hint: 'Передай repo как owner/name.' };
        // Explicit contract error BEFORE any API call: a missing token must be
        // told apart from a red test run, not swallowed as one.
        if (!hasToken()) {
          return { ok: false, error: 'no-github-token', configured: null,
            hint: 'GitHub-токен не задан. Вызови connect({service: "github"}) — получишь защищённую ссылку для ввода токена.' };
        }

        /* ── status mode ─────────────────────────────────────────────────── */
        if (args.run_id != null && args.run_id !== '') {
          const runId = String(args.run_id);
          let run;
          try { run = await ghFetch(`${GH_API}/repos/${repo}/actions/runs/${runId}`); }
          catch (e) {
            if (/404/.test(e.message)) return { ok: false, error: `run ${runId} not found`, run_id: runId };
            return { ok: false, error: 'github-unreachable', detail: e.message, run_id: runId };
          }
          if (!run) return { ok: false, error: `run ${runId} not found`, run_id: runId };
          const started = run.run_started_at || run.created_at || null;
          const ended = run.updated_at || null;
          const duration = started && ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(started)) / 1000)) : null;
          const base = {
            run_id: run.id, status: run.status || null, conclusion: run.conclusion || null,
            duration, url: run.html_url || null, branch: run.head_branch || null, workflow: run.name || null,
          };
          if (run.status !== 'completed') {
            return { ok: true, finished: false, ...base,
              hint: 'Прогон ещё идёт — проверь снова (или жди через ci_run_green).' };
          }
          if (run.conclusion === 'success') return { ok: true, finished: true, ...base };
          if (RED_CONCLUSIONS.has(run.conclusion)) {
            return { ok: false, finished: true, error: `run ${run.conclusion}`, ...base };
          }
          // conclusion === 'failure': hand over what to fix.
          const failedJobs = [];
          let logTail = '';
          try {
            const jobs = await ghFetch(`${GH_API}/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&status=failure&per_page=30`);
            for (const job of (jobs && jobs.jobs) || []) {
              failedJobs.push({ name: job.name || null, id: job.id, url: job.html_url || null });
              if (!logTail) {
                try { logTail = tailLines(await ghText(`${GH_API}/repos/${repo}/actions/jobs/${job.id}/logs`)); }
                catch { /* a job without logs must not hide the verdict */ }
              }
            }
          } catch { /* jobs are evidence, not the verdict */ }
          return { ok: true, finished: true, ...base, failed_jobs: failedJobs, log_tail: logTail };
        }

        /* ── dispatch mode ───────────────────────────────────────────────── */
        let wfList;
        try { wfList = await ghFetch(`${GH_API}/repos/${repo}/actions/workflows?per_page=100`); }
        catch (e) { return { ok: false, error: 'github-unreachable', detail: e.message }; }
        const workflows = ((wfList && wfList.workflows) || []).filter(w => !w.state || w.state === 'active');
        if (!workflows.length) {
          return { ok: false, configured: false,
            hint: 'В репозитории нет ни одного workflow. Запусти плейбук ci-setup — он добавит ручной прогон тестов из templates/ci.yml.' };
        }

        let defaultBranch = 'main';
        try {
          const info = await ghFetch(`${GH_API}/repos/${repo}`);
          if (info && info.default_branch) defaultBranch = info.default_branch;
        } catch { /* default branch is a fallback, not a hard requirement */ }

        // The API list does not say which trigger a workflow has — read the
        // files, best candidate first, and stop at the first that dispatches.
        let chosen = null, source = '';
        for (const w of [...workflows].sort((a, b) => workflowPriority(a) - workflowPriority(b)).slice(0, 12)) {
          const src = await readWorkflowSource(repo, w, defaultBranch);
          if (/workflow_dispatch/.test(src)) { chosen = w; source = src; break; }
        }
        if (!chosen) {
          return { ok: false, configured: false,
            hint: 'Ни один workflow не умеет ручной запуск (workflow_dispatch). Запусти плейбук ci-setup — он добавит его.' };
        }

        const declared = declaredDispatchInputs(source);
        const testedRef = String(args.ref || defaultBranch);
        const body = declared.includes('ref')
          // Dispatch FROM the default branch (a branch may not carry the
          // workflow file at all) and pass the branch under test as an input
          // the checkout step uses.
          ? { ref: defaultBranch, inputs: { ref: testedRef } }
          // No ref input declared: GitHub can only run the workflow that lives
          // on the branch itself, so dispatch straight onto it.
          : { ref: testedRef };
        if (declared.includes('suite') && args.suite) body.inputs.suite = String(args.suite);

        const dispatchedAt = Date.now();
        try {
          await ghFetch(`${GH_API}/repos/${repo}/actions/workflows/${chosen.id}/dispatches`,
            { method: 'POST', body: JSON.stringify(body) });
        } catch (e) {
          return { ok: false, configured: true, error: 'dispatch-failed', detail: e.message, workflow: chosen.name || null };
        }

        // Find OUR run among the workflow-dispatch runs: created no earlier
        // than the dispatch, newest first. GitHub publishes runs with a lag, so
        // a short in-process retry — never a long hang inside one tool call.
        let own = null;
        for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS && !own; attempt++) {
          if (attempt) await sleep(RUN_LOOKUP_DELAY_MS);
          try {
            const list = await ghFetch(`${GH_API}/repos/${repo}/actions/workflows/${chosen.id}/runs?event=workflow_dispatch&per_page=30`);
            const candidates = ((list && list.workflow_runs) || []).filter(r =>
              r.event === 'workflow_dispatch' && Date.parse(r.created_at || '') >= dispatchedAt - 60_000);
            if (candidates.length) own = candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
          } catch { /* retry */ }
        }
        if (!own) {
          return { ok: true, configured: true, run_id: null, workflow: chosen.name || null, ref: testedRef,
            url: `https://github.com/${repo}/actions`,
            hint: 'Диспатч отправлен, но свой ран ещё не появился. Открой вкладку Actions репозитория или повтори вызов через минуту.' };
        }
        return { ok: true, configured: true, run_id: own.id, url: own.html_url || null,
          workflow: chosen.name || null, ref: testedRef, dispatched_ref: body.ref };
      },
    },

  },
};
