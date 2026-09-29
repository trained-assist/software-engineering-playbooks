'use strict';

// L0 — the ≤2k-token repository map. Deterministic: it renders the index that
// `build` already produced, plus optional one-line module descriptions that
// come from `llm.js`. The header must always be honest about what was left out
// and how to get more (that honesty is what makes the compressed map safe to
// trust instead of rummaging in the raw tree).

const fs = require('fs');
const path = require('path');

const MAX_FILE_LIST_CHARS = 400;
const TARGET_CHARS = 5400; // ceil(len/3) estimator must stay ≤ 2000 tokens

function moduleNameOf(file) {
  const i = file.indexOf('/');
  return i === -1 ? '(root)' : file.slice(0, i);
}

function basenames(paths) {
  return paths.map((p) => p.split('/').pop());
}

function isDocPath(p) {
  return /(^|\/)(docs?|specs?|adr)(\/|$)/.test(p) || /(^|\/)(readme|architecture|design|spec)(\.|\/|$)/i.test(p);
}

function packageJson(repoPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function entryPoints(index, repoPath) {
  const out = [];
  const paths = new Set(index.files.map((f) => f.path));
  const pkg = packageJson(repoPath);
  if (pkg) {
    if (pkg.main) out.push(`package.json#main → ${pkg.main}`);
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin ? Object.values(pkg.bin) : [];
    for (const bin of bins.slice(0, 5)) out.push(`package.json#bin → ${bin}`);
  }
  for (const candidate of ['index.js', 'src/index.js', 'main.js', 'src/main.js']) {
    if (paths.has(candidate)) out.push(candidate);
  }
  for (const bin of [...paths].filter((p) => p.startsWith('bin/')).sort().slice(0, 5)) {
    if (!out.includes(bin)) out.push(bin);
  }
  if (!out.length) out.push('(явных точек входа нет — смотри package.json / README)');
  return out;
}

function renderL0({ index, sha, repoPath, descriptions = {}, descriptionAvailable = false, targetChars = TARGET_CHARS }) {
  const name = (index.meta.repository && index.meta.repository.name) || 'repository';
  const revision = String(sha || index.meta.revision || '').slice(0, 8);
  const files = index.files || [];
  const symbols = index.symbols || [];
  const tests = index.tests || [];

  const groups = new Map();
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const file of files) {
    const mod = moduleNameOf(file.path);
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(file.path);
  }
  for (const paths of groups.values()) paths.sort();

  const lines = [];
  lines.push(`# Карта репозитория ${name} @ ${revision} (L0, ≤2k токенов)`);
  lines.push(`# Опущено: поимённо ${files.length} файлов и ${symbols.length} символов.`);
  lines.push('#   Скелет всех сигнатур — repo_map(level=1); полный текст — чтение файлов (L2).');
  lines.push(descriptionAvailable
    ? '# Описания модулей: получены (однострочная LLM).'
    : '# Описания модулей недоступны (нет ключа LLM) — карта чисто структурная.');
  lines.push('');

  lines.push('## Точки входа');
  for (const entry of entryPoints(index, repoPath)) lines.push(`- ${entry}`);
  lines.push('');

  lines.push('## Модули');
  const moduleLines = [];
  for (const [mod, groupPaths] of groups) {
    const langs = [...new Set(groupPaths.map((p) => (byPath.get(p) || {}).language || 'text'))].sort().join('/');
    let head = `- ${mod}/ — ${groupPaths.length} файлов (${langs})`;
    const desc = descriptions[mod];
    if (desc) head += ` — ${desc}`;
    const names = basenames(groupPaths);
    let list = names.slice(0, 12).join(', ');
    if (names.length > 12) list += `, +${names.length - 12}`;
    if (list.length > MAX_FILE_LIST_CHARS) list = `${list.slice(0, MAX_FILE_LIST_CHARS - 3)}...`;
    moduleLines.push(head, `    файлы: ${list}`);
  }
  lines.push(...moduleLines);
  lines.push('');

  lines.push('## Где что лежит');
  const testDirs = [...new Set(tests.map(moduleNameOf))].sort();
  lines.push(`- Тесты: ${testDirs.length ? testDirs.map((d) => `${d}/`).join(', ') : 'не найдены по именам'} (${tests.length} шт.)`);
  const docs = files.map((f) => f.path).filter(isDocPath);
  lines.push(`- Документация: ${docs.length ? docs.slice(0, 8).join(', ') : 'нет выделенной папки docs'}`);
  const config = files.map((f) => f.path)
    .filter((p) => /^(package\.json|tsconfig|\.github\/|Dockerfile|docker-compose|\.env\.example|Makefile|ci\/)/i.test(p))
    .sort();
  lines.push(`- Конфиг/деплой: ${config.length ? config.slice(0, 8).join(', ') : 'не найдено'}`);
  lines.push('');
  lines.push('# Дальше: repo_map(level=1, focus=["<символ или путь>"]) → скелет, затем читай 1–5 файлов.');

  let text = lines.join('\n');
  let listsCut = 0;

  // Honest truncation: shrink the least useful bulk (per-module file lists)
  // first, never the header or the entry points, and say how much was cut.
  if (text.length > targetChars) {
    for (let i = lines.length - 1; i >= 0 && text.length > targetChars; i--) {
      if (lines[i].startsWith('    файлы: ')) {
        lines[i] = '    файлы: (список опущен — см. repo_map(level=1))';
        listsCut += 1;
      }
    }
    text = lines.join('\n');
  }
  if (text.length > targetChars) {
    const kept = [];
    let budget = targetChars - 160;
    for (const line of lines) {
      if (line.length + 1 > budget) break;
      kept.push(line);
      budget -= line.length + 1;
    }
    const cut = Math.max(0, files.length - kept.length);
    kept.push(`# Обрезано по бюджету L0: ещё ${cut} строк не показано — полный список в repo_map(level=1).`);
    text = kept.join('\n');
  } else if (listsCut) {
    lines[3] = `${lines[3]} (список файлов в модулях опущен: ${listsCut})`;
    text = lines.join('\n');
  }

  return text;
}

module.exports = { renderL0, moduleNameOf, isDocPath, TARGET_CHARS };
