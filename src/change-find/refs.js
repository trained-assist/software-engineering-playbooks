'use strict';

// Turning what a caller writes into concrete refs (#111): exact identity has to
// be separable from thematic similarity, so identifiers are extracted here and
// everything else falls through to plain text ranking.
//
// Two entry points with deliberately different strictness:
//   - parseTaskRef(text) — free text («пофикси выбор диалога #115, ветка
//     eng/x»). A bare hex token is NOT a commit here: real task labels contain
//     hex runs («plan-c4c5b145-r1») and a guessed sha would go to the API and
//     404 as noise. Commits come from commit URLs or an explicit `sha:` prefix.
//   - parseKnownRefs(items) — a list the caller states as refs. There a bare
//     hex token IS a sha, because the caller chose to pass a ref, not a phrase.

const GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|issue|commit|commits|tree|blob)\/([^\s?#)]+)/gi;
const PR_WORD = /(?:^|[^\w])pr\s*#?\s*(\d{1,7})\b/i;
const BARE_NUMBER = /#(\d{1,7})\b/;
const BRANCH_WORD = /(?:^|[^\s,;])branch[:\s]+([^\s,;]+)/i;
const SHA_WORD = /(?:^|\s)(?:sha|commit)[:\s]+([0-9a-f]{7,40})\b/i;
const HEX_ONLY = /^[0-9a-f]{7,40}$/i;

function normTask(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function numberFrom(raw) {
  const pr = raw.match(PR_WORD);
  if (pr) return { number: Number(pr[1]), via: 'pr' };
  const bare = raw.match(BARE_NUMBER);
  if (bare) return { number: Number(bare[1]), via: 'bare' };
  return null;
}

function pushUnique(list, item, keyOf) {
  const key = keyOf(item);
  if (list.some((x) => keyOf(x) === key)) return;
  list.push(item);
}

function urlKind(pathname) {
  if (pathname === 'pull') return 'pull';
  if (pathname === 'issues' || pathname === 'issue') return 'issue';
  if (pathname === 'commit' || pathname === 'commits') return 'commit';
  return 'tree';
}

/** Free-text parsing: task_ref / query. */
function parseTaskRef(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  const out = {
    raw: text,
    urls: [],        // [{owner, repo, kind, number|sha|name, url, via:'url'}]
    numbers: [],     // [{number, via:'pr'|'bare'}]
    commits: [],     // [sha]
    branches: [],    // [name]
    slug: '',        // remaining words, lowercased — the thematic query
  };

  let rest = text;
  let m;
  GITHUB_URL.lastIndex = 0;
  while ((m = GITHUB_URL.exec(text)) !== null) {
    const owner = m[1];
    const name = m[2];
    const kind = urlKind(m[3].toLowerCase());
    const tail = m[4];
    const base = `https://github.com/${owner}/${name}`;
    if (kind === 'pull' || kind === 'issue') {
      pushUnique(out.urls, { owner, repo: `${owner}/${name}`, kind, number: Number(tail), url: `${base}/pull/${tail}`, via: 'url' }, x => `${x.repo}#${x.number}`);
      pushUnique(out.numbers, { number: Number(tail), via: 'url', repo: `${owner}/${name}`, url: `${base}/${m[3]}/${tail}` }, x => `url:${x.number}:${x.repo}`);
    } else if (kind === 'commit') {
      pushUnique(out.urls, { owner, repo: `${owner}/${name}`, kind: 'commit', sha: tail, url: `${base}/commit/${tail}`, via: 'url' }, x => x.sha);
      pushUnique(out.commits, tail, x => x);
    } else {
      pushUnique(out.urls, { owner, repo: `${owner}/${name}`, kind: 'branch', name: tail, url: `${base}/tree/${tail}`, via: 'url' }, x => `${x.repo}:${x.name}`);
      pushUnique(out.branches, tail, x => x);
    }
    rest = rest.replace(m[0], ' ');
  }

  const pr = rest.match(PR_WORD);
  if (pr) {
    pushUnique(out.numbers, { number: Number(pr[1]), via: 'pr' }, x => `pr:${x.number}`);
    rest = rest.replace(pr[0], ' ');
  }
  const bare = rest.match(BARE_NUMBER);
  if (bare) {
    pushUnique(out.numbers, { number: Number(bare[1]), via: 'bare' }, x => `bare:${x.number}`);
    rest = rest.replace(bare[0], ' ');
  }
  const sha = rest.match(SHA_WORD);
  if (sha) {
    pushUnique(out.commits, sha[1], x => x);
    rest = rest.replace(sha[0], ' ');
  }
  const branch = rest.match(BRANCH_WORD);
  if (branch) {
    pushUnique(out.branches, branch[1], x => x);
    rest = rest.replace(branch[0], ' ');
  }

  out.slug = normTask(rest.replace(/[\s]+/g, ' '));
  return out;
}

/** Explicit ref strings: known_refs[] / bind refs[]. */
function parseKnownRefs(items) {
  const out = { urls: [], numbers: [], commits: [], branches: [], unknown: [] };
  for (const raw of (Array.isArray(items) ? items : [])) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!value) continue;
    if (/github\.com\//i.test(value)) {
      const parsed = parseTaskRef(value);
      for (const u of parsed.urls) pushUnique(out.urls, u, x => `${x.repo}#${x.number || x.sha}`);
      for (const n of parsed.numbers) pushUnique(out.numbers, n, x => `${x.number}:${x.repo || ''}`);
      for (const c of parsed.commits) pushUnique(out.commits, c, x => x);
      for (const b of parsed.branches) pushUnique(out.branches, b, x => x);
      if (!parsed.urls.length && !parsed.numbers.length && !parsed.commits.length && !parsed.branches.length) out.unknown.push(value);
      continue;
    }
    const num = numberFrom(value);
    if (num) {
      // Inside known_refs everything is a ref by declaration, so «PR #50» and
      // «#50» are numbers — no need to prove the string is exactly the token.
      pushUnique(out.numbers, { ...num, via: num.via === 'pr' ? 'known_pr' : 'known_number' }, x => `known:${x.number}`);
      continue;
    }
    if (HEX_ONLY.test(value)) {
      pushUnique(out.commits, value.toLowerCase(), x => x);
      continue;
    }
    if (/^[\w./@-]+$/.test(value) && /[\/]/.test(value)) {
      pushUnique(out.branches, value, x => x);
      continue;
    }
    out.unknown.push(value);
  }
  return out;
}

function isHex(value) {
  return HEX_ONLY.test(String(value || ''));
}

module.exports = { parseTaskRef, parseKnownRefs, normTask, isHex };
