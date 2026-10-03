'use strict';

// GitHub facts for change_status (#112).
//
// Two rules shape this file:
//   - every collector is guarded. A failing lookup becomes `unknown` with the
//     error code, never a guessed verdict and never a thrown exception that
//     would lose the facts the other collectors already produced.
//   - access problems are not answers. If the repository itself cannot be read,
//     the whole call fails honestly (GITHUB_AUTH / NOT_FOUND) instead of
//     reporting six stages of «unknown» as if the change simply does not exist.

const { ghFetch: defaultGhFetch, classify } = require('../github/client');
const { prStatus, issueStatus, prodVerdict } = require('../github/pr-status-core');

const PR_WINDOW = 30;

function errorCode(e) {
  const c = classify(e);
  return (c && c.code) || 'GITHUB_ERROR';
}

function errorOf(e) {
  return { code: errorCode(e), message: (e && e.message) || String(e) };
}

async function safe(fn, fallback) {
  try { return { value: await fn() }; } catch (e) { return { error: errorOf(e) }; }
}

function prFact(pr) {
  return {
    number: pr.number,
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    merged_at: pr.merged_at || null,
    merge_commit_sha: pr.merge_commit_sha || null,
    head_sha: pr.head_sha || null,
    head_ref: pr.head_ref || null,
    base_ref: pr.base_ref || null,
    url: pr.url || null,
    ci: pr.ci ? { status: pr.ci.status, verdict: pr.ci.verdict, total: pr.ci.check_runs_total } : null,
  };
}

async function accessProbe(repo, ghFetch) {
  try {
    const identity = await ghFetch(`/repos/${repo}`);
    return { ok: true, identity: { id: identity.id, full_name: identity.full_name, default_branch: identity.default_branch || 'main', private: Boolean(identity.private) } };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

/** Full PR fact via prStatus (#52) — one implementation, no second GitHub client. */
async function collectPr(repo, number, ghFetch, prStatusImpl, prodVerdictImpl) {
  const impl = prStatusImpl || prStatus;
  const prod = prodVerdictImpl || prodVerdict;
  const r = await impl(repo, number, { include_logs: false, enrich: true });
  if (!r.ok) {
    return { pr: null, error: r.error || { code: 'GITHUB_ERROR', message: 'pr_status failed' }, delivered: { verdict: 'unknown', note: 'PR не прочитан' } };
  }
  const fact = prFact(r.pr);
  fact.ci = r.ci;
  let delivered = { verdict: 'unknown', note: 'PR не смержен — доставлять нечего' };
  if (r.pr.merged && r.pr.merge_commit_sha) {
    const v = await safe(() => prod(repo, r.pr.merge_commit_sha), null);
    if (v.error) delivered = { verdict: 'unknown', note: `проверка прода не удалась: ${v.error.code}`, merge_commit: r.pr.merge_commit_sha };
    else delivered = { ...v.value, merge_commit: r.pr.merge_commit_sha };
  }
  return { pr: fact, prod: r.prod || null, delivered, ghFetchUsed: typeof ghFetch === 'function' };
}

function pickPrimary(prs) {
  const list = (prs || []).filter(Boolean);
  if (!list.length) return null;
  const merged = list.filter(p => p.merged);
  if (merged.length) return merged.reduce((a, b) => ((a.merged_at || '') >= (b.merged_at || '') ? a : b));
  return list.reduce((a, b) => ((a.created_at || '') >= (b.created_at || '') ? a : b));
}

function summarisePrList(prs) {
  return (prs || []).map(p => ({
    number: p.number,
    state: p.state,
    merged: Boolean(p.merged),
    merged_at: p.merged_at || null,
    head_ref: p.head_ref || null,
    head_sha: p.head_sha || null,
    url: p.url || null,
  }));
}

async function collectBranch(repo, branch, ghFetch, prStatusImpl, defaultBranch, prodVerdictImpl) {
  const out = { branch, head_sha: null, commit: null, prs: [], merged_into_default: null, errors: [] };

  const head = await safe(() => ghFetch(`/repos/${repo}/commits/${encodeURIComponent(branch)}`), null);
  if (head.error) out.errors.push({ source: 'commit', ...head.error });
  else out.head_sha = head.value.sha;

  const [owner] = String(repo).split('/');
  const prsRes = await safe(
    () => ghFetch(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=${PR_WINDOW}`),
    null,
  );
  let prList = [];
  if (prsRes.error) out.errors.push({ source: 'branch-prs', ...prsRes.error });
  else {
    prList = (Array.isArray(prsRes.value) ? prsRes.value : []).map(p => ({
      number: p.number,
      state: p.state,
      merged: Boolean(p.merged_at),
      merged_at: p.merged_at || null,
      merge_commit_sha: p.merge_commit_sha || null,
      head_sha: p.head && p.head.sha,
      head_ref: p.head && p.head.ref,
      base_ref: p.base && p.base.ref,
      url: p.html_url || null,
      created_at: p.created_at,
    }));
    out.prs = summarisePrList(prList);
  }

  const def = defaultBranch || 'main';
  if (out.head_sha) {
    const cmp = await safe(() => ghFetch(`/repos/${repo}/compare/${encodeURIComponent(out.head_sha)}...${encodeURIComponent(def)}`), null);
    if (cmp.error) out.errors.push({ source: 'compare', ...cmp.error });
    else {
      // base=sha, head=default: 'behind' means the default branch already
      // contains this sha.
      const st = cmp.value && cmp.value.status;
      out.merged_into_default = st === 'behind' || st === 'identical' ? true : (st === 'ahead' || st === 'diverged' ? false : null);
      out.compare_status = st || null;
      out.default_head_sha = (cmp.value && cmp.value.commits && cmp.value.commits.length)
        ? (cmp.value.commits[cmp.value.commits.length - 1].sha || null)
        : null;
    }
  }

  const primary = pickPrimary(prList);
  let pr = null;
  let delivered = { verdict: 'unknown', note: 'нет смерженного PR для этой ветки' };
  if (primary) {
    const c = await collectPr(repo, primary.number, ghFetch, prStatusImpl, prodVerdictImpl);
    if (c.error) out.errors.push({ source: 'pr', ...c.error });
    pr = c.pr;
    delivered = c.delivered;
  }
  return { pr, prs: out.prs, branch: out, delivered };
}

async function collectCommit(repo, sha, ghFetch, prStatusImpl, defaultBranch, prodVerdictImpl) {
  const out = { sha, commit: null, prs: [], errors: [] };

  const head = await safe(() => ghFetch(`/repos/${repo}/commits/${encodeURIComponent(sha)}`), null);
  if (head.error) out.errors.push({ source: 'commit', ...head.error });
  else out.commit = { sha: head.value.sha, date: (head.value.commit && head.value.commit.committer && head.value.commit.committer.date) || null };

  const prsRes = await safe(
    () => ghFetch(`/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`, { headers: { Accept: 'application/vnd.github.groot-preview+json' } }),
    null,
  );
  let prList = [];
  if (prsRes.error) out.errors.push({ source: 'commit-prs', ...prsRes.error });
  else {
    prList = (Array.isArray(prsRes.value) ? prsRes.value : []).map(p => ({
      number: p.number,
      state: p.state,
      merged: Boolean(p.merged_at),
      merged_at: p.merged_at || null,
      merge_commit_sha: p.merge_commit_sha || null,
      head_sha: p.head && p.head.sha,
      head_ref: p.head && p.head.ref,
      base_ref: p.base && p.base.ref,
      url: p.html_url || null,
      created_at: p.created_at,
    }));
    out.prs = summarisePrList(prList);
  }

  const def = defaultBranch || 'main';
  const cmp = await safe(() => ghFetch(`/repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(def)}`), null);
  if (cmp.error) out.errors.push({ source: 'compare', ...cmp.error });
  else {
    const st = cmp.value && cmp.value.status;
    out.merged_into_default = st === 'behind' || st === 'identical' ? true : (st === 'ahead' || st === 'diverged' ? false : null);
    out.compare_status = st || null;
  }

  const primary = pickPrimary(prList);
  let pr = null;
  let delivered = { verdict: 'unknown', note: 'коммит не привязан к PR — merge-коммита нет, прод не проверяется' };
  if (primary) {
    const c = await collectPr(repo, primary.number, ghFetch, prStatusImpl, prodVerdictImpl);
    if (c.error) out.errors.push({ source: 'pr', ...c.error });
    pr = c.pr;
    delivered = c.delivered;
  }
  return { pr, prs: out.prs, commit_ref: out, delivered };
}

async function collectIssue(repo, number, issueStatusImpl, prStatusImpl, prodVerdictImpl) {
  const impl = issueStatusImpl || issueStatus;
  const r = await impl(repo, number, { include_logs: false });
  if (!r.ok) return { pr: null, prs: [], issue: null, error: r.error, delivered: { verdict: 'unknown', note: 'issue не прочитана' } };
  const prs = (r.prs || []).map(p => ({
    ...p,
    merged: Boolean(p.merged),
    merged_at: p.merged_at || null,
    merge_commit_sha: p.merge_commit_sha || null,
    created_at: null,
  }));
  const primary = pickPrimary(prs.map(p => ({ ...p, merged: p.merged, merged_at: p.merged_at })));
  let pr = null;
  let delivered = { verdict: 'unknown', note: `у issue #${number} нет смерженного PR` };
  if (primary) {
    const c = await collectPr(repo, primary.number, null, prStatusImpl, prodVerdictImpl);
    if (c.error) return { pr: null, prs, issue: r.issue, error: c.error, delivered };
    pr = c.pr;
    delivered = c.delivered;
  }
  return {
    pr,
    prs: prs.map(p => ({ number: p.number, state: p.state, merged: p.merged, merged_at: p.merged_at, head_ref: p.head_ref, head_sha: p.head_sha, url: p.url })),
    issue: r.issue,
    delivered,
  };
}

module.exports = {
  accessProbe,
  collectPr,
  collectBranch,
  collectCommit,
  collectIssue,
  pickPrimary,
  summarisePrList,
  prFact,
  errorCode,
  errorOf,
  PR_WINDOW,
};