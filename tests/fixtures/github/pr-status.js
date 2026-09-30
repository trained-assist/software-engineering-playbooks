'use strict';

// Фикстуры GitHub API для песочницы pr_status / issue_status (issue #52,
// план a738d291). Один источник данных на два потребителя:
//   - scripts/sandbox/pr-status.mjs — замкнутый цикл сценария (шаги 1–6);
//   - tests/pr-status*.test.js      — юниты на фикстурах (срезы S3–S5).
//
// Формы ответов сверены с реальным GitHub API 29.09.2026: /status при нуле
// статусов = {state:'pending', total_count:0}, чекраны, actions/runs,
// GraphQL timelineItems (CrossReferencedEvent.source → PullRequest; источник
// без inline-фрагмента приходит пустым объектом — так и моделируем).
//
//   resolve(method, url) → { status?, headers?, body } | null
//     body — объект (JSON) или строка (текст лога); status по умолчанию 200.
//     null = маршрут не задан → 404 {"message":"Not Found"} (как у GitHub).

const REPO_X = 'trained-assist/X';
const REPO_Y = 'trained-assist/Y';
const REPO_SKILL = 'trained-assist/skill';
const REPO_AGENT = 'trained-assist/trained-assist-agent';
const REPO_PB = 'trained-assist/software-engineering-playbooks';
const REPO_PRIVATE = 'trained-assist/other-private';

function pr(o) {
  return {
    number: o.number,
    title: o.title || `fixture PR ${o.number}`,
    state: o.state || 'open',
    draft: false,
    merged: !!o.merged,
    merge_commit_sha: o.mergeCommit || null,
    merged_at: o.mergedAt || null,
    mergeable: true,
    html_url: `https://github.com/${o.repo}/pull/${o.number}`,
    user: { login: 'kobzevvv' },
    head: { sha: o.headSha, ref: o.headRef },
    base: { ref: 'main' },
  };
}

function checkRun(id, name, conclusion, runsId) {
  return {
    id,
    name,
    status: 'completed',
    conclusion,
    started_at: '2026-09-29T04:00:00Z',
    completed_at: '2026-09-29T04:05:00Z',
    app: { name: 'GitHub Actions' },
    html_url: `https://github.com/${REPO_X}/actions/runs/${runsId}/job/${id}`,
    details_url: `https://github.com/${REPO_X}/actions/runs/${runsId}/job/${id}`,
  };
}

// Шаг 1: открытый PR с упавшим CI — падает ci, staging-gate зелёный.
const RED_RUNS = [
  checkRun(111, 'ci', 'failure', 101),
  checkRun(112, 'staging-gate', 'success', 101),
  checkRun(113, 'notify', 'success', 101),
];
const GREEN_RUNS = [
  checkRun(121, 'ci', 'success', 150),
  checkRun(122, 'staging-gate', 'success', 150),
];

// Шаг 6: заведомо сверх бюджета (~60 прогонов, 6 падений) → truncated:true.
const BUDGET_RUNS = Array.from({ length: 60 }, (_, i) => {
  const failed = i < 6;
  const id = 900000 + i;
  return {
    id,
    name: failed ? `ci / shard ${i}` : `ci / ok ${i}`,
    status: 'completed',
    conclusion: failed ? (i % 2 ? 'failure' : 'timed_out') : 'success',
    started_at: '2026-09-29T05:00:00Z',
    completed_at: '2026-09-29T05:10:00Z',
    app: { name: 'GitHub Actions' },
    html_url: `https://github.com/${REPO_X}/actions/runs/201/job/${id}`,
    details_url: `https://github.com/${REPO_X}/actions/runs/201/job/${id}`,
  };
});

function job(name, conclusion, runId) {
  return {
    id: Number(String(name).match(/\d+/)?.[0] || 0),
    run_id: runId,
    name,
    status: 'completed',
    conclusion,
    html_url: `https://github.com/${REPO_X}/actions/runs/${runId}/job/${name.match(/\d+/)?.[0] || 0}`,
  };
}

const JOBS_RUN_101 = {
  total_count: 2,
  jobs: [job('unit-22', 'failure', 101), job('e2e-23', 'timed_out', 101)],
};
const JOBS_RUN_201 = {
  total_count: 5,
  jobs: [
    job('shard-31', 'failure', 201),
    job('shard-32', 'failure', 201),
    job('shard-33', 'timed_out', 201),
    job('shard-34', 'cancelled', 201),
    job('shard-35', 'action_required', 201),
  ],
};

// Реалистичный хвост джобы: ~400 строк шума, затем падение и стек —
// сжатый хвост обязан быть заметно короче сырого лога и сохранить ошибку.
function jobLog(seed, lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(`2026-09-29T04:0${i % 10}:00Z INFO  [runner] ${seed} step=${i} ok duration=${30 + (i % 7)}ms`);
  }
  out.push('');
  out.push('FAIL tests/regression.test.js');
  out.push('  scenario > must return a typed error');
  out.push('    AssertionError: expected 404 to equal 200');
  for (let i = 0; i < 24; i++) out.push(`      at Object.<anonymous> (tests/regression.test.js:${42 + i}:11)`);
  out.push('##[error]Process completed with exit code 1.');
  return out.join('\n');
}

const JOB_LOG_22 = jobLog('tests/regression.test.js', 400);
const budgetLogCache = new Map();
function budgetLog(id) {
  if (!budgetLogCache.has(id)) budgetLogCache.set(id, jobLog(`tests/shard-${id}.test.js`, 120));
  return budgetLogCache.get(id);
}

const PR42 = pr({ repo: REPO_X, number: 42, headSha: 'sha-red', headRef: 'feature/red-change', title: 'feat: change that turns CI red' });
const PR77 = pr({ repo: REPO_X, number: 77, state: 'closed', merged: true, mergeCommit: 'sha-merged', mergedAt: '2026-09-29T02:19:15Z', headSha: 'sha-head77', headRef: 'release/r77' });
const PR99 = pr({ repo: REPO_X, number: 99, headSha: 'sha-budget', headRef: 'huge/change', title: 'chore: over-budget response' });
const PR78 = pr({ repo: REPO_Y, number: 78, state: 'closed', merged: true, mergeCommit: 'sha-y', mergedAt: '2026-09-28T10:00:00Z', headSha: 'sha-head78', headRef: 'release/r78' });
const PR5 = pr({ repo: REPO_SKILL, number: 5, state: 'closed', merged: true, mergeCommit: 'sha-skill', mergedAt: '2026-09-27T10:00:00Z', headSha: 'sha-head5', headRef: 'hotfix/skill' });
const PR1843 = pr({ repo: REPO_AGENT, number: 1843, state: 'closed', merged: true, mergeCommit: 'sha-ag1843m', mergedAt: '2026-09-29T02:19:15Z', headSha: 'sha-ag1843', headRef: 'eng/plan-roots' });
const PR48 = pr({ repo: REPO_PB, number: 48, state: 'closed', merged: true, mergeCommit: 'sha-pb48m', mergedAt: '2026-09-20T10:00:00Z', headSha: 'sha-pb48', headRef: 'eng/fix-1725-repo-input' });
const AUTOFIX43 = {
  number: 43,
  title: '[auto-fix] ci: feature/red-change',
  state: 'open',
  merged: false,
  merge_commit_sha: null,
  merged_at: null,
  html_url: `https://github.com/${REPO_X}/pull/43`,
  user: { login: 'github-actions[bot]' },
  head: { sha: 'sha-fix43', ref: 'fix/ci-feature-red-change-1727000000' },
  base: { ref: 'feature/red-change' },
};

// Весь репозиторий X одним запросом: autofix ищется фильтром head.ref по
// ^fix/ci-<safe(ветка PR)>- — сматчится только #43 для ветки feature/red-change.
const X_PULLS_ALL = [PR99, PR77, AUTOFIX43, PR42];

const ISSUE_52 = {
  number: 52,
  state: 'open',
  title: 'Инструмент «что с PR / что с issue» одной командой',
  html_url: `https://github.com/${REPO_X}/issues/52`,
  comments: 3,
  labels: [],
  user: { login: 'kobzevvv' },
};

const crossRef = (number, state, merged, repo, ref) => ({
  __typename: 'CrossReferencedEvent',
  source: {
    __typename: 'PullRequest',
    number,
    state,
    merged,
    url: `https://github.com/${repo}/pull/${number}`,
    headRefName: ref,
    repository: { nameWithOwner: repo },
  },
});

const GRAPHQL_TIMELINE = {
  data: {
    repository: {
      issue: {
        timelineItems: {
          nodes: [
            { __typename: 'CrossReferencedEvent', source: {} },
            crossRef(42, 'OPEN', false, REPO_X, 'feature/red-change'),
            crossRef(42, 'OPEN', false, REPO_X, 'feature/red-change'),
            crossRef(1843, 'MERGED', true, REPO_AGENT, 'eng/plan-roots'),
            crossRef(48, 'MERGED', true, REPO_PB, 'eng/fix-1725-repo-input'),
            crossRef(7, 'OPEN', false, REPO_PRIVATE, 'secret/work'),
          ],
        },
      },
    },
  },
};

const DEPLOY_RUNS = {
  total_count: 1,
  workflow_runs: [{
    id: 301,
    name: 'deploy',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'sha-skill',
    head_branch: 'main',
    html_url: `https://github.com/${REPO_SKILL}/actions/runs/301`,
  }],
};
const EMPTY_RUNS = { total_count: 0, workflow_runs: [] };

// [method, pathname-regex, responder] — важен порядок: частные маршруты
// раньше общих. Responder получает разобранный URL и возвращает
// { status?, headers?, body }.
const ROUTES = [
  ['GET', /^\/repos\/auth-test\//, () => ({ status: 401, body: { message: 'Bad credentials' } })],
  ['POST', /^\/graphql$/, () => ({ body: GRAPHQL_TIMELINE })],
  ['GET', /^\/agent\/health$/, () => ({ body: { status: 'alive', commit: 'sha-merged' } })],

  ['GET', /^\/repos\/trained-assist\/X\/pulls\/42$/, () => ({ body: PR42 })],
  ['GET', /^\/repos\/trained-assist\/X\/pulls\/77$/, () => ({ body: PR77 })],
  ['GET', /^\/repos\/trained-assist\/X\/pulls\/99$/, () => ({ body: PR99 })],
  ['GET', /^\/repos\/trained-assist\/Y\/pulls\/78$/, () => ({ body: PR78 })],
  ['GET', /^\/repos\/trained-assist\/skill\/pulls\/5$/, () => ({ body: PR5 })],
  ['GET', /^\/repos\/trained-assist\/trained-assist-agent\/pulls\/1843$/, () => ({ body: PR1843 })],
  ['GET', /^\/repos\/trained-assist\/software-engineering-playbooks\/pulls\/48$/, () => ({ body: PR48 })],
  ['GET', /^\/repos\/trained-assist\/X\/pulls$/, () => ({ body: X_PULLS_ALL })],
  ['GET', /^\/repos\/[^/]+\/[^/]+\/pulls$/, () => ({ body: [] })],

  ['GET', /^\/repos\/trained-assist\/X\/commits\/sha-red\/check-runs/, () => ({ body: { total_count: RED_RUNS.length, check_runs: RED_RUNS } })],
  ['GET', /^\/repos\/trained-assist\/X\/commits\/sha-red\/status$/, () => ({
    body: {
      state: 'failure', sha: 'sha-red', total_count: 2,
      statuses: [{ context: 'ci', state: 'failure' }, { context: 'staging-gate', state: 'success' }],
    },
  })],
  ['GET', /^\/repos\/trained-assist\/X\/commits\/sha-merged\/check-runs/, () => ({ body: { total_count: GREEN_RUNS.length, check_runs: GREEN_RUNS } })],
  ['GET', /^\/repos\/trained-assist\/X\/commits\/sha-head77\/check-runs/, () => ({ body: { total_count: GREEN_RUNS.length, check_runs: GREEN_RUNS } })],
  ['GET', /^\/repos\/trained-assist\/X\/commits\/sha-budget\/check-runs/, () => ({ body: { total_count: BUDGET_RUNS.length, check_runs: BUDGET_RUNS } })],
  ['GET', /^\/repos\/trained-assist\/Y\/commits\/sha-(y|head78)\/check-runs/, () => ({ body: { total_count: GREEN_RUNS.length, check_runs: GREEN_RUNS } })],
  ['GET', /^\/repos\/trained-assist\/skill\/commits\/sha-(skill|head5)\/check-runs/, () => ({ body: { total_count: GREEN_RUNS.length, check_runs: GREEN_RUNS } })],
  ['GET', /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs/, () => ({ body: { total_count: 0, check_runs: [] } })],
  ['GET', /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/, () => ({ body: { state: 'pending', sha: 'unknown', total_count: 0, statuses: [] } })],

  ['GET', /^\/repos\/trained-assist\/skill\/actions\/runs$/, u => (
    u.searchParams.get('head_sha') === 'sha-skill' ? { body: DEPLOY_RUNS } : { body: EMPTY_RUNS }
  )],
  ['GET', /^\/repos\/[^/]+\/[^/]+\/actions\/runs$/, () => ({ body: EMPTY_RUNS })],
  ['GET', /^\/repos\/trained-assist\/X\/actions\/runs\/101\/jobs$/, () => ({ body: JOBS_RUN_101 })],
  ['GET', /^\/repos\/trained-assist\/X\/actions\/runs\/201\/jobs$/, () => ({ body: JOBS_RUN_201 })],

  ['GET', /\/actions\/jobs\/22\/logs$/, () => ({ status: 302, headers: { location: '/fixtures/job-22.log' } })],
  ['GET', /\/actions\/jobs\/23\/logs$/, () => ({ status: 410, body: 'Log expired and unavailable to download' })],
  ['GET', /\/actions\/jobs\/3[1-5]\/logs$/, u => {
    const id = u.pathname.match(/jobs\/(\d+)\/logs/)[1];
    return { status: 302, headers: { location: `/fixtures/job-${id}.log` } };
  }],
  ['GET', /^\/fixtures\/job-22\.log$/, () => ({ body: JOB_LOG_22 })],
  ['GET', /^\/fixtures\/job-3[1-5]\.log$/, u => ({ body: budgetLog(u.pathname.match(/job-(\d+)/)[1]) })],

  ['GET', /^\/repos\/trained-assist\/X\/issues\/52$/, () => ({ body: ISSUE_52 })],
  ['GET', /^\/repos\/trained-assist\/X\/compare\/sha-merged\.\.\.sha-merged$/, () => ({
    body: { status: 'identical', ahead_by: 0, behind_by: 0, base_commit: { sha: 'sha-merged' } },
  })],
  ['GET', /^\/repos\/trained-assist\/Y\/compare\/sha-y\.\.\.sha-merged$/, () => ({
    body: { status: 'diverged', ahead_by: 3, behind_by: 2, base_commit: { sha: 'sha-y' } },
  })],
];

function resolve(method, url) {
  let u;
  try { u = new URL(url); } catch { u = new URL(url, 'https://api.github.com'); }
  for (const [m, re, responder] of ROUTES) {
    if (m !== method || !re.test(u.pathname)) continue;
    const r = responder(u) || {};
    return { status: r.status === undefined ? 200 : r.status, headers: r.headers, body: r.body };
  }
  return null;
}

module.exports = {
  resolve,
  JOB_LOG_22,
  RED_RUNS,
  GREEN_RUNS,
  BUDGET_RUNS,
  REPOS: { X: REPO_X, Y: REPO_Y, SKILL: REPO_SKILL, AGENT: REPO_AGENT, PB: REPO_PB, PRIVATE: REPO_PRIVATE },
};
