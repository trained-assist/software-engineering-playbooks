'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_RESULTS = 24;
const STOP = new Set(['the','and','for','with','from','into','that','this','your','you','are','как','что','для','это','или','надо','нужно','сделать','делать','там','вот','тоже','уже','будет','будут','при','про','под']);

function run(cmd, args, cwd, fallback = '') {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], maxBuffer: 20 * 1024 * 1024 }).trim(); }
  catch { return fallback; }
}

function isGitRepo(repoPath) {
  return run('git', ['rev-parse', '--is-inside-work-tree'], repoPath, '') === 'true';
}

function repoState(repoPath) {
  if (!isGitRepo(repoPath)) return { git: false, head: null, branch: null, dirty: false };
  return {
    git: true,
    head: run('git', ['rev-parse', 'HEAD'], repoPath, null),
    branch: run('git', ['branch', '--show-current'], repoPath, null),
    dirty: Boolean(run('git', ['status', '--porcelain'], repoPath, '')),
  };
}

function taskTerms(task) {
  const words = String(task || '').toLowerCase().match(/[a-zа-яё0-9_./-]{3,}/gi) || [];
  return [...new Set(words.filter(w => !STOP.has(w) && !/^https?:/.test(w)))].slice(0, 18);
}

function keywordTerms(keywords) {
  const list = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).map(String).join(' ');
  const words = list.toLowerCase().match(/[a-zа-яё0-9_./-]{2,}/gi) || [];
  return [...new Set(words.filter(w => !STOP.has(w) && !/^https?:/.test(w)))].slice(0, 24);
}

function termsFrom({ task, keywords } = {}) {
  const hasKeywords = keywords !== undefined && keywords !== null
    && (Array.isArray(keywords) ? keywords.length > 0 : String(keywords).trim().length > 0);
  return hasKeywords ? keywordTerms(keywords) : taskTerms(task);
}

function listFiles(repoPath) {
  if (isGitRepo(repoPath)) {
    const tracked = run('git', ['ls-files'], repoPath, '');
    if (tracked) return tracked.split('\n').filter(Boolean);
  }
  const out = [];
  const ignored = new Set(['.git','node_modules','.next','dist','build','coverage','vendor']);
  function walk(dir, rel = '') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(ent.name)) continue;
      const nextRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), nextRel);
      else if (ent.isFile()) out.push(nextRel.split(path.sep).join('/'));
      if (out.length > 25000) return;
    }
  }
  walk(repoPath);
  return out;
}

function scoreFile(file, terms) {
  const low = file.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (low === t) score += 8;
    else if (low.includes(t)) score += 3;
    const base = path.basename(low);
    if (base.includes(t)) score += 2;
  }
  if (/readme|architecture|design|spec|adr|requirements/.test(low)) score += 1;
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/.test(low)) score += 1;
  return score;
}

function filenameMatches(files, terms, maxResults) {
  return files.map(file => ({ file, score: scoreFile(file, terms) }))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxResults);
}

function grepMatches(repoPath, terms, maxResults) {
  const results = [];
  for (const term of terms.slice(0, 8)) {
    const raw = run('git', ['grep', '-n', '-I', '--', term], repoPath, '');
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const first = line.indexOf(':');
      const second = first >= 0 ? line.indexOf(':', first + 1) : -1;
      if (first < 0 || second < 0) continue;
      results.push({
        term,
        file: line.slice(0, first),
        line: Number(line.slice(first + 1, second)) || null,
        excerpt: line.slice(second + 1).trim().slice(0, 220),
      });
      if (results.length >= maxResults * 3) break;
    }
    if (results.length >= maxResults * 3) break;
  }
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxResults);
}

function relatedTests(files, likelyFiles, maxResults = 20) {
  const stems = new Set(likelyFiles.map(x => path.basename(x.file).replace(/\.[^.]+$/, '').toLowerCase()));
  return files.filter(f => {
    const low = f.toLowerCase();
    if (!/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/.test(low)) return false;
    if (!stems.size) return true;
    return [...stems].some(s => s.length >= 4 && low.includes(s));
  }).slice(0, maxResults);
}

function relatedDocs(files, terms, maxResults = 16) {
  return files
    .map(file => {
      const low = file.toLowerCase();
      if (!(/(^|\/)(docs?|specs?|adr)(\/|$)/.test(low) || /readme|architecture|design|spec/.test(low))) return null;
      return { file, score: scoreFile(file, terms) + 1 };
    })
    .filter(Boolean)
    .sort((a,b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxResults)
    .map(x => x.file);
}

function recentHistory(repoPath, terms, maxResults = 12) {
  if (!isGitRepo(repoPath)) return [];
  const log = run('git', ['log', '-n', '80', '--pretty=format:%h\t%s'], repoPath, '');
  const rows = log.split('\n').filter(Boolean).map(line => {
    const [sha, ...rest] = line.split('\t');
    return { sha, subject: rest.join('\t') };
  });
  const scored = rows.map(r => ({
    ...r,
    score: terms.reduce((n,t) => n + (r.subject.toLowerCase().includes(t) ? 1 : 0), 0),
  }));
  const related = scored.filter(x => x.score > 0).sort((a,b) => b.score - a.score);
  return (related.length ? related : scored).slice(0, maxResults).map(({score,...r}) => r);
}

function discoverRawContext({ repoPath, task, maxResults = DEFAULT_MAX_RESULTS }) {
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Repository path not found: ${abs}`);
  const terms = taskTerms(task);
  const files = listFiles(abs);
  const likelyFiles = filenameMatches(files, terms, maxResults);
  const grep = grepMatches(abs, terms, maxResults);
  const merged = new Map(likelyFiles.map(x => [x.file, x]));
  for (const hit of grep) {
    const prev = merged.get(hit.file) || { file: hit.file, score: 0 };
    prev.score += 3;
    merged.set(hit.file, prev);
  }
  const ranked = [...merged.values()].sort((a,b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, maxResults);

  return {
    source: 'raw-repo',
    terms,
    likelyFiles: ranked,
    grepMatches: grep,
    relatedTests: relatedTests(files, ranked),
    relatedDocs: relatedDocs(files, terms),
    recentHistory: recentHistory(abs, terms),
    fileCount: files.length,
  };
}

module.exports = { discoverRawContext, taskTerms, keywordTerms, termsFrom, scoreFile, repoState };
