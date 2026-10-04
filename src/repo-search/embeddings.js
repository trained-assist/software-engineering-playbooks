'use strict';

// Optional dense retrieval over the same chunks. The provider is OpenRouter's
// embeddings endpoint (no new runtime, no second index lifecycle) and it is
// OFF unless a key is present: a repository search must degrade to the lexical
// ranker, never fail because nobody configured an embedding service.
//
// Vectors are cached on disk per (model, text hash), so an unchanged chunk is
// embedded once; changing a file embeds only the chunks whose text changed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
const DEFAULT_MODEL = 'google/gemini-embedding-001';
const BATCH_SIZE = 64;
const TIMEOUT_MS = 45000;

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function modelKey(model) {
  return hash(model).slice(0, 12);
}

function resolveApiKey(explicit) {
  const key = explicit || process.env.OPENROUTER_API_KEY || process.env.ENGINEERING_SEARCH_EMBED_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}

function defaultModel(explicit) {
  return explicit || process.env.ENGINEERING_SEARCH_EMBED_MODEL || DEFAULT_MODEL;
}

function approxTokens(text) {
  return Math.ceil(String(text).length / 4);
}

async function postBatch(inputs, { model, apiKey, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/trained-assist/software-engineering-playbooks',
        'X-Title': 'trained-assist engineering_repo_search',
      },
      body: JSON.stringify({ model, input: inputs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.code = 'EMBEDDINGS_HTTP';
      throw err;
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((d) => (Array.isArray(d.embedding) ? d.embedding : null));
  } finally {
    clearTimeout(timer);
  }
}

function cacheFile(cacheDir, model) {
  return path.join(cacheDir, `embed-${modelKey(model)}.json`);
}

function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

// Returns vectors aligned to `texts` (null where the provider failed), plus the
// counters the benchmark needs: how much was cached, how much was really sent.
async function embedTexts(texts, { model, apiKey, cacheDir, batchSize = BATCH_SIZE } = {}) {
  const useModel = defaultModel(model);
  const key = resolveApiKey(apiKey);
  const stats = { model: useModel, requested: texts.length, cached: 0, embedded: 0, tokensApprox: 0, errors: [] };
  if (!key) {
    stats.errors.push({ code: 'NO_API_KEY', message: 'OPENROUTER_API_KEY is not set — dense retrieval unavailable' });
    return { vectors: null, stats };
  }
  if (!cacheDir) {
    stats.errors.push({ code: 'NO_CACHE_DIR', message: 'cacheDir is required so embeddings are not recomputed per query' });
    return { vectors: null, stats };
  }
  const file = cacheFile(cacheDir, useModel);
  const cache = readCache(file);
  const vectors = new Array(texts.length).fill(null);
  const pending = [];
  texts.forEach((text, i) => {
    const key2 = hash(`${useModel}\u0000${text}`);
    if (cache[key2]) { vectors[i] = cache[key2]; stats.cached++; } else pending.push(i);
  });
  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize);
    const batchTexts = slice.map((idx) => texts[idx]);
    stats.tokensApprox += batchTexts.reduce((sum, t) => sum + approxTokens(t), 0);
    try {
      const got = await postBatch(batchTexts, { model: useModel, apiKey: key });
      slice.forEach((idx, j) => {
        const vec = got[j] || null;
        vectors[idx] = vec;
        if (vec) cache[hash(`${useModel}\u0000${texts[idx]}`)] = vec;
      });
      stats.embedded += slice.length;
    } catch (e) {
      stats.errors.push({ code: e.code || 'EMBEDDINGS_FAILED', message: String(e.message || e).slice(0, 200) });
    }
  }
  try { writeCache(file, cache); } catch { /* a cold cache is recoverable, a full disk is not worth failing a query */ }
  if (!vectors.some(Boolean)) return { vectors: null, stats };
  return { vectors, stats };
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function denseRank({ chunks, vectors, queryVector, limit = 8, minScore = 0.2 } = {}) {
  const scored = [];
  for (let i = 0; i < chunks.length; i++) {
    const vec = vectors && vectors[i];
    if (!vec) continue;
    const score = cosine(queryVector, vec);
    if (score < minScore) continue;
    scored.push({ chunk: chunks[i], score, matchKind: 'dense', matchedTerms: 0 });
  }
  return scored.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path)).slice(0, limit);
}

module.exports = { embedTexts, denseRank, cosine, modelKey, resolveApiKey, defaultModel, DEFAULT_MODEL, ENDPOINT };