'use strict';

const { hasToken, getToken } = require('./client');
const { execFileSync } = require('node:child_process');

const API = 'https://api.github.com';
const MIN_INTERVAL_SECONDS = 180;
const DEFAULT_INTERVAL_SECONDS = 180;
const DEFAULT_TIMEOUT_MINUTES = 15;
const MAX_TIMEOUT_MINUTES = 90;
const TERMINAL_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required',
  'neutral', 'startup_failure', 'stale',
]);
const FAILING_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

function validateInput(input) {
  if (!input || typeof input !== 'object') return 'Передай параметры ожидания.';
  if (typeof input.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) return 'repo должен иметь формат owner/repo.';
  if (!(input.run_id != null || (typeof input.sha === 'string' && input.sha.trim()) || Number.isInteger(input.pr_number))) {
    return 'Передай run_id, sha или pr_number.';
  }
  const interval = input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS;
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > 3600) {
    return `interval_seconds должен быть от ${MIN_INTERVAL_SECONDS} до 3600 (не чаще одного запроса в три минуты).`;
  }
  const timeout = input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MINUTES) {
    return `timeout_minutes должен быть от 1 до ${MAX_TIMEOUT_MINUTES}.`;
  }
  if (input.check_names !== undefined && (!Array.isArray(input.check_names) || input.check_names.length === 0 || input.check_names.some(n => typeof n !== 'string' || !n.trim()))) {
    return 'check_names должен быть непустым массивом имён проверок.';
  }
  return null;
}

function conditionSummary(input) {
  if (input.run_id != null) return `завершения Actions run ${input.run_id}`;
  if (input.pr_number != null) return `завершения проверок PR #${input.pr_number}`;
  return `завершения проверок commit ${input.sha}`;
}

function classifyChecks(checkRuns, names) {
  const selected = names?.length ? checkRuns.filter(run => names.includes(run.name)) : checkRuns;
  const missing = names?.filter(name => !selected.some(run => run.name === name)) || [];
  const finished = selected.length > 0 && missing.length === 0 && selected.every(run =>
    run.status === 'completed' && (run.conclusion == null || TERMINAL_CONCLUSIONS.has(run.conclusion)));
  const outcome = !finished ? 'pending'
    : selected.some(run => FAILING_CONCLUSIONS.has(run.conclusion)) ? 'failure'
      : selected.every(run => run.conclusion === 'success') ? 'success' : 'completed_with_non_success';
  const aggregate = (runs) => {
    const grouped = new Map();
    for (const run of runs) {
      const key = `${run.name}\\0${run.status}\\0${run.conclusion || ''}`;
      const value = grouped.get(key) || { name: run.name, status: run.status, conclusion: run.conclusion || null, count: 0, url: run.html_url || null };
      value.count += 1;
      grouped.set(key, value);
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.conclusion).localeCompare(String(b.conclusion)));
  };
  return {
    finished,
    outcome,
    check_count: selected.length,
    completed_check_count: selected.filter(run => run.status === 'completed' && TERMINAL_CONCLUSIONS.has(run.conclusion)).length,
    checks: aggregate(selected),
    failed_checks: aggregate(selected.filter(run => FAILING_CONCLUSIONS.has(run.conclusion))),
    non_success_checks: aggregate(selected.filter(run => run.status === 'completed' && run.conclusion !== 'success' && !FAILING_CONCLUSIONS.has(run.conclusion))),
    pending_checks: aggregate(selected.filter(run => run.status !== 'completed' || !TERMINAL_CONCLUSIONS.has(run.conclusion))),
    missing_checks: missing,
  };
}

function makeClient(fetchImpl, token, signal) {
  return async function request(route) {
    const timeoutSignal = AbortSignal.timeout(15000);
    const response = await fetchImpl(`${API}${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'trained-assist-engineering-ci-wait',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.message || response.statusText || `GitHub API ${response.status}`);
      error.status = response.status;
      error.retryAfter = response.headers?.get?.('retry-after') || null;
      error.rateLimitReset = response.headers?.get?.('x-ratelimit-reset') || null;
      throw error;
    }
    const data = await response.json();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data._rate_limit_remaining = response.headers?.get?.('x-ratelimit-remaining') ?? null;
      data._rate_limit_reset = response.headers?.get?.('x-ratelimit-reset') ?? null;
    }
    return data;
  };
}

function resolveToken() {
  try {
    if (hasToken()) return getToken();
  } catch {
    // Try the user's GitHub CLI credentials before falling back to public-only reads.
  }
  try {
    return execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

async function snapshot(input, request) {
  const repo = encodeURIComponent(input.repo).replace('%2F', '/');
  if (input.run_id != null) {
    const run = await request(`/repos/${repo}/actions/runs/${encodeURIComponent(String(input.run_id))}`);
    const complete = run.status === 'completed';
    let failedJobs = [];
    const shouldFetchJobs = !complete || FAILING_CONCLUSIONS.has(run.conclusion);
    if (shouldFetchJobs) {
      try {
        const jobs = await request(`/repos/${repo}/actions/runs/${encodeURIComponent(String(input.run_id))}/jobs?filter=latest&per_page=100`);
        failedJobs = (jobs.jobs || [])
          .filter(job => FAILING_CONCLUSIONS.has(job.conclusion))
          .map(job => ({
            name: job.name || null, conclusion: job.conclusion, url: job.html_url || null,
          }));
      } catch {
        // Keep the run verdict even when optional job details are unavailable.
      }
    }
    const outcome = failedJobs.length > 0 ? 'failure'
      : !complete ? 'pending'
        : FAILING_CONCLUSIONS.has(run.conclusion) ? 'failure'
          : run.conclusion === 'success' ? 'success' : 'completed_with_non_success';
    return {
      finished: complete || failedJobs.length > 0,
      outcome,
      run: { run_id: run.id, status: run.status || null, conclusion: run.conclusion || null, url: run.html_url || null, branch: run.head_branch || null, sha: run.head_sha || null, workflow: run.name || null },
      failed_jobs: failedJobs,
      rate_limit_remaining: run._rate_limit_remaining,
      rate_limit_reset: run._rate_limit_reset,
      check_count: 1,
      completed_check_count: complete ? 1 : 0,
      checks: [], failed_checks: failedJobs, non_success_checks: [], pending_checks: [], missing_checks: [],
    };
  }

  let sha = input.sha;
  let prUrl = input.pr_url || null;
  let mergeable = null;
  let mergeStateStatus = null;
  if (input.pr_number != null) {
    const pr = await request(`/repos/${repo}/pulls/${input.pr_number}`);
    sha = pr.head?.sha || sha;
    prUrl = pr.html_url || prUrl;
    mergeable = pr.mergeable ?? mergeable;
    mergeStateStatus = pr.mergeable_state || mergeStateStatus;
    if (!sha) throw new Error(`GitHub не вернул head SHA для PR #${input.pr_number}.`);
  }
  let page = 1;
  let result;
  let runs = [];
  try {
    do {
      result = await request(`/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&page=${page}`);
      const batch = Array.isArray(result.check_runs) ? result.check_runs : [];
      runs = runs.concat(batch);
      if (!batch.length || runs.length >= Number(result.total_count || 0)) break;
      page += 1;
    } while (page <= 10);
  } catch (error) {
    if (!error || error.status !== 404) throw error;
    runs = [];
    result = null;
  }
  let totalChecks = Number(result?.total_count || runs.length);
  let partial = runs.length < totalChecks && runs.length > 0;
  // Fall back to commit statuses when no check-runs are published for this commit.
  if (!runs.length) {
    try {
      const status = await request(`/repos/${repo}/commits/${encodeURIComponent(sha)}/status`);
      const statuses = Array.isArray(status.statuses) ? status.statuses : [];
      if (statuses.length) {
        runs = statuses.map(item => ({
          name: item.context || 'status',
          status: item.state === 'pending' ? 'in_progress' : 'completed',
          conclusion: item.state === 'success' ? 'success'
            : item.state === 'pending' ? null
              : 'failure',
          html_url: item.target_url || null,
        }));
        totalChecks = runs.length;
        partial = false;
        result = status;
      }
    } catch (error) {
      if (error && (error.status === 404 || error.status === 403)) {
        // ignore; try workflow runs below
      } else {
        throw error;
      }
    }
  }
  // Fall back to workflow runs when neither check-runs nor statuses are available.
  if (!runs.length) {
    try {
      const actions = await request(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`);
      const workflowRuns = Array.isArray(actions.workflow_runs) ? actions.workflow_runs : [];
      if (workflowRuns.length) {
        runs = workflowRuns.map(item => ({
          name: item.name || 'workflow',
          status: item.status === 'completed' ? 'completed' : 'in_progress',
          conclusion: item.conclusion || null,
          html_url: item.html_url || null,
        }));
        totalChecks = runs.length;
        partial = false;
        result = actions;
      }
    } catch (error) {
      if (!error || error.status !== 404) throw error;
    }
  }
  const state = classifyChecks(runs, input.check_names);
  return {
    ...state,
    finished: (state.finished || (Array.isArray(state.failed_checks) && state.failed_checks.length > 0)) && !partial,
    outcome: partial ? 'pending' : state.outcome,
    sha,
    pr_url: prUrl,
    mergeable,
    merge_state_status: mergeStateStatus,
    total_checks: totalChecks,
    fetched_check_count: runs.length,
    partial,
    rate_limit_remaining: result?._rate_limit_remaining,
    rate_limit_reset: result?._rate_limit_reset,
  };
}

function report(input, state, startedAt, polls, extra = {}, now = Date.now) {
  const elapsed = Math.max(0, Math.round((now() - startedAt) / 1000));
  const label = state.state === 'cancelled' ? 'Ожидание отменено; агент может повторить его с новыми условиями.'
    : state.state === 'timed_out' ? 'Срок ожидания вышел, проверки ещё не завершились.'
    : state.state === 'rate_limited' ? 'Ожидание приостановлено из-за близкого лимита GitHub; проверь сохранённый статус позже.'
      : state.outcome === 'success' ? 'Все выбранные проверки завершились успешно.'
        : state.outcome === 'failure' ? 'Проверки завершились с ошибкой или были отменены.'
          : state.outcome === 'completed_with_non_success' ? 'Проверки завершились, но часть была пропущена, нейтральна или устарела; проверь требуемые checks.'
            : state.outcome === 'pending' ? 'Ожидание завершилось до готовности всех проверок.' : 'Ожидание завершилось с ошибкой.';
  return {
    ok: state.state !== 'error',
    state: state.state,
    outcome: state.outcome,
    summary: label,
    condition: conditionSummary(input),
    elapsed_seconds: elapsed,
    polls,
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    timeout_minutes: input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
    ...state.snapshot,
    ...(state.error ? { error: state.error } : {}),
    ...extra,
  };
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function waitForCi(input, deps = {}) {
  const invalid = validateInput(input);
  if (invalid) return { ok: false, state: 'invalid_request', error: invalid };
  const normalized = {
    ...input,
    interval_seconds: input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    timeout_minutes: input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
  };
  const fetchImpl = deps.fetch || globalThis.fetch;
  const wait = deps.sleep || (ms => sleep(ms, deps.signal));
  const now = deps.now || Date.now;
  let token = null;
  try {
    if (deps.token !== undefined) token = deps.token;
    else token = resolveToken();
  } catch {
    return { ok: false, state: 'error', error: 'GitHub token недоступен или не читается.' };
  }
  const request = makeClient(fetchImpl, token, deps.signal);
  const startedAt = now();
  const deadline = startedAt + normalized.timeout_minutes * 60_000;
  let polls = 0;
  let lastSnapshot;

  while (true) {
    if (deps.signal?.aborted) {
      return report(normalized, { state: 'cancelled', outcome: 'pending', snapshot: lastSnapshot }, startedAt, polls, {}, now);
    }
    if (polls > 0 && now() >= deadline) {
      return report(normalized, { state: 'timed_out', outcome: 'pending', snapshot: lastSnapshot }, startedAt, polls, {}, now);
    }
    polls += 1;
    try {
      lastSnapshot = await snapshot(normalized, request);
      if (normalized.pr_number != null && !normalized.sha && lastSnapshot.sha) {
        normalized.sha = lastSnapshot.sha;
        normalized.pr_url = lastSnapshot.pr_url;
      }
    } catch (error) {
      if (deps.signal?.aborted) {
        return report(normalized, { state: 'cancelled', outcome: 'pending', snapshot: lastSnapshot }, startedAt, polls, {}, now);
      }
      const status = error.status;
      if (status === 401 || status === 403 || status === 404 || status === 429) {
        const reason = status === 401 ? 'GitHub отклонил авторизацию.'
          : status === 403 ? 'Недостаточно прав для чтения этих проверок либо исчерпан лимит GitHub.'
            : status === 404 ? 'Репозиторий, PR, commit или run не найден либо недоступен этому токену.'
              : 'GitHub rate limit достигнут; ожидание остановлено до сброса лимита.';
        return report(normalized, { state: 'error', outcome: 'error', error: reason }, startedAt, polls,
          { http_status: status, retry_after: error.retryAfter || null, rate_limit_reset: error.rateLimitReset || null }, now);
      }
      if (now() >= deadline) {
        return report(normalized, { state: 'error', outcome: 'error', error: `Не удалось получить состояние GitHub: ${error.message}` }, startedAt, polls, {}, now);
      }
      await wait(Math.min(normalized.interval_seconds * 1000, Math.max(0, deadline - now())));
      continue;
    }
    const hasFailure = (Array.isArray(lastSnapshot.failed_checks) && lastSnapshot.failed_checks.length > 0)
      || (Array.isArray(lastSnapshot.failed_jobs) && lastSnapshot.failed_jobs.length > 0);
    if (lastSnapshot.finished || hasFailure) {
      const outcome = hasFailure ? 'failure' : lastSnapshot.outcome;
      return report(normalized, { state: 'completed', outcome, snapshot: { ...lastSnapshot, outcome } }, startedAt, polls, {}, now);
    }
    if (!token && lastSnapshot.rate_limit_remaining !== null && Number(lastSnapshot.rate_limit_remaining) <= 5) {
      return report(normalized, {
        state: 'rate_limited', outcome: 'pending', snapshot: lastSnapshot,
        error: 'Осталось мало анонимных запросов GitHub; остановил ожидание до исчерпания общего IP-лимита.',
      }, startedAt, polls, {}, now);
    }
    if (now() >= deadline) {
      return report(normalized, { state: 'timed_out', outcome: 'pending', snapshot: lastSnapshot }, startedAt, polls, {}, now);
    }
    await wait(Math.min(normalized.interval_seconds * 1000, Math.max(0, deadline - now())));
  }
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  MIN_INTERVAL_SECONDS,
  classifyChecks,
  validateInput,
  waitForCi,
};
