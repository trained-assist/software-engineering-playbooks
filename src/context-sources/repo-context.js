'use strict';

const fs = require('fs');
const path = require('path');
const { discoverRawContext, termsFrom } = require('./raw-repo');
const { indexCompatibility } = require('../index');
const { discoverIndexedContext } = require('./indexed-repo');

const DEFAULT_MAX_RESULTS = 24;

function rawEntries({ repoPath, keywords, maxResults = DEFAULT_MAX_RESULTS }) {
  const raw = discoverRawContext({ repoPath, task: keywords, maxResults });
  const byFile = new Map();
  for (const item of raw.likelyFiles) {
    byFile.set(item.file, {
      path: item.file,
      line: null,
      snippet: '',
      why: `path/filename match (score ${item.score})`,
      score: item.score,
    });
  }
  for (const hit of raw.grepMatches) {
    const existing = byFile.get(hit.file);
    if (existing && existing.line === null) {
      existing.line = hit.line;
      existing.snippet = hit.excerpt;
      existing.why = `content match: ${hit.term}`;
      existing.score += 3;
    } else if (!existing) {
      byFile.set(hit.file, {
        path: hit.file,
        line: hit.line,
        snippet: hit.excerpt,
        why: `content match: ${hit.term}`,
        score: 3,
      });
    }
  }
  return [...byFile.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map(({ score, ...entry }) => entry);
}

function indexedEntries(context, maxResults) {
  const byKey = new Map();
  const push = (entry) => {
    const key = `${entry.path}:${entry.line ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  };
  for (const symbol of context.symbolMatches) {
    push({
      path: symbol.path,
      line: symbol.line,
      snippet: symbol.text,
      why: `symbol ${symbol.kind} "${symbol.name}" match`,
      score: symbol.score + 2,
    });
  }
  for (const file of context.likelyFiles) {
    push({
      path: file.file,
      line: null,
      snippet: file.head || '',
      why: `path/filename match (score ${file.score})`,
      score: file.score,
    });
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxResults)
    .map(({ score, ...entry }) => entry);
}

// "Give me context by keys, super fast, without rummaging." Fresh index → query
// it; otherwise the deterministic raw-repo keyword ranking. No network, no LLM.
function repoContext({ repoPath, keywords, maxResults = DEFAULT_MAX_RESULTS, budget } = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  const hasKeywords = keywords !== undefined && keywords !== null
    && (Array.isArray(keywords) ? keywords.length > 0 : String(keywords).trim().length > 0);
  if (!hasKeywords) throw new Error('keywords is required');

  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Repository path not found: ${abs}`);

  const terms = termsFrom({ keywords });
  const compat = indexCompatibility(abs);
  let source;
  let entries;
  if (compat.usable) {
    const context = discoverIndexedContext({ repoPath: abs, keywords, maxResults });
    entries = indexedEntries(context, maxResults);
    source = 'indexed-repo';
  } else {
    entries = rawEntries({ repoPath: abs, keywords, maxResults });
    source = 'raw-repo';
  }

  const cap = Number.isFinite(budget) && budget > 0 ? Math.min(entries.length, Math.floor(budget)) : entries.length;
  return {
    repoPath: abs,
    source,
    keywords: terms,
    count: cap,
    entries: entries.slice(0, cap),
  };
}

module.exports = { repoContext, rawEntries, indexedEntries };
