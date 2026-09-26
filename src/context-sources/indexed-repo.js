'use strict';

const path = require('path');
const {
  indexRoot,
  readIndexData,
  indexCompatibility,
  INDEX_SCHEMA_VERSION,
} = require('../index');
const { termsFrom, scoreFile } = require('./raw-repo');

function canUseIndex(repoPath) {
  return indexCompatibility(repoPath).usable;
}

function isDoc(file) {
  const low = file.toLowerCase();
  return /(^|\/)(docs?|specs?|adr)(\/|$)/.test(low) || /readme|architecture|design|spec/.test(low);
}

function symbolScore(symbol, terms) {
  const name = symbol.name.toLowerCase();
  const text = String(symbol.text || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 2;
    else if (text.includes(term)) score += 1;
  }
  return score;
}

function relatedTests(data, likelyFiles, maxResults = 20) {
  const stems = new Set(
    likelyFiles.map((x) => path.basename(x.file).replace(/\.[^.]+$/, '').toLowerCase()).filter((s) => s.length >= 4),
  );
  const tests = data.tests || [];
  if (!stems.size) return tests.slice(0, maxResults);
  return tests
    .filter((t) => [...stems].some((s) => t.toLowerCase().includes(s)))
    .slice(0, maxResults);
}

// Query the precomputed index. Throws when the index is missing/incompatible;
// callers treat that as "fall back to raw", never as a hard failure.
function discoverIndexedContext({ repoPath, task, keywords, maxResults = 24 } = {}) {
  const abs = path.resolve(repoPath);
  const compat = indexCompatibility(abs);
  if (!compat.usable) throw new Error(`repository index is not usable (${compat.reason})`);
  const data = readIndexData(abs);
  if (!data) throw new Error('repository index is incomplete');

  const terms = termsFrom({ task, keywords });
  const symbolsByPath = new Map();
  for (const symbol of data.symbols) {
    if (!symbolsByPath.has(symbol.path)) symbolsByPath.set(symbol.path, []);
    symbolsByPath.get(symbol.path).push(symbol);
  }

  const scored = data.files
    .map((file) => {
      let score = scoreFile(file.path, terms);
      let symbolHits = 0;
      for (const symbol of symbolsByPath.get(file.path) || []) {
        const s = symbolScore(symbol, terms);
        if (s > 0) { score += s; symbolHits += 1; }
      }
      return { file: file.path, score, head: file.head || '', symbolHits };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxResults);

  const likelyFiles = scored.map(({ file, score, head, symbolHits }) => ({ file, score, head, symbolHits }));

  const symbolMatches = data.symbols
    .map((symbol) => ({ ...symbol, score: symbolScore(symbol, terms) }))
    .filter((symbol) => symbol.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, maxResults * 2);

  const relatedDocs = data.files
    .map((f) => f.path)
    .filter(isDoc)
    .map((file) => ({ file, score: scoreFile(file, terms) + 1 }))
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 16)
    .map((x) => x.file);

  return {
    source: 'indexed-repo',
    terms,
    index: {
      schemaVersion: data.meta.schemaVersion,
      revision: data.meta.revision,
      generatedAt: data.meta.generatedAt,
      branch: data.meta.branch,
    },
    likelyFiles,
    symbolMatches,
    relatedTests: relatedTests(data, likelyFiles),
    relatedDocs,
    hotspots: (data.hotspots || []).slice(0, maxResults),
    fileCount: data.files.length,
  };
}

module.exports = {
  canUseIndex,
  discoverIndexedContext,
  indexRoot,
  INDEX_SCHEMA_VERSION,
};
