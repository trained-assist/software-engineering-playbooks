'use strict';

// engineering_repo_status (#109): one call → the engineering status of one
// repository: what it is, where its default branch is, the newest PR by
// creation, the newest MERGED PR (by merged_at), open PRs/issues with counts
// and bounded lists, and a CI summary for the current head when available.
//
// Contract decisions that are load-bearing (#109):
//   - a closed PR is NOT a merge: the last merge is picked by `merged_at`, and
//     when no merged PR falls into the fetched window the answer is explicitly
//     unknown instead of "the newest closed PR";
//   - "works in production" is never inferred from the age of the last PR — the
//     CI section is about the head commit's checks only;
//   - every section carries its own observed_at / source / error, so a partial
//     answer is visibly partial;
//   - the access probe (GET /repos/{owner}/{repo}) runs on EVERY call, before
//     any cached section is served: private access is never answered from cache.

const { ghFetch: defaultGhFetch, classify } = require('../github/client');
const { aggregate } = require('../github/pr-status-core');
const { loadDefinitions } = require('../repo-catalog/catalog');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MERGE_WINDOW = 30;          // closed PRs scanned for the newest merge
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const CACHE = new Map();          // repo -> { builtAt, sections }

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// classify() returns a small object ({code, reset_at?}), not a bare string.
function errorCode(e) {
  const c = classify(e);
  return (c && c.code) || 'GITHUB_ERROR';
}

function sectionError(e) {
  return { code: errorCode(e), message: e && e.message ? e.message : String(e) };
}

function purposeFor(fullName, description, nowFn) {
  const defs = loadDefinitions(nowFn);
  const override = defs.status === 'ok' ? defs.data.purposes[fullName] : null;
  return {
    text: override && override.text ? override.text : (description || ''),
    source: override ? 'definitions' : 'github',
    derived: Boolean(override && override.derived),
  };
}

function prSummary(pr) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: Boolean(pr.draft),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged_at: pr.merged_at || null,
    user: pr.user ? pr.user.login : null,
    head_ref: pr.head ? pr.head.ref : null,
    head_sha: pr.head ? pr.head.sha : null,
    merge_commit_sha: pr.merge_commit_sha || null,
    url: pr.html_url || null,
  };
}

function issueSummary(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    updated_at: item.updated_at,
    labels: (item.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    url: item.html_url || null,
  };
}

async function section(name, fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: sectionError(e) };
  }
}

async function collectSections(repo, identity, { limits, ghFetch, now }) {
  const observedAt = new Date(now()).toISOString();
  const base = `/repos/${repo}`;
  const defaultBranch = identity.default_branch || 'main';
  const meta = { source: 'github', observed_at: observedAt };

  const head = await section('head', async () => {
    const list = await ghFetch(`${base}/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=1`);
    const c = Array.isArray(list) ? list[0] : null;
    if (!c) throw new Error(`no commit returned for ${defaultBranch}`);
    return {
      branch: defaultBranch,
      sha: c.sha,
      committed_at: c.commit && c.commit.committer ? c.commit.committer.date : null,
      subject: c.commit && c.commit.message ? String(c.commit.message).split('\n')[0] : null,
      author: c.commit && c.commit.author ? c.commit.author.name : null,
      ...meta,
    };
  });

  const latestPr = await section('latest_pr_created', async () => {
    const list = await ghFetch(`${base}/pulls?state=all&sort=created&direction=desc&per_page=1`);
    const pr = Array.isArray(list) ? list[0] : null;
    return pr
      ? { found: true, ...prSummary(pr), ...meta }
      : { found: false, note: 'no pull requests in this repository', ...meta };
  });

  const latestMerge = await section('latest_merge', async () => {
    const list = await ghFetch(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGE_WINDOW}`);
    const merged = (Array.isArray(list) ? list : []).filter(pr => pr.merged_at);
    if (!merged.length) {
      return {
        found: false,
        note: `no merged PR among the ${MERGE_WINDOW} most recently updated closed PRs`,
        window: MERGE_WINDOW,
        ...meta,
      };
    }
    const newest = merged.reduce((a, b) => (a.merged_at >= b.merged_at ? a : b));
    return {
      found: true,
      ...prSummary(newest),
      closed_without_merge: (Array.isArray(list) ? list : []).filter(pr => !pr.merged_at).length,
      window: MERGE_WINDOW,
      ...meta,
    };
  });

  const openPrs = await section('open_prs', async () => {
    const list = await ghFetch(`${base}/pulls?state=open&sort=created&direction=desc&per_page=${limits.prs}`);
    const search = await ghFetch(`/search/issues?q=${encodeURIComponent(`repo:${repo} type:pr state:open`)}&per_page=1`);
    const items = (Array.isArray(list) ? list : []).map(prSummary);
    const count = search && typeof search.total_count === 'number' ? search.total_count : null;
    return {
      count,
      returned: items.length,
      // With a bounded list the honest continuation cursor is the page number.
      next_cursor: items.length === limits.prs ? String(limits.prs) : null,
      items,
      ...meta,
    };
  });

  const openIssues = await section('open_issues', async () => {
    const search = await ghFetch(`/search/issues?q=${encodeURIComponent(`repo:${repo} type:issue state:open`)}&per_page=${limits.issues}`);
    const count = search && typeof search.total_count === 'number' ? search.total_count : null;
    const items = (Array.isArray(search && search.items) ? search.items : []).map(issueSummary);
    return {
      count,
      returned: items.length,
      next_cursor: items.length === limits.issues ? String(limits.issues) : null,
      items,
      ...meta,
    };
  });

  const ci = await section('ci', async () => {
    if (head.error) return { found: false, note: 'head commit unknown — CI summary unavailable', ...meta };
    const sha = head.value.sha;
    const runs = await ghFetch(`${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
    const list = (runs && Array.isArray(runs.check_runs)) ? runs.check_runs : [];
    const agg = aggregate(list, null, null);
    const byConclusion = {};
    for (const r of list) {
      const key = r.conclusion || r.status || 'unknown';
      byConclusion[key] = (byConclusion[key] || 0) + 1;
    }
    return {
      commit_sha: sha,
      total: list.length,
      by_conclusion: byConclusion,
      status: agg.status,
      ...meta,
    };
  });

  return { head, latestPr, latestMerge, openPrs, openIssues, ci, observedAt };
}

async function repoStatus(input = {}, deps = {}) {
  const ghFetch = deps.ghFetch || defaultGhFetch;
  const now = deps.now || Date.now;
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw fail('INVALID_REPO', `repo must be "owner/name", got "${input.repo}"`);
  }

  const limitsInput = input.limits && typeof input.limits === 'object' ? input.limits : {};
  const normLimit = (v) => {
    const n = v === undefined || v === null ? DEFAULT_LIMIT : Number(v);
    if (!Number.isFinite(n) || n < 1) throw fail('INVALID_LIMITS', `limits must be positive numbers, got "${v}"`);
    return Math.min(Math.floor(n), MAX_LIMIT);
  };
  const limits = { prs: normLimit(limitsInput.prs), issues: normLimit(limitsInput.issues) };
  const ttlMs = deps.ttlMs === undefined ? DEFAULT_TTL_MS : deps.ttlMs;

  // Access probe first, always: a private repo must 404/403 honestly, and the
  // cached sections are never served before this succeeded.
  let identity;
  try {
    identity = await ghFetch(`/repos/${repo}`);
  } catch (e) {
    return { ok: false, error: { code: errorCode(e), message: e.message } };
  }

  const cached = CACHE.get(repo);
  const fresh = cached && !input.refresh && now() - cached.builtAt < ttlMs;

  let built;
  if (fresh) {
    built = cached.built;
  } else {
    built = await collectSections(repo, identity, { limits, ghFetch, now });
    CACHE.set(repo, { builtAt: now(), built });
  }

  const sections = {};
  let partial = false;
  for (const [key, name] of [
    ['head', 'head'],
    ['latestPr', 'latest_pr_created'],
    ['latestMerge', 'latest_merge'],
    ['openPrs', 'open_prs'],
    ['openIssues', 'open_issues'],
    ['ci', 'ci'],
  ]) {
    const part = built[key];
    if (part.error) {
      partial = true;
      sections[name] = { error: part.error, built_at: built.observedAt };
    } else {
      sections[name] = { ...part.value, built_at: built.observedAt };
    }
  }

  return {
    ok: true,
    repo,
    identity: {
      id: identity.id,
      full_name: identity.full_name,
      description: identity.description || '',
      purpose: purposeFor(identity.full_name || repo, identity.description || '', now),
      default_branch: identity.default_branch || null,
      archived: Boolean(identity.archived),
      visibility: identity.visibility || (identity.private ? 'private' : 'public'),
      open_issues_count: typeof identity.open_issues_count === 'number' ? identity.open_issues_count : null,
      pushed_at: identity.pushed_at || null,
      updated_at: identity.updated_at || null,
    },
    sections,
    freshness: {
      observed_at: new Date(now()).toISOString(),
      sections_built_at: built.observedAt,
      cache: fresh ? 'hit' : 'miss',
      // A cache hit can be older than the caller expects; the age is explicit
      // so nobody reads a fresh identity as fresh PR/CI facts.
      sections_age_sec: fresh ? Math.max(0, Math.round((now() - (cached.builtAt || now())) / 1000)) : 0,
      partial,
      limits,
    },
    limitations: [
      '«последний merge» ищется по merged_at среди закрытых PR, отсортированных по updated_at (окно ' + MERGE_WINDOW + ' шт.) — GitHub не умеет сортировать по merged_at',
      'прод-статус не выводится: CI-секция описывает проверки head-коммита, а не развёрнутый прод',
      'списки ограничены limits; продолжение — увеличить limits (next_cursor — номер страницы)',
    ],
  };
}

function clearCache() {
  CACHE.clear();
}

module.exports = { repoStatus, clearCache, DEFAULT_TTL_MS, MERGE_WINDOW };