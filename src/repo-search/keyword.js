'use strict';

// Lexical ranking over retrieval chunks, in two regimes:
//
//   identifier query ("atomicJson", "TG_MAX_LEN") — string presence of the whole
//   identifier in symbol/path/body. Splitting it into parts ("json" everywhere)
//   is what makes naive BM25 useless for code, so this regime never splits.
//   natural language ("где ограничивают аттестацию бюджет") — BM25-style term
//   weighting over three fields (symbol ×3, path ×2, body ×1) plus exact-symbol
//     boost, with a two-term floor so one common word cannot produce a confident
//     answer out of a 4000-chunk corpus.

const FIELD_WEIGHTS = { symbol: 3, path: 2, text: 1 };
const K1 = 1.2;
const B = 0.6;
const EXACT_SYMBOL_BOOST = 25;
const PARTIAL_SYMBOL_BOOST = 10;
const WHOLE_WORD_BOOST = 5;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'where', 'what', 'how', 'does', 'is', 'are', 'in', 'of', 'to',
  'где', 'как', 'что', 'и', 'в', 'на', 'для', 'к', 'по', 'а', 'же', 'то', 'не', 'no', 'not',
]);

function splitIdentifier(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenize(query) {
  const raw = String(query || '').trim();
  const words = raw.toLowerCase().split(/[^0-9a-zа-яё_]+/i).filter(Boolean);
  const terms = new Set();
  for (const word of words) {
    if (word.length < 3 || STOP.has(word)) continue;
    terms.add(word);
    for (const part of splitIdentifier(word)) if (part.length >= 3 && !STOP.has(part)) terms.add(part);
  }
  return { raw, normalized: raw.toLowerCase().replace(/[^0-9a-zа-яё]+/g, ''), terms: [...terms] };
}

function isIdentifierQuery(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/^[A-Za-z][A-Za-z0-9_$]*$/.test(trimmed)) return false;
  return /[A-Z_]/.test(trimmed.slice(1)) || /[A-Z]/.test(trimmed);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identifierScore(chunk, raw) {
  const needle = String(raw).toLowerCase();
  const symbolLow = String(chunk.symbol || '').toLowerCase();
  const pathLow = String(chunk.path || '').toLowerCase();
  let score = 0;
  let matchKind = 'text';
  if (symbolLow === needle) { score += 100; matchKind = 'symbol-exact'; }
  else if (symbolLow.includes(needle)) { score += 60; matchKind = 'symbol'; }
  if (pathLow.includes(needle)) { score += 50; if (matchKind === 'text') matchKind = 'path'; }
  try {
    const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i');
    if (re.test(chunk.text)) { score += 30; if (matchKind === 'text') matchKind = 'whole-word'; }
    else if (chunk.text.toLowerCase().includes(needle)) { score += 15; if (matchKind === 'text') matchKind = 'substring'; }
  } catch {
    // A query with regex metacharacters simply skips the word-boundary probe.
  }
  return score ? { score, matchKind } : null;
}

function sortHits(scored, limit) {
  return scored
    .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.startLine - b.chunk.startLine)
    .slice(0, limit);
}

function identifierRank({ chunks, query, limit = 8 } = {}) {
  const scored = [];
  for (const chunk of chunks) {
    const hit = identifierScore(chunk, String(query).trim());
    if (hit) scored.push({ chunk, score: hit.score, matchKind: hit.matchKind, matchedTerms: 1 });
  }
  return sortHits(scored, limit);
}

function keywordRank({ chunks, query, limit = 8 } = {}) {
  if (isIdentifierQuery(query)) return identifierRank({ chunks, query, limit });
  const q = tokenize(query);
  if (!q.terms.length) return [];

  const prepared = chunks.map((chunk) => {
    const text = Array.isArray(chunk.terms) ? chunk.terms : tokenize(chunk.text).terms;
    return {
      chunk,
      symbolCounts: countTerms(tokenize(chunk.symbol || '').terms),
      pathCounts: countTerms(tokenize(String(chunk.path || '').replace(/[/_.-]+/g, ' ')).terms),
      textCounts: countTerms(text),
      len: Math.max(1, text.length),
    };
  });
  const N = prepared.length;
  const df = new Map();
  for (const term of q.terms) {
    let n = 0;
    for (const row of prepared) {
      if (row.symbolCounts.has(term) || row.pathCounts.has(term) || row.textCounts.has(term)) n++;
    }
    df.set(term, n);
  }

  const scored = [];
  for (const row of prepared) {
    let score = 0;
    const matched = new Set();
    for (const term of q.terms) {
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      let tf = 0;
      tf += (row.symbolCounts.get(term) || 0) * FIELD_WEIGHTS.symbol;
      tf += (row.pathCounts.get(term) || 0) * FIELD_WEIGHTS.path;
      tf += (row.textCounts.get(term) || 0) * FIELD_WEIGHTS.text;
      if (!tf) continue;
      matched.add(term);
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (row.len / 200))));
    }
    if (!score) continue;

    const symbolNorm = String(row.chunk.symbol || '').toLowerCase().replace(/[^0-9a-zа-яё]+/g, '');
    let matchKind = 'text';
    if (q.normalized.length >= 4 && symbolNorm === q.normalized) { score += EXACT_SYMBOL_BOOST; matchKind = 'symbol-exact'; }
    else if (q.normalized.length >= 4 && symbolNorm && (symbolNorm.includes(q.normalized) || q.normalized.includes(symbolNorm))) { score += PARTIAL_SYMBOL_BOOST; matchKind = 'symbol'; }
    if (q.normalized.length >= 4) {
      try {
        if (new RegExp(`\\b${escapeRegExp(q.normalized)}\\b`, 'i').test(row.chunk.text)) {
          score += WHOLE_WORD_BOOST;
          if (matchKind === 'text') matchKind = 'whole-word';
        }
      } catch { /* see identifierScore */ }
    }
    scored.push({ chunk: row.chunk, score, matchKind, matchedTerms: matched.size });
  }

  // Two-term floor: with three or more query terms, a single coincidental word
  // match is not an answer. Such hits are kept but demoted and labelled, so the
  // caller sees WHY it got them instead of a confident wrong file.
  const floor = q.terms.length >= 3 ? 2 : 1;
  const strong = scored.filter((h) => h.matchedTerms >= floor);
  const weak = scored.filter((h) => h.matchedTerms < floor)
    .slice(0, Math.max(0, limit - strong.length))
    .map((h) => ({ ...h, matchKind: `weak-${h.matchKind}`, score: h.score * 0.25 }));
  return sortHits([...strong, ...weak], limit);
}

function countTerms(terms) {
  const counts = new Map();
  for (const t of terms) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

module.exports = { keywordRank, identifierRank, tokenize, isIdentifierQuery };