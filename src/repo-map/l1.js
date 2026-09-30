'use strict';

// L1 — the skeleton of the repository: every file ranked by importance, each
// with its signatures. Strictly deterministic (no LLM, no clock), so the same
// commit renders byte-for-byte the same text and the agent can re-read it
// cheaply. `focus` only re-ranks: files carrying a focus term go to the top.

const MAX_FILES = 220;
const MAX_SYMBOLS_PER_FILE = 40;

function renderL1({ index, sha, focus = [], maxFiles = MAX_FILES, maxSymbolsPerFile = MAX_SYMBOLS_PER_FILE }) {
  const meta = index.meta || {};
  const name = (meta.repository && meta.repository.name) || 'repository';
  const revision = String(sha || meta.revision || '').slice(0, 8);
  const terms = []
    .concat(focus || [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  const symbolsByPath = new Map();
  for (const symbol of index.symbols || []) {
    if (!symbolsByPath.has(symbol.path)) symbolsByPath.set(symbol.path, []);
    symbolsByPath.get(symbol.path).push(symbol);
  }
  const hotspotByPath = new Map((index.hotspots || []).map((h) => [h.path, h.changes]));

  const ranked = (index.files || []).map((file) => {
    const symbols = (symbolsByPath.get(file.path) || []).slice().sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    const low = file.path.toLowerCase();
    let score = symbols.length * 3 + (hotspotByPath.get(file.path) || 0);
    let hit = false;
    for (const term of terms) {
      if (low.includes(term) || symbols.some((s) => s.name.toLowerCase().includes(term))) {
        score += 1000;
        hit = true;
      }
    }
    return { path: file.path, symbols, score, hit, changes: hotspotByPath.get(file.path) || 0 };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const kept = ranked.slice(0, maxFiles);
  const omittedFiles = Math.max(0, ranked.length - kept.length);
  const totalSymbols = (index.symbols || []).length;
  let shownSymbols = 0;
  let omittedSymbols = kept.reduce(
    (sum, file) => sum + Math.max(0, file.symbols.length - maxSymbolsPerFile),
    0,
  );

  const lines = [];
  lines.push(`# ${name} @ ${revision} — скелет (L1): ${ranked.length} файлов, ${totalSymbols} символов`);
  lines.push(`# Опущено в этом виде: ${omittedFiles} файлов, ${omittedSymbols} символов —`);
  lines.push('#   больше не сжимается: читай нужные файлы целиком (L2), сырой репо — запасной путь.');
  if (terms.length) lines.push(`# focus: ${terms.join(', ')} — файлы с совпадением наверху.`);
  lines.push('');

  for (const file of kept) {
    lines.push(`## ${file.path}${file.changes ? ` (изменялся ${file.changes} раз)` : ''}`);
    const shown = file.symbols.slice(0, maxSymbolsPerFile);
    for (const symbol of shown) {
      const body = symbol.text && symbol.text.includes(symbol.name.split('.').pop())
        ? symbol.text
        : `${symbol.kind} ${symbol.name}`;
      lines.push(`  ${body}`);
      shownSymbols += 1;
    }
    if (file.symbols.length > shown.length) lines.push(`  … ещё ${file.symbols.length - shown.length} символов`);
    if (!file.symbols.length && file.head) lines.push(`  ${file.head}`);
  }
  if (omittedFiles) {
    lines.push('');
    lines.push(`# Всего показано: ${kept.length} файлов, ${shownSymbols} символов; опущено ${omittedFiles} файлов и ${omittedSymbols} символов.`);
  }

  return lines.join('\n');
}

module.exports = { renderL1, MAX_FILES, MAX_SYMBOLS_PER_FILE };
