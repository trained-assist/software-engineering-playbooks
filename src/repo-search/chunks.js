'use strict';

// Retrieval chunks: the unit the search ranks. Built FROM the existing per-sha
// index (repo-map resolves it) + the working tree, never from a second
// independent crawl — symbol boundaries come from the parser-backed index, the
// body text from the file on disk. A chunk knows its line range, so a hit can
// cite path:start-end instead of a whole file.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveIndexRoot } = require('../repo-map/paths');
const { readIndexDir } = require('../repo-map/build');
const { tokenize } = require('./keyword');

const DEFAULT_MAX_CHUNKS = 6000;
const MAX_CHUNK_LINES = 120;
const MAX_CHUNK_CHARS = 2400;
const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.txt']);

function readIndexFor(repoPath, options) {
  const dir = resolveIndexRoot(repoPath, options);
  if (!dir) return null;
  try {
    const index = readIndexDir(dir);
    if (!index || !Array.isArray(index.files)) return null;
    return { index, dir };
  } catch {
    return null;
  }
}

function sliceLines(lines, startLine, maxLines) {
  const out = [];
  let chars = 0;
  for (let i = startLine - 1; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i];
    out.push(line);
    chars += line.length + 1;
    if (chars >= MAX_CHUNK_CHARS) break;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function normalizeText(lines) {
  return lines.join('\n').replace(/[ \t]+/g, ' ').trim();
}

function priorityOf(rel, kind) {
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(rel) || /\.(test|spec)\./.test(rel)) return 3;
  if (kind === 'module-summary') return 0;
  if (kind === 'doc-section') return 1;
  if (rel.startsWith('src/') || rel.startsWith('lib/')) return 1;
  if (/^(docs?|README|CLAUDE)/.test(rel)) return 2;
  return 2;
}

function codeChunks(rel, lines, symbols, stats) {
  const starts = (symbols && symbols.length ? symbols : [])
    .filter((s) => Number.isInteger(s.line) && s.line >= 1 && s.line <= lines.length)
    .slice()
    .sort((a, b) => a.line - b.line);
  if (!starts.length) {
    const body = sliceLines(lines, 1, MAX_CHUNK_LINES);
    if (!body.length) return [];
    return [{
      path: rel,
      startLine: 1,
      endLine: body.length,
      symbol: null,
      kind: 'code-file',
      text: normalizeText(body),
    }];
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].line;
    const to = i + 1 < starts.length ? starts[i + 1].line - 1 : Math.min(lines.length, from + MAX_CHUNK_LINES - 1);
    const body = sliceLines(lines, from, Math.min(MAX_CHUNK_LINES, Math.max(1, to - from + 1)));
    if (!body.length) continue;
    out.push({
      path: rel,
      startLine: from,
      endLine: from + body.length - 1,
      symbol: starts[i].name,
      symbolKind: starts[i].kind,
      kind: 'code-symbol',
      text: normalizeText(body),
    });
  }
  if (lines.length > MAX_CHUNK_LINES * 2 && starts.length) {
    stats.tailSkippedFiles = (stats.tailSkippedFiles || 0) + 1;
  }
  return out;
}

function docChunks(rel, lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{1,4}\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) heads.push({ line: i + 1, title: m[1].trim(), level: (m[0].match(/^#+/) || [''])[0].length });
  }
  if (!heads.length) {
    const body = sliceLines(lines, 1, MAX_CHUNK_LINES);
    return body.length ? [{ path: rel, startLine: 1, endLine: body.length, symbol: null, kind: 'doc-file', text: normalizeText(body) }] : [];
  }
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const next = i + 1 < heads.length ? heads[i + 1].line - 1 : lines.length;
    const body = sliceLines(lines, heads[i].line, Math.min(MAX_CHUNK_LINES, Math.max(1, next - heads[i].line + 1)));
    if (!body.length) continue;
    out.push({
      path: rel,
      startLine: heads[i].line,
      endLine: heads[i].line + body.length - 1,
      symbol: heads[i].title,
      kind: 'doc-section',
      text: normalizeText(body),
    });
  }
  return out;
}

// A module summary is DISCOVERY, never a normative source: the index knows a
// module's name, languages and hotspot files, plus the first meaningful line of
// its files. It is one cheap hit that answers "what is this directory", and it
// is labelled as `module-summary` so a caller can tell it from real code.
function moduleSummaryChunks(modules, files) {
  const byPrefix = new Map();
  for (const file of files || []) {
    const module = moduleNameOf(file.path);
    if (!byPrefix.has(module)) byPrefix.set(module, []);
    byPrefix.get(module).push(file);
  }
  const out = [];
  for (const module of modules || []) {
    const candidates = byPrefix.get(module.name) || [];
    const heads = candidates.map((f) => (f.head || '').trim()).filter(Boolean).slice(0, 3);
    const paths = candidates.map((f) => f.path).sort();
    const text = [
      `module ${module.name}`,
      `${module.fileCount} files`,
      Object.keys(module.languages || {}).join(' '),
      ...heads,
    ].filter(Boolean).join(' — ');
    out.push({
      path: paths[0] || `(module ${module.name})`,
      startLine: 1,
      endLine: 1,
      symbol: `module:${module.name}`,
      kind: 'module-summary',
      module: module.name,
      files: paths.slice(0, 12),
      text: normalizeText([text]),
    });
  }
  return out;
}

function moduleNameOf(file) {
  const i = String(file).indexOf('/');
  return i === -1 ? '(root)' : String(file).slice(0, i);
}

// Chunks are a derived view: if a file the index knows about is gone from the
// working tree (deleted or renamed), it is dropped and counted — that is what
// keeps a stale index from serving the old version as current.
function buildChunks({ repoPath, workspacesRoot, maxChunks = DEFAULT_MAX_CHUNKS, include = [] } = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  const abs = path.resolve(repoPath);
  const found = readIndexFor(abs, { workspacesRoot });
  const stats = { files: 0, droppedMissing: [], droppedUnreadable: [], chunks: 0, truncated: false, indexSource: found ? found.dir : null, indexedFiles: 0 };
  if (!found) return { chunks: [], stats, indexAvailable: false };

  const files = found.index.files.slice()
    .filter((f) => !include.length || include.some((prefix) => f.path.startsWith(prefix)))
    .map((f) => ({ ...f, prio: priorityOf(f.path, 'code') }))
    .sort((a, b) => a.prio - b.prio || b.size - a.size || a.path.localeCompare(b.path));
  stats.indexedFiles = files.length;

  // Breadth-first assembly: every file gets its first chunk(s) before any file
  // gets its second. The budget then truncates DEPTH, never a whole small file —
  // a 12-line module with the answer must not lose to a 4000-line file that
  // merely came first in size order.
  const byFile = [];
  let currentFile = null;
  let currentHash = null;
  let currentList = null;
  const push = (chunk) => {
    if (!currentList) return;
    chunk.id = `${chunk.path}#${chunk.startLine}-${chunk.endLine}`;
    chunk.fileHash = currentHash;
    // Terms are precomputed once at index time: the ranker runs on every query
    // and re-tokenizing 3.7k chunks per query cost ~800 ms.
    chunk.terms = tokenize(chunk.text).terms;
    currentList.push(chunk);
  };

  for (const file of files) {
    const full = path.join(abs, file.path);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      stats.droppedMissing.push(file.path);
      continue;
    }
    const lines = content.split(/\r?\n/);
    currentFile = file.path;
    currentHash = crypto.createHash('sha1').update(content).digest('hex');
    currentList = [];
    byFile.push(currentList);
    stats.files += 1;
    const ext = path.extname(file.path).toLowerCase();
    if (DOC_EXT.has(ext)) {
      for (const chunk of docChunks(file.path, lines)) push(chunk);
      continue;
    }
    if (!/javascript|typescript|json|yaml|python|go|rust|java|ruby|php/.test(file.language || '')) {
      const body = sliceLines(lines, 1, MAX_CHUNK_LINES);
      if (body.length) push({ path: file.path, startLine: 1, endLine: body.length, symbol: null, kind: 'code-file', text: normalizeText(body) });
      continue;
    }
    for (const chunk of codeChunks(file.path, lines, file.symbols, stats)) push(chunk);
  }

  const summaries = moduleSummaryChunks(found.index.modules, found.index.files);
  if (summaries.length) byFile.push(summaries);

  const chunks = [];
  const depth = new Array(byFile.length).fill(0);
  let fileIndex = 0;
  while (chunks.length < maxChunks) {
    let progressed = false;
    for (let i = 0; i < byFile.length && chunks.length < maxChunks; i++) {
      const list = byFile[(fileIndex + i) % byFile.length];
      const d = depth[(fileIndex + i) % byFile.length];
      if (d >= list.length) continue;
      chunks.push(list[d]);
      depth[(fileIndex + i) % byFile.length] += 1;
      progressed = true;
    }
    if (!progressed) break;
    fileIndex = (fileIndex + 1) % byFile.length;
  }
  const carriedOver = byFile.reduce((sum, list, i) => sum + Math.max(0, list.length - depth[i]), 0);
  stats.truncated = carriedOver > 0;
  stats.chunksLeftBehind = carriedOver;
  stats.chunks = chunks.length;
  return { chunks, stats, indexAvailable: true };
}

module.exports = { buildChunks, readIndexFor, DEFAULT_MAX_CHUNKS, MAX_CHUNK_LINES };