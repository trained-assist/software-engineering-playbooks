'use strict';

// engineering_repo_find (#108): search the accessible repository catalog by
// name, former name (rename aliases) and purpose. One call → ranked repos with
// match_reasons, structured freshness and an honest no_match. Read-only.

const { scoreRepo } = require('./match');
const { buildCatalog } = require('./catalog');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function findRepos(input = {}, deps = {}) {
  const { query, scope, cursor, refresh, include_archived } = input;
  if (typeof query !== 'string' || !query.trim()) {
    throw fail('INVALID_QUERY', 'query is required and must be a non-empty string');
  }

  let limit = input.limit === undefined || input.limit === null ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isFinite(limit) || limit < 1) {
    throw fail('INVALID_LIMIT', `limit must be a positive number, got "${input.limit}"`);
  }
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  let offset = 0;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    offset = Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw fail('INVALID_CURSOR', `cursor must be a non-negative integer string, got "${cursor}"`);
    }
  }

  const catalog = await buildCatalog({
    scope,
    refresh: refresh === true,
    ghFetch: deps.ghFetch,
    ttlMs: deps.ttlMs,
    now: deps.now,
  });

  const trimmed = query.trim();
  const matched = [];
  const excluded = [];
  for (const entry of catalog.entries) {
    const hit = scoreRepo(entry, trimmed);
    if (!hit) continue;
    if (entry.archived && include_archived !== true) {
      excluded.push({ id: entry.id, full_name: entry.full_name, reason: 'archived', score: hit.score });
      continue;
    }
    matched.push({ entry, ...hit });
  }
  matched.sort((a, b) => b.score - a.score || a.entry.full_name.localeCompare(b.entry.full_name));

  const page = matched.slice(offset, offset + limit);
  const nextCursor = offset + limit < matched.length ? String(offset + limit) : null;

  return {
    query: trimmed,
    no_match: matched.length === 0,
    repos: page.map(({ entry, score, reasons }) => ({
      id: entry.id,
      full_name: entry.full_name,
      description: entry.description,
      purpose: entry.purpose,
      default_branch: entry.default_branch,
      archived: entry.archived,
      match_reasons: reasons,
      score,
      source_refs: entry.source_refs,
    })),
    excluded,
    next_cursor: nextCursor,
    freshness: {
      ...catalog.freshness,
      returned: page.length,
      total_matches: matched.length,
    },
    limitations: catalog.limitations,
  };
}

module.exports = { findRepos, DEFAULT_LIMIT, MAX_LIMIT };
