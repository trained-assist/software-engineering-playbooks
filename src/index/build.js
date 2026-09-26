'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { languageFor, isBinaryFile, isScannable, extractSymbols, firstNonEmptyLine } = require('./lang');
const { INDEX_SCHEMA_VERSION, GENERATOR, indexRoot } = require('./schema');

const MAX_FILE_BYTES = 1_000_000;
const HISTORY_WINDOW = 200;
const MAX_HOTSPOTS = 40;
const MAX_SYMBOLS_PER_FILE = 200;
const MAX_HEAD_BYTES = 64 * 1024;

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function git(cwd, args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return fallback;
  }
}

function isGitRepo(repoPath) {
  return git(repoPath, ['rev-parse', '--is-inside-work-tree'], '') === 'true';
}

function currentRevision(repoPath) {
  return git(repoPath, ['rev-parse', 'HEAD'], null) || null;
}

function remoteUrl(repoPath) {
  return git(repoPath, ['config', '--get', 'remote.origin.url'], null) || null;
}

function repositoryIdentity(repoPath) {
  const name = path.basename(repoPath);
  const remote = remoteUrl(repoPath);
  return { id: sha1(remote || `local:${name}`).slice(0, 16), name, remote, root: repoPath };
}

function moduleName(file) {
  const i = file.indexOf('/');
  return i === -1 ? '(root)' : file.slice(0, i);
}

function isTestFile(file) {
  const low = file.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(low)) return true;
  if (/\.(test|spec)\.[^/]+$/.test(low)) return true;
  if (/_test\.(go|py|rb|rs)$/.test(low)) return true;
  if (/(^|\/)test_[^/]+\.py$/.test(low)) return true;
  return false;
}

function testStem(file) {
  const base = path.basename(file).toLowerCase();
  return base
    .replace(/\.(test|spec)\.[^.]+$/, '')
    .replace(/_test\.(go|py|rb|rs)$/, '')
    .replace(/^test_/, '')
    .replace(/\.[^.]+$/, '');
}

function readFileSummary(abs, rel) {
  const full = path.join(abs, rel);
  let size = 0;
  try { size = fs.statSync(full).size; } catch { /* deleted/untracked */ }
  const language = languageFor(rel);
  const summary = { path: rel, size, ext: path.extname(rel).toLowerCase(), language, head: '', lines: 0, symbols: [] };
  if (size > MAX_FILE_BYTES || isBinaryFile(rel)) return summary;
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch { return summary; }
  summary.lines = content.length ? content.split(/\r?\n/).length : 0;
  summary.head = firstNonEmptyLine(content.slice(0, MAX_HEAD_BYTES));
  if (isScannable(language)) summary.symbols = extractSymbols(rel, content, { maxSymbols: MAX_SYMBOLS_PER_FILE });
  return summary;
}

function collectHistoryHotspots(abs, tracked) {
  const trackedSet = new Set(tracked);
  const raw = git(abs, ['log', `-n`, String(HISTORY_WINDOW), '--name-only', '--pretty=format:'], '');
  const counts = new Map();
  for (const line of raw.split('\n')) {
    const file = line.trim();
    if (!file || !trackedSet.has(file)) continue;
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, changes]) => ({ path: file, changes }))
    .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path))
    .slice(0, MAX_HOTSPOTS);
}

function sortLanguages(languages) {
  const out = {};
  for (const key of Object.keys(languages).sort()) out[key] = languages[key];
  return out;
}

function summarizeModules(files, hotspots) {
  const groups = new Map();
  for (const file of files) {
    const name = moduleName(file.path);
    let group = groups.get(name);
    if (!group) {
      group = { name, fileCount: 0, languages: {}, hotspots: [] };
      groups.set(name, group);
    }
    group.fileCount += 1;
    group.languages[file.language] = (group.languages[file.language] || 0) + 1;
  }
  const hotspotByModule = new Map();
  for (const h of hotspots) {
    const name = moduleName(h.path);
    if (!hotspotByModule.has(name)) hotspotByModule.set(name, []);
    hotspotByModule.get(name).push(h.path);
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      fileCount: group.fileCount,
      languages: sortLanguages(group.languages),
      hotspots: (hotspotByModule.get(group.name) || []).slice(0, 8),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildTestIndex(files) {
  const tests = files.map((f) => f.path).filter(isTestFile).sort();
  const byStem = {};
  for (const test of tests) {
    const stem = testStem(test);
    if (!stem) continue;
    if (!byStem[stem]) byStem[stem] = [];
    byStem[stem].push(test);
  }
  for (const stem of Object.keys(byStem)) byStem[stem].sort();
  return { tests, byStem };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function writeIndex(root, index) {
  fs.mkdirSync(root, { recursive: true });
  writeJsonAtomic(path.join(root, 'revision.json'), index.meta);
  writeJsonAtomic(path.join(root, 'files.json'), { revision: index.meta.revision, files: index.files });
  writeJsonAtomic(path.join(root, 'modules.json'), { revision: index.meta.revision, modules: index.modules, hotspots: index.hotspots });
  writeJsonAtomic(path.join(root, 'symbols.json'), { revision: index.meta.revision, symbols: index.symbols });
  writeJsonAtomic(path.join(root, 'tests.json'), { revision: index.meta.revision, tests: index.tests, byStem: index.byStem });
}

// Fully deterministic for a fixed (repo revision, generatedAt): no wall-clock
// reads beyond the caller-provided timestamp, no network, no LLM.
function buildIndex({ repoPath, outDir, generatedAt } = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Repository path not found: ${abs}`);
  if (!isGitRepo(abs)) throw new Error(`Not a git repository: ${abs}`);

  const revision = currentRevision(abs);
  if (!revision) throw new Error(`Repository has no HEAD revision: ${abs}`);

  const tracked = git(abs, ['ls-files'], '').split('\n').filter(Boolean);
  const files = tracked.map((rel) => readFileSummary(abs, rel));

  const symbols = [];
  const languages = {};
  for (const file of files) {
    languages[file.language] = (languages[file.language] || 0) + 1;
    for (const s of file.symbols) {
      symbols.push({ path: file.path, name: s.name, kind: s.kind, line: s.line, text: s.text });
    }
  }
  symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));

  const hotspots = collectHistoryHotspots(abs, tracked);
  const modules = summarizeModules(files, hotspots);
  const { tests, byStem } = buildTestIndex(files);

  const meta = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generator: GENERATOR,
    repository: repositoryIdentity(abs),
    revision,
    branch: git(abs, ['branch', '--show-current'], null) || null,
    dirty: Boolean(git(abs, ['status', '--porcelain'], '')),
    generatedAt: generatedAt || new Date().toISOString(),
    fileCount: files.length,
    symbolCount: symbols.length,
    testCount: tests.length,
    languages: sortLanguages(languages),
    host: os.hostname(),
  };

  const index = {
    root: outDir ? path.resolve(outDir) : indexRoot(abs),
    meta,
    files,
    modules,
    hotspots,
    symbols,
    tests,
    byStem,
  };
  writeIndex(index.root, index);
  return index;
}

module.exports = {
  buildIndex,
  writeIndex,
  repositoryIdentity,
  currentRevision,
  isGitRepo,
  isTestFile,
  testStem,
};
