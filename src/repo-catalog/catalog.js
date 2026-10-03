'use strict';

// Catalog layer for engineering_repo_find (#108): where repo entries come
// from, with explicit provenance for every source. Sources:
//   1. github      — live list from the token's accessible scope (required;
//                     auth failures propagate and are NEVER masked as "empty");
//   2. definitions — optional checked-in file (docs/repo-catalog.json or
//                     $REPO_CATALOG_FILE) with rename aliases and purpose
//                     overrides; absent file = fine, broken file = partial.
// In-memory TTL cache keyed by scope; refresh=true forces a rebuild.

const fs = require('fs');
const path = require('path');
const { ghFetch: defaultGhFetch } = require('../github/client');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 3;

const CACHE = new Map();

function definitionsPath() {
  return process.env.REPO_CATALOG_FILE
    || path.join(__dirname, '..', '..', 'docs', 'repo-catalog.json');
}

function relativeRef(file) {
  const rel = path.relative(path.join(__dirname, '..', '..'), file);
  return rel.startsWith('..') ? path.basename(file) : `definitions:${rel}`;
}

function loadDefinitions(now) {
  const file = definitionsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'missing', file };
    return { status: 'error', file, error: e.message };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('definitions file must be a JSON object');
    }
    return {
      status: 'ok',
      file,
      observed_at: new Date(now()).toISOString(),
      data: {
        aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {},
        purposes: data.purposes && typeof data.purposes === 'object' ? data.purposes : {},
      },
    };
  } catch (e) {
    return { status: 'error', file, error: e.message };
  }
}

function listPath(scope, page) {
  // sort=full_name everywhere: GitHub defaults differ per endpoint (created,
  // pushed, updated), and a catalog whose page 2 shifts between two calls is
  // not reproducible — pagination and freshness claims depend on stable order.
  //
  // /user/repos takes `affiliation` INSTEAD of `type`: GitHub answers
  // 422 "If you specify visibility or affiliation, you cannot specify type."
  // (found by a live prod call, #108 follow-up) — so the two must never be
  // combined. Golden-path tests below pin the exact query per scope.
  const page_ = `&sort=full_name&per_page=${PER_PAGE}&page=${page}`;
  if (!scope || scope === 'visible') {
    return `/user/repos?affiliation=owner,collaborator,organization_member${page_}`;
  }
  if (scope.startsWith('org:')) {
    const org = scope.slice(4).trim();
    if (!org) throw Object.assign(new Error('scope "org:" requires a name'), { code: 'INVALID_SCOPE' });
    return `/orgs/${encodeURIComponent(org)}/repos?type=all${page_}`;
  }
  if (scope.startsWith('user:')) {
    const user = scope.slice(5).trim();
    if (!user) throw Object.assign(new Error('scope "user:" requires a name'), { code: 'INVALID_SCOPE' });
    return `/users/${encodeURIComponent(user)}/repos?type=all${page_}`;
  }
  throw Object.assign(
    new Error(`Invalid scope "${scope}" — expected "visible", "org:<name>" or "user:<name>"`),
    { code: 'INVALID_SCOPE' },
  );
}

async function fetchRepos(scope, ghFetch) {
  const repos = [];
  let truncated = false;
  let lastPath = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    lastPath = listPath(scope, page);
    const batch = await ghFetch(lastPath);
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub returned a non-list payload for ${lastPath}`);
    }
    repos.push(...batch);
    if (batch.length < PER_PAGE) {
      return { repos, truncated: false, ref: `github:${lastPath}` };
    }
    if (page === MAX_PAGES) truncated = true;
  }
  return { repos, truncated, ref: `github:${lastPath}` };
}

function toEntry(repo, defs, observedAt) {
  const fullName = repo.full_name || `${repo.owner ? repo.owner.login : ''}/${repo.name}`;
  const aliases = Array.isArray(defs.aliases[fullName])
    ? defs.aliases[fullName].filter(a => typeof a === 'string' && a.trim())
    : [];
  const purposeDef = defs.purposes[fullName];
  const purposeText = purposeDef && typeof purposeDef.text === 'string' && purposeDef.text
    ? purposeDef.text
    : (repo.description || '');
  const sourceRefs = [`github:repo/${repo.id}@${observedAt}`];
  if (aliases.length || purposeDef) sourceRefs.push('definitions:docs/repo-catalog.json');
  return {
    id: repo.id,
    full_name: fullName,
    owner: (repo.owner && repo.owner.login) || fullName.split('/')[0] || '',
    name: fullName.includes('/') ? fullName.split('/').slice(1).join('/') : fullName,
    description: repo.description || '',
    default_branch: repo.default_branch || null,
    archived: Boolean(repo.archived),
    aliases,
    purposeText,
    purpose: {
      text: purposeText,
      source: purposeDef ? 'definitions' : 'github',
      // derived: purpose extracted by a model (not present in v1 — reserved by
      // #108: "Purpose, извлечённый моделью, помечен как derived").
      derived: Boolean(purposeDef && purposeDef.derived),
    },
    source_refs: sourceRefs,
    observed_at: observedAt,
  };
}

async function buildCatalog({
  scope = 'visible',
  refresh = false,
  ttlMs = DEFAULT_TTL_MS,
  ghFetch = defaultGhFetch,
  now = Date.now,
} = {}) {
  const key = String(scope);
  const cached = CACHE.get(key);
  if (!refresh && cached && now() - cached.builtAt < ttlMs) {
    return {
      ...cached.catalog,
      freshness: { ...cached.catalog.freshness, cache: 'hit' },
    };
  }

  // GitHub is the required source: its failure (auth, network, rate limit)
  // propagates to the caller instead of degrading into an empty "no_match".
  const fetched = await fetchRepos(scope, ghFetch);
  const observedAt = new Date(now()).toISOString();
  const sources = [{ name: 'github', status: 'ok', observed_at: observedAt, ref: fetched.ref }];

  const defs = loadDefinitions(now);
  if (defs.status === 'ok') {
    sources.push({ name: 'definitions', status: 'ok', observed_at: defs.observed_at, ref: relativeRef(defs.file) });
  } else if (defs.status === 'missing') {
    sources.push({ name: 'definitions', status: 'absent', observed_at: observedAt, ref: relativeRef(defs.file) });
  } else {
    sources.push({ name: 'definitions', status: 'error', observed_at: observedAt, ref: relativeRef(defs.file), error: defs.error });
  }

  const limitations = ['лексическое сопоставление по name/alias/description; плотная семантика — #110'];
  let completeness = 'full';
  if (defs.status === 'error') {
    completeness = 'partial';
    limitations.push(`definitions недоступны (${defs.error}) — aliases/purposes не применены`);
  }
  if (fetched.truncated) {
    limitations.push(`каталог усечён: показаны первые ${fetched.repos.length} репозиториев источника`);
  }

  const okDefs = defs.status === 'ok' ? defs.data : { aliases: {}, purposes: {} };
  const byId = new Map();
  for (const repo of fetched.repos) {
    if (!repo || repo.id === undefined || byId.has(repo.id)) continue;
    byId.set(repo.id, toEntry(repo, okDefs, observedAt));
  }

  const catalog = {
    entries: [...byId.values()],
    freshness: {
      observed_at: observedAt,
      scope: key,
      sources,
      completeness,
      cache: 'miss',
      catalog_size: byId.size,
    },
    limitations,
  };
  CACHE.set(key, { builtAt: now(), catalog });
  return catalog;
}

function clearCache() {
  CACHE.clear();
}

module.exports = { buildCatalog, clearCache, loadDefinitions, listPath, DEFAULT_TTL_MS };
