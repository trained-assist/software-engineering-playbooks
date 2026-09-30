'use strict';

// pr_status / issue_status core (#52, план a738d291).
//
// One call answers "where is this change now": open/merged, which checks ran,
// the compressed tail of the jobs that failed, whether the merge commit reached
// production, and whether an autofix PR exists. issue_status lists every PR
// linked to an issue, including cross-repo ones.
//
// Contract choices that are load-bearing:
//   - prStatus never throws: it returns {ok:true,…} or {ok:false, error:{code,…}}
//     (R12). The alias github_pr_checks keeps its historical THROWING behaviour
//     and does that conversion at the registration layer (62-pr-status.js /
//     60-github.js).
//   - prod verdict `live` comes ONLY from the health-compare path. A green
//     deploy job is evidence, never a verdict (decision on ⚫ R9, 29.09).
//   - everything that is extra (log fetch, autofix search, prod compare) is
//     guarded: a stub or an API hiccup must never fail the main answer.

const { ghFetch, ghGraphql, classify } = require('./client');
const { compressLog, estTokens } = require('./compress-log');

const DEFAULT_HEALTH_BASE = 'https://136-65-7-197.sslip.io/agent';
const AGENT_REPO = 'trained-assist/trained-assist-agent';

const FAILED_CONCLUSIONS = new Set(['failure', 'action_required', 'timed_out', 'cancelled']);
const FAILED_RUN_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

const LOG_TAIL_CHARS = 60000;      // raw tail taken from a job log before compressing
const LOG_JOB_BUDGET = 400;        // tokens per job, keeps a PR answer near ~1.5k
const MAX_FAILED_JOBS = 3;
const RESPONSE_BUDGET_TOKENS = 1500;
const MAX_CHECK_RUNS = 20;
const MAX_FAILED_JOBS_BUDGET = 2;
const MAX_LOG_TAIL_BUDGET = 8000;

// ── check aggregation ────────────────────────────────────────────────────────

// Same semantics as github_pr_checks had (legacy `status`), plus the new
// four-value `verdict`. `status` and `verdict` are deliberately two scales:
// status keeps old consumers working, verdict is what the new tool reports.
function aggregate(runs, commitStatus, actionsRuns) {
  const summary = { total: runs.length, completed: 0, in_progress: 0, queued: 0, pending: 0 };
  const byConclusion = {};
  for (const r of runs) {
    if (r.status === 'completed') summary.completed++;
    else if (r.status === 'in_progress') { summary.in_progress++; summary.pending++; }
    else if (r.status === 'queued') { summary.queued++; summary.pending++; }
    byConclusion[r.conclusion || r.status] = (byConclusion[r.conclusion || r.status] || 0) + 1;
  }
  const failed = [...FAILED_CONCLUSIONS].some(c => byConclusion[c]);
  const pending = summary.pending > 0;
  const nonBlocking = (byConclusion.skipped || 0) + (byConclusion.neutral || 0);
  const meaningful = runs.length - nonBlocking;

  let status;
  if (runs.length) {
    if (failed) status = 'failure';
    else if (pending) status = 'pending';
    else if (meaningful > 0 && (byConclusion.success || 0) === meaningful) status = 'success';
    else status = 'neutral';
  } else if (commitStatus && commitStatus.total_count && commitStatus.state !== 'no-status') {
    const cs = commitStatus.state;
    status = cs === 'success' ? 'success' : (cs === 'pending' ? 'pending' : 'failure');
  } else if (actionsRuns && actionsRuns.total_count) {
    const wr = actionsRuns.workflow_runs || [];
    status = wr.some(r => FAILED_RUN_CONCLUSIONS.has(r.conclusion)) ? 'failure'
      : wr.some(r => r.status !== 'completed') ? 'pending'
      : 'success';
  } else {
    status = 'no-checks';
  }

  const verdict = status === 'failure' ? 'red'
    : status === 'pending' ? 'pending'
    : status === 'success' ? 'green'
    : 'none';

  return { status, verdict, summary, byConclusion, failed };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ok(err) {
  return typeof err === 'object' && err !== null && typeof err.status === 'number' ? err : null;
}

function failFrom(err) {
  const c = classify(err);
  const error = { code: c.code, message: String((err && err.message) || 'unknown error') };
  if (c.reset_at) error.reset_at = c.reset_at;
  return { ok: false, error };
}

async function safeGet(path, fallback) {
  try { return await ghFetch(path); } catch { return fallback; }
}

async function fetchChecks(repo, sha) {
  let runs = [];
  let commitStatus = null;
  if (sha) {
    try {
      const data = await ghFetch(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      runs = (data && data.check_runs) || [];
    } catch (e) {
      if (!e || e.status !== 404) throw e;
    }
    if (!runs.length) {
      try { commitStatus = await ghFetch(`/repos/${repo}/commits/${sha}/status`); }
      catch (e) { if (!e || e.status !== 404) throw e; }
    }
  }
  // Fine-grained PATs cannot read check-runs (R13): fall back to workflow runs.
  let actionsRuns = null;
  if (!runs.length && (!commitStatus || !commitStatus.total_count) && sha) {
    actionsRuns = await safeGet(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`, null);
  }
  return { runs, commitStatus, actionsRuns };
}

function checkRunsView(runs) {
  return runs.map(r => ({
    name: r.name,
    workflow_name: r.app && r.app.name,
    status: r.status,
    conclusion: r.conclusion,
    started_at: r.started_at,
    completed_at: r.completed_at,
    details_url: r.html_url,
  }));
}

function failedCheckList(agg) {
  if (!agg.failed) return [];
  return Object.keys(agg.byConclusion)
    .filter(c => FAILED_CONCLUSIONS.has(c))
    .map(c => ({ conclusion: c, count: agg.byConclusion[c] }));
}

function runIdFromCheckRun(r) {
  const url = (r && (r.html_url || r.details_url)) || '';
  const m = String(url).match(/\/runs\/(\d+)/);
  if (m) return m[1];
  const suite = r && r.check_suite && r.check_suite.id;
  return suite ? String(suite) : null;
}

// Failed-job log tails: run_id from the failed check-runs → jobs → job logs
// (GitHub 302s to a signed URL, fetch follows it) → tail → compressLog.
async function collectFailedJobs(repo, runs, agg, limit) {
  if (!agg.failed) return [];
  const runIds = [...new Set(runs.filter(r => FAILED_CONCLUSIONS.has(r.conclusion)).map(runIdFromCheckRun).filter(Boolean))];
  if (!runIds.length) return [];

  const failed = [];
  for (const runId of runIds.slice(0, 3)) {
    const data = await safeGet(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, null);
    const jobs = (data && data.jobs) || [];
    for (const j of jobs) {
      if (!FAILED_CONCLUSIONS.has(j.conclusion)) continue;
      failed.push({ id: j.id, name: j.name, conclusion: j.conclusion, url: j.html_url });
      if (failed.length >= limit) break;
    }
    if (failed.length >= limit) break;
  }

  const out = [];
  for (const j of failed) {
    const entry = { name: j.name, url: j.url, conclusion: j.conclusion, log_tail: null };
    try {
      const res = await ghFetch(`/repos/${repo}/actions/jobs/${j.id}/logs`);
      const raw = String(typeof res === 'string' ? res : JSON.stringify(res)).slice(-LOG_TAIL_CHARS);
      entry.log_tail = compressLog(raw, LOG_JOB_BUDGET);
    } catch (e) {
      const st = e && typeof e.status === 'number' ? e.status : null;
      entry.log_error = st === 404 || st === 410 ? 'expired' : 'unavailable';
    }
    out.push(entry);
  }
  return out;
}

// autofix: branch `fix/ci-<safe(base_or_head_ref)>-<ts>` (autofix.mjs:1786).
// A failure here must not fail the answer — hence the guard + autofix_error.
async function findAutofix(repo, headRef) {
  const list = await safeGet(`/repos/${repo}/pulls?state=all&per_page=50`, null);
  if (!Array.isArray(list) || !list.length) return { autofix_pr: null };
  const safe = String(headRef || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  const prefix = `fix/ci-${safe}-`;
  const matches = list.filter(p => String((p.head && p.head.ref) || '').startsWith(prefix));
  if (!matches.length) return { autofix_pr: null };
  matches.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const f = matches[0];
  let checks_verdict = 'none';
  if (f.head && f.head.sha) {
    try {
      const d = await ghFetch(`/repos/${repo}/commits/${f.head.sha}/check-runs?per_page=100`);
      checks_verdict = aggregate((d && d.check_runs) || [], null, null).verdict;
    } catch { checks_verdict = 'unknown'; }
  }
  return { autofix_pr: { number: f.number, url: f.html_url, state: f.state, checks_verdict } };
}

async function deployEvidence(repo, sha) {
  try {
    const runs = await ghFetch(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`);
    const list = (runs && runs.workflow_runs) || [];
    const green = list.find(r => /deploy/i.test(String(r.name || '')) && r.conclusion === 'success');
    if (green) return { evidence: 'deploy-green', source: 'deploy-job', deploy_run: green.html_url };
    return { evidence: 'no-prod-endpoint', source: 'none' };
  } catch {
    return { evidence: 'no-prod-endpoint', source: 'none' };
  }
}

// `live` only from health-compare. deploy-job/`merged_at` are evidence, never a
// verdict — a green deploy job does not prove the merge commit is running.
async function prodVerdict(repo, mergeCommit) {
  const base = String(process.env.AGENT_PUBLIC_URL || DEFAULT_HEALTH_BASE).replace(/\/+$/, '');
  let health = null;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
    if (res && res.ok) health = await res.json();
  } catch { health = null; }
  const healthCommit = health && health.commit;
  if (!healthCommit) {
    const ev = await deployEvidence(repo, mergeCommit);
    return { verdict: 'unknown', evidence: 'health-unreachable', source: ev.source || 'none' };
  }
  try {
    const cmp = await ghFetch(`/repos/${repo}/compare/${mergeCommit}...${healthCommit}`);
    const st = cmp && cmp.status;
    if (st === 'identical' || st === 'ahead') {
      return { verdict: 'live', source: 'health-compare', compare: st, health_commit: healthCommit };
    }
    return { verdict: 'not_yet', source: 'health-compare', compare: st, health_commit: healthCommit, behind_by: cmp && cmp.behind_by };
  } catch {
    const ev = await deployEvidence(repo, mergeCommit);
    return { verdict: 'unknown', evidence: ev.evidence, source: ev.source, deploy_run: ev.deploy_run };
  }
}

function applyBudget(resp) {
  if (estTokens(JSON.stringify(resp)) <= RESPONSE_BUDGET_TOKENS) return resp;
  const omitted = {};
  if (Array.isArray(resp.check_runs) && resp.check_runs.length > MAX_CHECK_RUNS) {
    omitted.check_runs = resp.check_runs.length - MAX_CHECK_RUNS;
    resp.check_runs = resp.check_runs.slice(0, MAX_CHECK_RUNS);
  }
  if (Array.isArray(resp.failed_jobs) && resp.failed_jobs.length > MAX_FAILED_JOBS_BUDGET) {
    omitted.failed_jobs = resp.failed_jobs.length - MAX_FAILED_JOBS_BUDGET;
    resp.failed_jobs = resp.failed_jobs.slice(0, MAX_FAILED_JOBS_BUDGET);
  }
  if (Array.isArray(resp.failed_jobs)) {
    for (const j of resp.failed_jobs) {
      if (j.log_tail && j.log_tail.length > MAX_LOG_TAIL_BUDGET) j.log_tail = j.log_tail.slice(-MAX_LOG_TAIL_BUDGET);
    }
  }
  resp.truncated = true;
  resp.truncated_omitted = omitted;
  return resp;
}

// ── prStatus ─────────────────────────────────────────────────────────────────

async function prStatus(repo, prNumber, opts = {}) {
  const {
    head_sha = null,
    include_logs = true,
    enrich = true,
    max_failed_jobs = MAX_FAILED_JOBS,
  } = opts || {};
  const n = Number(prNumber);

  let pr;
  try {
    pr = await ghFetch(`/repos/${repo}/pulls/${n}`);
  } catch (e) {
    if (e && e.status === 404) {
      // Distinguish "this number is an issue" from "nothing here".
      let issue = null;
      try { issue = await ghFetch(`/repos/${repo}/issues/${n}`); } catch { issue = null; }
      if (issue && !issue.pull_request) {
        return {
          ok: false,
          error: {
            code: 'NOT_A_PR',
            message: `GitHub API 404: #${n} is an issue, not a pull request — use issue_status`,
            hint: 'Это issue, а не PR. Вызови issue_status(repo, issue_number), чтобы получить связанные PR.',
          },
        };
      }
    }
    return failFrom(e);
  }

  const sha = head_sha || (pr.head && pr.head.sha);
  // prStatus never throws (R12): a failing checks lookup degrades to "no evidence".
  let checks = { runs: [], commitStatus: null, actionsRuns: null };
  try { checks = await fetchChecks(repo, sha); } catch { /* keep empty */ }
  const { runs, commitStatus, actionsRuns } = checks;
  const agg = aggregate(runs, commitStatus, actionsRuns);

  const resp = {
    ok: true,
    repo,
    pr_number: pr.number,
    pr: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      mergeable: pr.mergeable,
      merge_commit_sha: pr.merge_commit_sha,
      merged_at: pr.merged_at,
      head_sha: pr.head && pr.head.sha,
      head_ref: pr.head && pr.head.ref,
      base_ref: pr.base && pr.base.ref,
      url: pr.html_url,
    },
    ci: {
      status: agg.status,
      verdict: agg.verdict,
      check_runs_total: runs.length,
      check_runs_failed: failedCheckList(agg),
      commit_status_state: commitStatus && commitStatus.state,
    },
    summary: agg.summary,
    check_runs: checkRunsView(runs),
  };

  if (include_logs) {
    try {
      resp.failed_jobs = await collectFailedJobs(repo, runs, agg, max_failed_jobs);
    } catch { resp.failed_jobs = []; }
  }

  if (enrich) {
    let af = { autofix_pr: null };
    try { af = await findAutofix(repo, pr.head && pr.head.ref); }
    catch (e) { af = { autofix_pr: null, autofix_error: String((e && e.message) || 'autofix lookup failed') }; }
    resp.autofix_pr = af.autofix_pr;
    if (af.autofix_error) resp.autofix_error = af.autofix_error;

    if (pr.merged && pr.merge_commit_sha) {
      try { resp.prod = await prodVerdict(repo, pr.merge_commit_sha); }
      catch (e) { resp.prod = { verdict: 'unknown', evidence: 'unavailable', source: 'none', error: String((e && e.message) || '') }; }
    }
    applyBudget(resp);
  }

  return resp;
}

// ── issueStatus ──────────────────────────────────────────────────────────────

const GQL_TIMELINE = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], first: 100) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest { number state merged url headRefName repository { nameWithOwner } }
            }
          }
          ... on ConnectedEvent {
            subject {
              __typename
              ... on PullRequest { number state merged url headRefName repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}`;

function pushRef(list, seen, repo, number, ref, origin) {
  const r = String(repo || '').trim();
  const num = Number(number);
  if (!r || !Number.isFinite(num) || num <= 0) return;
  const key = `${r}#${num}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ repo: r, number: num, ref: ref || key, origin });
}

function parseUrlRef(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

// GraphQL timeline is the primary source (checked 29.09 on agent#1725: 4 PRs in
// 2 repos). REST timeline and body/comment links are fallbacks.
async function linkedPulls(repo, issue) {
  const refs = [];
  const seen = new Set();
  const [owner, name] = String(repo).split('/');

  try {
    const body = await ghGraphql(GQL_TIMELINE, { owner, name, number: Number(issue.number) });
    const nodes = body && body.data && body.data.repository && body.data.repository.issue
      && body.data.repository.issue.timelineItems && body.data.repository.issue.timelineItems.nodes;
    for (const node of nodes || []) {
      const src = (node && (node.source || node.subject)) || null;
      if (!src || src.__typename !== 'PullRequest' || !src.number) continue;
      const r = (src.repository && src.repository.nameWithOwner) || null;
      pushRef(refs, seen, r, src.number, src.url, 'timeline');
    }
  } catch { /* REST fallback below */ }

  if (!refs.length) {
    try {
      const events = await ghFetch(`/repos/${repo}/issues/${issue.number}/timeline`, {
        headers: { Accept: 'application/vnd.github.mockingbird-preview+json' },
      });
      for (const ev of Array.isArray(events) ? events : []) {
        if (ev.event !== 'cross-referenced' && ev.event !== 'connected') continue;
        const src = ev.source || {};
        const target = src.issue || src.pull_request || {};
        const fromUrl = parseUrlRef(target.html_url || target.url);
        const r = fromUrl ? fromUrl.repo
          : (target.repository && (target.repository.full_name || target.repository.name)) || null;
        pushRef(refs, seen, r, fromUrl ? fromUrl.number : target.number, target.html_url, 'timeline-rest');
      }
    } catch { /* links below */ }
  }

  // Links from the issue body and its comments (`#N`, `owner/repo#N`, /pull/N).
  const texts = [issue.body || ''];
  try {
    const comments = await safeGet(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`, []);
    for (const c of Array.isArray(comments) ? comments : []) texts.push(c.body || '');
  } catch { /* comments are best-effort */ }
  for (const text of texts) {
    for (const m of text.matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g)) {
      pushRef(refs, seen, m[1], m[2], null, 'link');
    }
    for (const m of text.matchAll(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g)) {
      pushRef(refs, seen, `${m[1]}/${m[2]}`, m[3], m[0], 'link');
    }
    for (const m of text.matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
      pushRef(refs, seen, repo, m[1], null, 'link');
    }
  }

  return refs;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function issueStatus(repo, issueNumber, opts = {}) {
  const { max_prs = 10, include_logs = false } = opts || {};
  const n = Number(issueNumber);

  let issue;
  try { issue = await ghFetch(`/repos/${repo}/issues/${n}`); }
  catch (e) { return failFrom(e); }

  const refs = await linkedPulls(repo, issue);
  const picked = refs.slice(0, Math.max(1, Math.min(max_prs, 10)));

  const results = await mapLimit(picked, 3, async ref => {
    const compact = await prStatus(ref.repo, ref.number, { include_logs, enrich: false });
    if (!compact.ok) {
      if (compact.error && compact.error.code === 'NOT_A_PR') return null; // an issue link, not a PR
      return { repo: ref.repo, number: ref.number, ref: ref.ref, url: null, error: 'no_access' };
    }
    return {
      repo: ref.repo,
      number: compact.pr.number,
      ref: ref.ref,
      url: compact.pr.url,
      state: compact.pr.state,
      merged: compact.pr.merged,
      verdict: compact.ci.verdict,
      checks: {
        status: compact.ci.status,
        verdict: compact.ci.verdict,
        total: compact.ci.check_runs_total,
        failed: compact.ci.check_runs_failed,
      },
    };
  });

  return {
    ok: true,
    issue: { number: issue.number, state: issue.state, title: issue.title, url: issue.html_url },
    prs: results.filter(Boolean),
    prs_omitted: Math.max(0, refs.length - picked.length),
  };
}

module.exports = { prStatus, issueStatus, aggregate, linkedPulls, prodVerdict };
