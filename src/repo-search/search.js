'use strict';

// engineering_repo_search: retrieval of sources (path + line range + symbol +
// snippet + revision), never the answer itself. Three strategies share one
// chunk set and one ranking contract:
//
//   keyword — lexical BM25-ish over chunks, exact-identifier boost (always on)
//   dense   — embeddings from an optional provider
//   hybrid  — reciprocal-rank fusion of both, exact-identifier boost on top
//
// Honesty rules that are part of the contract, not decoration:
//   * a chunk whose file disappeared (deleted / renamed after the index) is
//     dropped, never served as current;
//   * a chunk whose file changed after the index is reported stale and kept out
//     of the answer unless the caller asks for stale hits;
//   * an empty result is NOT proof of absence — the answer says so, with the
//     indexed scope and revision that were actually searched;
//   * missing embedding credentials degrade to keyword, and say they degraded.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildChunks, DEFAULT_MAX_CHUNKS } = require('./chunks');
const { keywordRank, tokenize } = require('./keyword');
const { embedTexts, denseRank, resolveApiKey, defaultModel } = require('./embeddings');
const { searchDirFor, loadChunks, saveChunks, fileHashMap } = require('./store');
const { currentRevision } = require('../index/build');

const DEFAULT_LIMIT = 8;
const RRF_K = 60;
const SNIPPET_CHARS = 320;
const STALE_SCAN_LIMIT = 40;

function git(cwd, args, fallback = null) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function snippetOf(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

function reciprocalRankFusion(lists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = item.chunk.id;
      const prev = scores.get(key) || { chunk: item.chunk, score: 0, sources: [] };
      prev.score += 1 / (k + i + 1);
      prev.sources.push({ matchKind: item.matchKind, score: Number(item.score.toFixed(4)) });
      scores.set(key, prev);
    });
  }
  return [...scores.values()];
}

function boostExact(chunk, query, base) {
  const q = tokenize(query);
  const symbolNorm = String(chunk.symbol || '').toLowerCase().replace(/[^0-9a-zа-яё]+/g, '');
  if (q.normalized && symbolNorm === q.normalized) return { score: base.score + 25, matchKind: 'symbol-exact' };
  if (symbolNorm && q.normalized.length >= 4 && (symbolNorm.includes(q.normalized) || q.normalized.includes(symbolNorm))) {
    return { score: base.score + 10, matchKind: 'symbol' };
  }
  return { score: base.score, matchKind: base.sources.length ? base.sources[0].matchKind : 'fused' };
}

const STRATEGIES = ['auto', 'keyword', 'dense', 'hybrid'];

// `auto` (the default) is the strategy the benchmark decided on: lexical first,
// semantic only when lexical has no confident hit. Exact identifiers are
// answered by string equality in ~0.2 s with no credentials; the cross-lingual
// and behavioural classes — where BM25 measures 0 — pay for the embedding pass,
// because that is where the measured recall lives (0.571 → 0.946 on 34 queries).
function resolveStrategy(requested, { denseAvailable }) {
  const want = String(requested || 'auto').toLowerCase();
  if (!STRATEGIES.includes(want)) {
    const err = new Error(`strategy must be ${STRATEGIES.join('|')}, got "${requested}"`);
    err.code = 'INVALID_STRATEGY';
    throw err;
  }
  if (want === 'keyword') return { strategy: 'keyword', requested: want, degraded: null };
  if (!denseAvailable) return { strategy: 'keyword', requested: want, degraded: 'no-embeddings-provider' };
  return { strategy: want, requested: want, degraded: null };
}

// A lexical hit is an answer only when it matched on its own terms; `weak-*`
// matches are the demoted single-word coincidences keywordRank labels as such.
function hasConfidentLexicalHit(list) {
  return list.some((hit) => !String(hit.matchKind || '').startsWith('weak-'));
}

async function repoSearch(input = {}) {
  const repoPath = input.repo_path || input.repoPath || input.path;
  if (!repoPath) throw new Error('repo_path is required (absolute path to a local checkout)');
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    const err = new Error(`repo_path is not a directory: ${abs}`);
    err.code = 'REPO_NOT_FOUND';
    throw err;
  }
  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required');

  const limit = Math.max(1, Math.min(50, Number(input.limit) || DEFAULT_LIMIT));
  const includeStale = input.include_stale === true || input.includeStale === true;
  const refresh = input.refresh === true;
  const workspacesRoot = input.workspaces_root || input.workspacesRoot;
  const model = defaultModel(input.embed_model || input.embedModel);
  const sha = currentRevision(abs);
  const observedAt = new Date().toISOString();

  let built = loadChunks({ repoPath: abs, workspacesRoot, sha, model, refresh });
  let buildStats = built.stats;
  if (!built.chunks) {
    const result = buildChunks({ repoPath: abs, workspacesRoot, maxChunks: Number(input.max_chunks) || DEFAULT_MAX_CHUNKS, include: input.include || [] });
    if (!result.indexAvailable) {
      const err = new Error(`no repository index for ${abs}: run scripts/index-repo.js first (repo_search reads the index, it never crawls a second time)`);
      err.code = 'INDEX_UNAVAILABLE';
      throw err;
    }
    saveChunks({ repoPath: abs, workspacesRoot, sha, model, chunks: result.chunks, stats: result.stats });
    built = { chunks: result.chunks, stats: result.stats, dir: searchDirFor({ repoPath: abs, workspacesRoot, sha, model }), loadedFrom: null, built: true };
    buildStats = result.stats;
  }

  const poolSize = Math.max(limit * 8, 80);
  const keyword = keywordRank({ chunks: built.chunks, query, limit: poolSize });

  const apiKey = resolveApiKey(input.api_key || input.apiKey);
  const requestedStrategy = String(input.strategy || 'auto').toLowerCase();
  const wantsDense = requestedStrategy !== 'keyword';
  const resolved = resolveStrategy(requestedStrategy, { denseAvailable: Boolean(apiKey) && wantsDense });

  // `auto` decides AFTER the lexical pass: a confident lexical hit is already
  // the answer (and costs nothing), otherwise the semantic pass runs and owns
  // the ranking — it is measured strictly better than fusing the two.
  let escalated = false;
  if (resolved.strategy === 'auto') {
    if (hasConfidentLexicalHit(keyword)) resolved.strategy = 'keyword';
    else { resolved.strategy = 'dense'; escalated = true; }
  }

  // Embedding is the expensive half, so it is spent where it can matter:
  //   auto   — only after lexical fails to produce a confident hit (see above);
  //   dense  — the whole chunk set (that is the honest cost of pure semantic
  //            retrieval, and the benchmark measures it);
  //   hybrid — only the lexical shortlist (retrieve → embed → rerank), which is
  //            what makes semantic ranking affordable on a real repository.
  const dense = { enabled: false, model, reason: null, stats: null, embeddedChunks: 0, shortlist: 0 };
  let denseHits = [];
  let escalationFailed = false;
  if (resolved.strategy === 'dense' || resolved.strategy === 'hybrid') {
    const shortlist = resolved.strategy === 'hybrid'
      ? keyword.map((h) => h.chunk)
      : built.chunks;
    dense.shortlist = shortlist.length;
    const texts = shortlist.map((c) => [c.path, c.symbol || '', c.text].filter(Boolean).join('\n').slice(0, 6000));
    const embedded = await embedTexts([query, ...texts], {
      model,
      apiKey,
      cacheDir: searchDirFor({ repoPath: abs, workspacesRoot, sha, model }),
    });
    dense.stats = embedded.stats;
    if (embedded.vectors && embedded.vectors[0]) {
      dense.enabled = true;
      dense.reason = null;
      const [queryVector, ...rest] = embedded.vectors;
      dense.embeddedChunks = shortlist.length;
      denseHits = denseRank({ chunks: shortlist, vectors: rest, queryVector, limit: poolSize });
    } else {
      dense.reason = (embedded.stats.errors && embedded.stats.errors[0] && embedded.stats.errors[0].code) || 'embeddings-unavailable';
    }
    if (!dense.enabled) {
      if (escalated) escalationFailed = true;
      resolved.strategy = 'keyword';
    }
  }

  let fused = [];
  if (resolved.strategy === 'hybrid') fused = reciprocalRankFusion([keyword, denseHits]);
  else if (resolved.strategy === 'dense') fused = denseHits.map((h) => ({ chunk: h.chunk, score: h.score, sources: [{ matchKind: h.matchKind, score: Number(h.score.toFixed(4)) }] }));
  else fused = keyword.map((h) => ({ chunk: h.chunk, score: h.score, sources: [{ matchKind: h.matchKind, score: Number(h.score.toFixed(4)) }] }));

  const boosted = fused.map((entry) => {
    const b = boostExact(entry.chunk, query, entry);
    return { chunk: entry.chunk, score: b.score, matchKind: b.matchKind, sources: entry.sources };
  }).sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.startLine - b.chunk.startLine);

  // Freshness is verified against the working tree, never assumed from the
  // index: the top candidate files are re-hashed, deleted/renamed files are
  // dropped and modified files are marked stale instead of being quoted as is.
  const candidateFiles = [...new Set(boosted.slice(0, STALE_SCAN_LIMIT).map((h) => h.chunk.path))];
  const workingHashes = fileHashMap(abs, candidateFiles);
  const dirty = git(abs, ['status', '--porcelain'], '') !== '';
  const dropped = [];
  const stale = [];
  const hits = [];
  for (const hit of boosted) {
    const rel = hit.chunk.path;
    const live = fs.existsSync(path.join(abs, rel));
    if (!live) { dropped.push({ path: rel, reason: 'file-gone-from-working-tree' }); continue; }
    if (!boosted.slice(0, STALE_SCAN_LIMIT).some((h) => h.chunk.path === rel)) continue;
    const now = workingHashes[rel];
    const changed = now && sha && hit.chunk.fileHash && hit.chunk.fileHash !== now;
    if (changed) {
      stale.push({ path: rel, reason: 'file-changed-after-index' });
      if (!includeStale) continue;
    }
    hits.push({
      path: rel,
      start_line: hit.chunk.startLine,
      end_line: hit.chunk.endLine,
      symbol: hit.chunk.symbol || null,
      chunk_kind: hit.chunk.kind,
      snippet: snippetOf(hit.chunk.text),
      score: Number(hit.score.toFixed(4)),
      match_kind: hit.matchKind,
      strategy: resolved.strategy,
      commit_sha: sha,
      source_ref: sha ? `${sha}:${rel}:${hit.chunk.startLine}-${hit.chunk.endLine}` : `${rel}:${hit.chunk.startLine}-${hit.chunk.endLine}`,
      stale: Boolean(changed),
      discovery_only: hit.chunk.kind === 'module-summary',
    });
    if (hits.length >= limit) break;
  }

  const limitations = [
    'A result set is a set of SOURCES, not an answer: read them and decide.',
    'No match is not proof of absence — the search covered only the indexed revision and the files below the chunk budget.',
    'Module summaries are discovery-only, never a normative source.',
  ];
  if (dropped.length) limitations.push(`Dropped ${dropped.length} chunk(s) whose file no longer exists (deleted/renamed after the indexed revision).`);
  if (stale.length && !includeStale) limitations.push(`Excluded ${stale.length} hit(s) whose file changed after the indexed revision (pass include_stale to quote them).`);
  if (buildStats && buildStats.truncated) limitations.push(`Chunk budget reached (${buildStats.chunks} chunks): deeper files are not searched.`);
  if (resolved.degraded && resolved.requested === 'auto') {
    limitations.push(`No embedding provider configured, so the lexical ranker answered alone: cross-lingual and paraphrased questions are exactly where it measures weakest (${resolved.degraded}).`);
  } else if (resolved.degraded) {
    limitations.push(`Requested strategy "${resolved.requested}" degraded to "${resolved.strategy}": ${resolved.degraded}.`);
  }
  if (escalated) limitations.push(`Lexical ranking had no confident match: the semantic pass over ${dense.shortlist} chunk(s) produced this answer.`);
  if (escalationFailed) limitations.push(`Lexical ranking had no confident match and semantic re-ranking was unavailable (${dense.reason}).`);

  return {
    query,
    strategy: resolved.strategy,
    requested_strategy: resolved.requested || resolved.strategy,
    degraded: resolved.degraded || null,
    hits,
    indexed_revision: sha,
    effective_revision: sha,
    working_tree_dirty: dirty,
    scope: dirty ? 'index + working tree (uncommitted changes are NOT reflected in the index; changed files are reported stale)' : 'committed index at HEAD',
    index: {
      chunks: (buildStats && buildStats.chunks) || built.chunks.length,
      indexed_files: (buildStats && buildStats.indexedFiles) || null,
      built_now: Boolean(built.built),
      cache_dir: built.dir || null,
    },
    dense: { enabled: dense.enabled, model, reason: dense.reason, embedded_chunks: dense.embeddedChunks, shortlist: dense.shortlist, stats: dense.stats },
    dropped_stale: dropped,
    stale_files: stale,
    completeness: 'partial',
    limitations,
    observed_at: observedAt,
  };
}

module.exports = { repoSearch };