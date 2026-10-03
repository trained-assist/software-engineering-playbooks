'use strict';

// engineering_change_find (#111) — read-only: after an interruption, locate the
// work that belongs to a task (workspace / branch / commits / PR, including
// unmerged and closed ones) and return it as CANDIDATES WITH REASONS.
//
// Load-bearing contract decisions:
//   - exact identity and thematic similarity are different buckets. A ref the
//     caller stated, a saved binding or an exact workspace/task match is
//     `exact`; text-resemblance ranking is `inferred`. Exact always sorts
//     first — a «99% похоже» never outranks a stated ref.
//   - there is NO pick. `selection.auto_selected` is always false; several
//     candidates come back with their evidence, and the caller decides.
//   - authorization failures are never reported as «ничего не нашлось»: every
//     source carries its own ok/error, and an auth failure with zero candidates
//     fails the whole answer (ok:false, GITHUB_AUTH).
//   - owner scoping: local store rows are filtered by `principal`, GitHub rows
//     by `repo`. A row belonging to another profile cannot become a candidate.

const { ghFetch: defaultGhFetch, classify } = require('../github/client');
const { parseTaskRef, parseKnownRefs, normTask } = require('./refs');
const local = require('./local');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SUPERSEDE_MAX = 5;
const BRANCH_SEARCH_MAX = 3;
const SEARCH_TYPES = [['pr', 'pull'], ['issue', 'issue']];

// Priority among exact candidates: a ref the caller states right now outranks
// one the host remembers, which outranks one inferred from a workspace record.
const EXACT_ORDER = ['known_refs', 'task_ref', 'saved_binding', 'supersede_marker', 'workspace_record', 'branch_match'];

function fail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

function errorCode(e) {
  const c = classify(e);
  return (c && c.code) || 'GITHUB_ERROR';
}

function sectionError(e) {
  return { code: errorCode(e), message: e && e.message ? e.message : String(e) };
}

function normalizeRepo(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const m = raw.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/i);
  if (m) return m[1];
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return raw;
  throw fail('INVALID_REPO', `repo must be "owner/name" or a GitHub URL, got "${value}"`);
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw fail('INVALID_LIMIT', `limit must be a positive number, got "${value}"`);
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function normalizeTimeRange(value) {
  if (value === undefined || value === null || value === '') return null;
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw fail('INVALID_TIME_RANGE', 'time_range must be an object or a JSON object string'); }
  }
  if (typeof raw !== 'object') throw fail('INVALID_TIME_RANGE', 'time_range must be an object');
  const out = {};
  for (const key of ['since', 'until']) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
    const t = Date.parse(raw[key]);
    if (Number.isNaN(t)) throw fail('INVALID_TIME_RANGE', `time_range.${key} is not a valid date: "${raw[key]}"`);
    out[key] = t;
  }
  if (out.since !== undefined && out.until !== undefined && out.since > out.until) {
    throw fail('INVALID_TIME_RANGE', 'time_range.since must not be after time_range.until');
  }
  return Object.keys(out).length ? out : null;
}

function tokens(text) {
  return normTask(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

function overlapScore(needle, haystack) {
  const a = tokens(needle);
  const b = new Set(tokens(haystack));
  if (!a.length || !b.size) return 0;
  const hits = a.filter((t) => b.has(t)).length;
  return Math.round((hits / a.length) * 50);
}

function prUrl(repo, number) {
  return `https://github.com/${repo}/pull/${number}`;
}

function issueUrl(repo, number) {
  return `https://github.com/${repo}/issues/${number}`;
}

function inRange(timestamp, range) {
  if (!range || !timestamp) return true;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return true;
  if (range.since !== undefined && t < range.since) return false;
  if (range.until !== undefined && t > range.until) return false;
  return true;
}

function dedupeKey(c) {
  return `${c.kind}:${c.identity.toLowerCase()}`;
}

function priorityOf(candidate) {
  for (const source of candidate.evidence.map((e) => e.source)) {
    const idx = EXACT_ORDER.indexOf(source);
    if (idx !== -1) return idx;
  }
  return EXACT_ORDER.length;
}

function mergeCandidate(list, next) {
  const key = dedupeKey(next);
  const found = list.find((c) => dedupeKey(c) === key);
  if (!found) {
    list.push(next);
    return next;
  }
  for (const ev of next.evidence) {
    if (!found.evidence.some((e) => e.source === ev.source && e.why === ev.why)) found.evidence.push(ev);
  }
  if (next.score !== null && (found.score === null || next.score > found.score)) found.score = next.score;
  if (next.relation_type === 'exact') found.relation_type = 'exact';
  if (next.timestamp && !found.timestamp) found.timestamp = next.timestamp;
  return found;
}

function fromGitHubItem(repo, item, source, why, relationType) {
  const isPr = Boolean(item.pull_request) || item.state !== undefined && item.html_url && /\/pull\//.test(item.html_url);
  const number = item.number;
  const kind = isPr ? 'pull' : 'issue';
  return {
    relation_type: relationType,
    kind,
    identity: `${isPr ? 'PR' : 'issue'} #${number}`,
    ref: {
      number,
      repo,
      title: item.title || null,
      state: item.state || null,
      draft: Boolean(item.draft),
      author: item.user && item.user.login ? item.user.login : null,
      url: item.html_url || (isPr ? prUrl(repo, number) : issueUrl(repo, number)),
      head_ref: item.head && item.head.ref ? item.head.ref : (item.head_ref || null),
      created_at: item.created_at || null,
      updated_at: item.updated_at || null,
      merged_at: item.merged_at || null,
      labels: (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    },
    evidence: [{ source, why }],
    score: null,
    timestamp: item.updated_at || item.created_at || null,
    superseded_by: null,
  };
}

function fromBranch(repo, branch, source, why, relationType, extra = {}) {
  return {
    relation_type: relationType,
    kind: 'branch',
    identity: `branch ${branch}`,
    ref: { repo, branch, url: `https://github.com/${repo}/tree/${branch}`, ...extra },
    evidence: [{ source, why }],
    score: null,
    timestamp: extra.updated_at || extra.committed_at || null,
    superseded_by: null,
  };
}

function fromWorkspace(record, relationType, source, why) {
  return {
    relation_type: relationType,
    kind: 'workspace',
    identity: `workspace ${record.rootTaskId}`,
    ref: {
      workspace_id: record.workspaceId,
      root_task_id: record.rootTaskId,
      branch: record.branch || null,
      status: record.status || null,
      code_path: record.codePath || null,
      head_sha: (record.git && record.git.headRevision) || null,
      host: record.hostId || null,
    },
    evidence: [{ source, why }],
    score: null,
    timestamp: record.updatedAt || record.createdAt || null,
    superseded_by: null,
  };
}

function fromBindingRecord(record, relationType, source, why) {
  return {
    relation_type: relationType,
    kind: 'binding',
    identity: `binding ${record.taskRef}`,
    ref: {
      repository: record.repositoryId,
      task_ref: record.taskRef,
      refs: record.refs,
      workspace_id: record.workspaceId || null,
    },
    evidence: [{ source, why }],
    score: null,
    timestamp: record.updatedAt || record.createdAt || null,
    superseded_by: null,
  };
}

async function collectExplicitRefs({ repo, parsed, ghFetch, sources }) {
  const out = { candidates: [], unresolved: [] };
  const numbers = [];
  const commits = [];
  const branches = [];

  const note = (item, via) => {
    if (item.repo && item.repo.toLowerCase() !== repo.toLowerCase()) {
      out.unresolved.push({
        ref: item.url || `#${item.number}`,
        code: 'REF_OUT_OF_SCOPE',
        message: `ref belongs to ${item.repo}, not to ${repo}`,
      });
      return;
    }
    if (item.number !== undefined) {
      if (!numbers.some((n) => n.number === item.number)) numbers.push({ ...item, via: item.via && item.via !== 'url' ? item.via : via });
      return;
    }
    if (item.sha) {
      if (!commits.some((c) => c.sha === item.sha)) commits.push({ sha: item.sha, source: via });
      return;
    }
    if (item.name && !branches.some((b) => b.name === item.name)) branches.push({ name: item.name, source: via });
  };

  for (const item of parsed.known.urls) note(item, 'known_refs');
  for (const item of parsed.urls) note(item, 'task_ref');
  for (const item of parsed.known.numbers) note({ ...item, repo: item.repo || null, via: 'known_refs' }, 'known_refs');
  for (const item of parsed.numbers) note({ ...item, repo: item.repo || null, via: item.via }, item.via === 'url' ? 'task_ref' : 'task_ref');
  for (const sha of parsed.known.commits) if (!commits.some((c) => c.sha === sha)) commits.push({ sha, source: 'known_refs' });
  for (const sha of parsed.commits) if (!commits.some((c) => c.sha === sha)) commits.push({ sha, source: 'task_ref' });
  for (const b of parsed.known.branches) if (!branches.some((c) => c.name === b)) branches.push({ name: b, source: 'known_refs' });
  for (const b of parsed.branches) if (!branches.some((c) => c.name === b)) branches.push({ name: b, source: 'task_ref' });

  const stats = { looked: 0, found: 0, authError: null };

  const lookup = async (fn, label) => {
    stats.looked += 1;
    try {
      const value = await fn();
      stats.found += 1;
      return value;
    } catch (e) {
      const code = errorCode(e);
      if (code === 'NOT_FOUND') {
        out.unresolved.push({ ref: label, code: 'NOT_FOUND', message: `not found in ${repo}` });
        return null;
      }
      if (code === 'GITHUB_AUTH' || code === 'RATE_LIMITED') {
        stats.authError = stats.authError || sectionError(e);
        return null;
      }
      out.unresolved.push({ ref: label, code, message: e.message });
      return null;
    }
  };

  for (const entry of numbers) {
    const label = `#${entry.number}`;
    const item = await lookup(() => ghFetch(`/repos/${repo}/issues/${entry.number}`), label);
    if (!item) continue;
    const source = String(entry.via || '').startsWith('known') ? 'known_refs' : 'task_ref';
    const why = entry.via === 'url'
      ? `stated URL ${entry.url}`
      : `${String(entry.via || '').startsWith('known') ? 'known' : 'stated'} ref #${entry.number}`;
    if (item.pull_request) {
      const detail = await lookup(() => ghFetch(`/repos/${repo}/pulls/${entry.number}`), label);
      const pr = detail || item;
      const cand = fromGitHubItem(repo, { ...pr, pull_request: item.pull_request, number: entry.number }, source, why, 'exact');
      cand.ref.merged_at = pr.merged_at || null;
      mergeCandidate(out.candidates, cand);
    } else {
      mergeCandidate(out.candidates, fromGitHubItem(repo, item, source, why, 'exact'));
    }
  }

  for (const entry of commits) {
    const sha = entry.sha;
    const commit = await lookup(() => ghFetch(`/repos/${repo}/commits/${encodeURIComponent(sha)}`), sha);
    if (!commit) continue;
    mergeCandidate(out.candidates, {
      relation_type: 'exact',
      kind: 'commit',
      identity: `commit ${(commit.sha || sha).slice(0, 12)}`,
      ref: {
        repo,
        sha: commit.sha || sha,
        url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha || sha}`,
        subject: commit.commit && commit.commit.message ? String(commit.commit.message).split('\n')[0] : null,
        author: commit.commit && commit.commit.author ? commit.commit.author.name : null,
        committed_at: (commit.commit && commit.commit.committer && commit.commit.committer.date) || null,
      },
      evidence: [{ source: entry.source, why: `commit ${sha} stated by the caller` }],
      score: null,
      timestamp: (commit.commit && commit.commit.committer && commit.commit.committer.date) || null,
      superseded_by: null,
    });
  }

  for (const entry of branches) {
    const found = await lookup(() => ghFetch(`/repos/${repo}/branches/${encodeURIComponent(entry.name)}`), `branch ${entry.name}`);
    if (!found) continue;
    mergeCandidate(out.candidates, fromBranch(repo, entry.name, entry.source,
      `branch "${entry.name}" stated by the caller`, 'exact', {
        sha: found.commit && found.commit.sha ? found.commit.sha : null,
      }));
  }

  if (stats.looked) {
    sources.push(stats.authError
      ? { name: 'github_explicit_refs', ok: false, error: stats.authError, looked_up: stats.looked, found: stats.found }
      : { name: 'github_explicit_refs', ok: true, looked_up: stats.looked, found: stats.found });
  }
  return { ...out, authError: stats.authError };
}

async function collectSearch({ repo, terms, limit, ghFetch, sources }) {
  if (!terms) return { candidates: [], authError: null };
  const candidates = [];
  let authError = null;
  let searched = 0;
  const errors = [];
  for (const [type, kind] of SEARCH_TYPES) {
    const q = `repo:${repo} type:${type} ${terms}`;
    try {
      searched += 1;
      const res = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(limit * 2, MAX_LIMIT * 2)}`);
      const items = res && Array.isArray(res.items) ? res.items : [];
      items.forEach((item, index) => {
        const cand = fromGitHubItem(repo, item, 'github_search',
          `text similarity to «${terms}» (rank ${index + 1} for ${kind} search)`, 'inferred');
        cand.score = Math.max(1, 100 - index);
        cand.ref.kind_search = kind;
        mergeCandidate(candidates, cand);
      });
    } catch (e) {
      const code = errorCode(e);
      if (code === 'GITHUB_AUTH' || code === 'RATE_LIMITED') authError = authError || sectionError(e);
      else errors.push({ query: q, error: sectionError(e) });
    }
  }
  if (searched) {
    if (authError) sources.push({ name: 'github_search', ok: false, error: authError, query: terms });
    else if (errors.length) sources.push({ name: 'github_search', ok: false, error: errors[0].error, attempted: searched, query: terms });
    else sources.push({ name: 'github_search', ok: true, query: terms, returned: candidates.length });
  }
  return { candidates, authError };
}

// A branch recorded for THIS task is the strongest link there is between a task
// and its PR: `head:<branch>` is an exact identity query, not a text match.
async function collectBranchPulls({ repo, branches, ghFetch, sources }) {
  const list = [...branches].slice(0, BRANCH_SEARCH_MAX);
  if (!list.length) return { candidates: [], authError: null };
  const candidates = [];
  let authError = null;
  let searched = 0;
  for (const branch of list) {
    try {
      searched += 1;
      const res = await ghFetch(`/search/issues?q=${encodeURIComponent(`repo:${repo} type:pr head:${branch}`)}&per_page=5`);
      for (const item of (res && Array.isArray(res.items) ? res.items : [])) {
        candidates.push(fromGitHubItem(repo, item, 'branch_match',
          `PR opened from branch «${branch}», recorded for this task`, 'exact'));
      }
    } catch (e) {
      const code = errorCode(e);
      if (code === 'GITHUB_AUTH' || code === 'RATE_LIMITED') authError = authError || sectionError(e);
      else sources.push({ name: 'github_branch_head', ok: false, branch, error: sectionError(e) });
    }
  }
  if (searched) {
    sources.push(authError
      ? { name: 'github_branch_head', ok: false, error: authError, branches: list }
      : { name: 'github_branch_head', ok: true, branches: list, returned: candidates.length });
  }
  return { candidates, authError };
}

// A PR carrying the `superseded` label points at its successor with an explicit
// comment («Superseded by #27»). The successor is an exact candidate for the
// same task; the superseded PR stays visible, marked, so nobody resumes work on
// the dead one. Bounded: only the PRs actually in the answer are inspected.
async function resolveSupersedes({ repo, candidates, ghFetch, sources }) {
  const prs = candidates
    .filter((c) => (c.kind === 'pull') && !c.superseded_by && c.ref.labels && c.ref.labels.includes('superseded'))
    .slice(0, SUPERSEDE_MAX);
  if (!prs.length) return { authError: null, conflicts: [] };

  const conflicts = [];
  let checked = 0;
  let authError = null;
  const errors = [];
  for (const pr of prs) {
    try {
      checked += 1;
      const comments = await ghFetch(`/repos/${repo}/issues/${pr.ref.number}/comments?per_page=100`);
      const list = Array.isArray(comments) ? comments : [];
      const marker = list
        .map((c) => String(c.body || '').match(/superseded by\s+(?:https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/)?#?(\d{1,7})/i))
        .filter(Boolean)
        .pop();
      if (!marker) continue;
      const successorNumber = Number(marker[1]);
      pr.superseded = true;
      pr.superseded_by = { kind: 'pull', number: successorNumber, url: prUrl(repo, successorNumber) };
      if (pr.relation_type === 'exact') {
        conflicts.push({
          code: 'SUPERSEDED_EXACT',
          message: `exact PR #${pr.ref.number} is superseded by #${successorNumber} — resume on the successor`,
          refs: [pr.identity, `PR #${successorNumber}`],
        });
      }
      if (candidates.some((c) => c.kind === 'pull' && c.ref.number === successorNumber)) continue;
      let detail = null;
      try {
        detail = await ghFetch(`/repos/${repo}/pulls/${successorNumber}`);
      } catch (e) {
        conflicts.push({
          code: 'SUPERSEDE_TARGET_MISSING',
          message: `PR #${pr.ref.number} says «superseded by #${successorNumber}», but #${successorNumber} is not readable: ${e.message}`,
          refs: [pr.identity],
        });
      }
      if (detail) {
        const successor = fromGitHubItem(repo, { ...detail, pull_request: { url: true } }, 'supersede_marker',
          `PR #${pr.ref.number} is marked superseded and points here`, 'exact');
        mergeCandidate(candidates, successor);
      }
    } catch (e) {
      const code = errorCode(e);
      if (code === 'GITHUB_AUTH' || code === 'RATE_LIMITED') authError = authError || sectionError(e);
      else errors.push({ pr: pr.identity, error: sectionError(e) });
    }
  }
  if (checked) {
    if (authError) sources.push({ name: 'github_supersede', ok: false, error: authError, checked: prs.length });
    else if (errors.length) sources.push({ name: 'github_supersede', ok: false, error: errors[0].error, checked: prs.length });
    else sources.push({ name: 'github_supersede', ok: true, checked: prs.length });
  }
  return { authError, conflicts };
}

async function changeFind(input = {}, deps = {}) {
  const ghFetch = deps.ghFetch || defaultGhFetch;
  const now = deps.now || Date.now;
  const repo = normalizeRepo(input.repo);
  const taskRef = typeof input.task_ref === 'string' ? input.task_ref.trim() : '';
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!taskRef && !query) throw fail('INVALID_TASK_REF', 'task_ref or query is required — what work are we looking for?');
  const limit = normalizeLimit(input.limit);
  const range = normalizeTimeRange(input.time_range);
  const principal = deps.principal !== undefined ? deps.principal : (process.env.USER_ID || '');
  const workspaceRoot = deps.workspaceRoot;
  const knownRaw = typeof input.known_refs === 'string' ? input.known_refs.split(',') : input.known_refs;
  const known = parseKnownRefs(knownRaw);
  const parsed = { ...parseTaskRef(taskRef || query), known };
  const observedAt = new Date(now()).toISOString();

  const sources = [];
  const conflicts = [];
  const candidates = [];

  // ── local store: bindings + workspace records for THIS principal only ──
  let bindings = [];
  let workspaces = [];
  if (!principal) {
    sources.push({
      name: 'workspace-store',
      ok: false,
      error: { code: 'PRINCIPAL_MISSING', message: 'USER_ID is not set — saved bindings and workspace records are owner-scoped and cannot be listed' },
    });
  } else {
    try {
      bindings = local.listBindings({ workspaceRoot, principal, repositoryId: repo });
      workspaces = local.listWorkspaces({ workspaceRoot, principal, repositoryId: repo });
      sources.push({ name: 'workspace-store', ok: true, returned: bindings.length + workspaces.length, principal });
    } catch (e) {
      sources.push({ name: 'workspace-store', ok: false, error: { code: 'STORE_ERROR', message: e.message } });
    }
  }

  const taskNorm = normTask(taskRef || query);
  const theme = query || taskRef || '';
  const exactBranches = new Set();

  for (const record of bindings) {
    const same = Boolean(taskRef) && normTask(record.taskRef) === taskNorm;
    const overlap = same ? 0 : overlapScore(theme, record.taskRef);
    // No shared words with the query = no reason to show this row at all.
    if (!same && overlap === 0) continue;
    const bound = mergeCandidate(candidates, fromBindingRecord(
      record,
      same ? 'exact' : 'inferred',
      'saved_binding',
      same ? `saved binding for exactly this task («${record.taskRef}»)` : `saved binding for a similar task («${record.taskRef}»)`,
    ));
    if (!same) bound.score = Math.max(1, overlap);

    const refParsed = parseKnownRefs(record.refs);
    for (const num of refParsed.numbers) {
      mergeCandidate(candidates, {
        relation_type: same ? 'exact' : 'inferred',
        kind: 'pull',
        identity: `PR #${num.number}`,
        ref: { number: num.number, repo, url: num.url || prUrl(repo, num.number), from_binding: record.taskRef },
        evidence: [{ source: 'saved_binding', why: `bound to task «${record.taskRef}»` }],
        score: same ? null : Math.max(1, overlap),
        timestamp: record.updatedAt || null,
        superseded_by: null,
      });
    }
    for (const b of refParsed.branches) {
      if (same) exactBranches.add(b);
      mergeCandidate(candidates, fromBranch(repo, b, 'saved_binding',
        `branch bound to task «${record.taskRef}»`, same ? 'exact' : 'inferred'));
    }
    for (const sha of refParsed.commits) {
      mergeCandidate(candidates, {
        relation_type: same ? 'exact' : 'inferred',
        kind: 'commit',
        identity: `commit ${sha.slice(0, 12)}`,
        ref: { repo, sha, from_binding: record.taskRef },
        evidence: [{ source: 'saved_binding', why: `commit bound to task «${record.taskRef}»` }],
        score: null,
        timestamp: record.updatedAt || null,
        superseded_by: null,
      });
    }
  }

  for (const record of workspaces) {
    const same = Boolean(taskRef) && normTask(record.rootTaskId) === taskNorm;
    const overlap = same ? 0 : overlapScore(theme, record.rootTaskId);
    if (!same && overlap === 0) continue;
    const cand = fromWorkspace(record, same ? 'exact' : 'inferred', 'workspace_record',
      same ? `workspace record for exactly this task («${record.rootTaskId}»)` : `workspace record for a similar task («${record.rootTaskId}»)`);
    if (!same) cand.score = Math.max(1, overlap);
    mergeCandidate(candidates, cand);
    if (same && record.branch) {
      exactBranches.add(record.branch);
      mergeCandidate(candidates, fromBranch(repo, record.branch, 'workspace_record',
        `branch of the workspace for «${record.rootTaskId}» (${record.status})`, 'exact', {
          workspace_id: record.workspaceId,
          head_sha: (record.git && record.git.headRevision) || null,
          status: record.status,
        }));
    }
  }

  // ── GitHub: stated refs, then text search ──
  const explicit = await collectExplicitRefs({ repo, parsed, ghFetch, sources });
  for (const c of explicit.candidates) mergeCandidate(candidates, c);
  for (const u of explicit.unresolved) {
    if (u.code === 'REF_OUT_OF_SCOPE') {
      conflicts.push({ code: 'REF_OUT_OF_SCOPE', message: u.message, refs: [u.ref] });
    }
  }
  const unresolved = explicit.unresolved;

  const searchTerms = query || parsed.slug;
  const search = await collectSearch({ repo, terms: searchTerms, limit, ghFetch, sources });
  for (const c of search.candidates) mergeCandidate(candidates, c);

  // A PR on a branch we know is this task's is an exact identity, not a theme.
  for (const c of candidates) {
    if (c.kind !== 'pull') continue;
    const head = c.ref.head_ref;
    if (head && exactBranches.has(head)) {
      c.relation_type = 'exact';
      c.evidence.push({ source: 'branch_match', why: `head branch «${head}» belongs to a workspace/binding recorded for this task` });
    }
  }

  const branchPulls = await collectBranchPulls({ repo, branches: exactBranches, ghFetch, sources });
  for (const c of branchPulls.candidates) mergeCandidate(candidates, c);

  const supersede = await resolveSupersedes({ repo, candidates, ghFetch, sources });
  conflicts.push(...supersede.conflicts);

  // ── conflicts / filters / ordering ──
  const exactPulls = candidates.filter((c) => c.relation_type === 'exact' && c.kind === 'pull' && !c.superseded);
  if (exactPulls.length > 1) {
    conflicts.push({
      code: 'MULTIPLE_EXACT_PULLS',
      message: `${exactPulls.length} PRs claim this task with no supersede link between them — pick explicitly, nothing is chosen for you`,
      refs: exactPulls.map((c) => c.identity),
    });
  }

  const kept = candidates.filter((c) => inRange(c.timestamp, range));
  const droppedByRange = candidates.length - kept.length;

  const exact = kept.filter((c) => c.relation_type === 'exact')
    .sort((a, b) => priorityOf(a) - priorityOf(b) || String(a.identity).localeCompare(String(b.identity)));
  const inferred = kept.filter((c) => c.relation_type !== 'exact')
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.identity).localeCompare(String(b.identity)))
    .slice(0, limit);

  const ordered = [...exact, ...inferred].map((c, index) => ({ ...c, rank: index + 1 }));

  const authError = explicit.authError || search.authError || branchPulls.authError || supersede.authError;
  if (authError && ordered.length === 0) {
    return {
      ok: false,
      repo,
      task_ref: taskRef || null,
      query: query || null,
      error: authError,
      sources,
      freshness: { observed_at: observedAt },
    };
  }

  return {
    ok: true,
    repo,
    task_ref: taskRef || null,
    query: query || null,
    candidates: ordered,
    no_candidates: ordered.length === 0,
    // The tool never picks: several candidates come back with their reasons.
    selection: { auto_selected: false, note: 'выбор за вызывающим: смотри evidence и relation_type, exact важнее inferred' },
    conflicts,
    unresolved_refs: unresolved,
    sources,
    freshness: {
      observed_at: observedAt,
      principal: principal || null,
      workspace_root: local.resolveRoot(workspaceRoot),
      time_range: range ? {
        since: range.since !== undefined ? new Date(range.since).toISOString() : null,
        until: range.until !== undefined ? new Date(range.until).toISOString() : null,
      } : null,
      dropped_by_time_range: droppedByRange,
      exact: exact.length,
      inferred_returned: inferred.length,
      limit,
    },
    limitations: [
      'relation_type=exact — либо явно названный ref, либо сохранённая связь/запись воркспейса, либо совпадение ветки; inferred — только текстовое сходство, оно не является доказательством, что работа найдена',
      'score у inferred — тематический ранг, не вероятность correctness',
      'выбор автоматически не делается: selection.auto_selected всегда false',
      'GitHub search не сортировать по релевантности напрямую нельзя — порядок выдачи берётся как есть (rank в evidence)',
      'локальные записи видны только профилю, от которого идёт вызов (principal); чужие записи в выдачу не попадают',
    ],
  };
}

module.exports = { changeFind, normalizeRepo, DEFAULT_LIMIT, MAX_LIMIT, EXACT_ORDER };
