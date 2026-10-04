#!/usr/bin/env node
'use strict';

// Benchmark for engineering_repo_search (#110): the number the engine/model
// choice is decided on, run against a REAL repository checkout.
//
//   node scripts/bench-repo-search.mjs --repo <path>            # measure
//   node scripts/bench-repo-search.mjs --repo <path> --integrity # check labels
//   node scripts/bench-repo-search.mjs --repo <path> --strategies keyword,dense,hybrid,auto,current
//
// Strategies: keyword / dense / hybrid from src/repo-search, plus `current` =
// the production engineering_repo_context ranking (file-level), i.e. what the
// codebase actually does today.
//
// Metrics: recall@5 (per class), MRR@10, absent-class empty-answer rate,
// median latency per query, embedding tokens spent (dense/hybrid share the
// same cache — the second strategy pays nothing).

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DATASET, CLASSES } = require('../bench/repo-search/dataset.js');
const { repoSearch } = require('../src/repo-search/search.js');
const { repoContext } = require('../src/context-sources/repo-context.js');
const { currentRevision } = require('../src/index/build.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function parseArgs(argv) {
  const out = { strategies: 'keyword,dense,hybrid,auto,current' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function grepRepo(repo, token) {
  const res = spawnSync('grep', ['-riIl', '--exclude-dir=.git', '--exclude-dir=node_modules', token, repo], { encoding: 'utf8' });
  if (res.error) throw res.error;
  const files = String(res.stdout || '').split('\n').filter(Boolean);
  return files.filter((f) => !f.includes('.engineering/index') && !f.includes('/bench/'));
}

function integrity(repo) {
  const problems = [];
  for (const q of DATASET) {
    for (const exp of q.expect || []) {
      const abs = path.join(repo, exp.path);
      if (!fs.existsSync(abs)) { problems.push(`${q.id}: expected file missing: ${exp.path}`); continue; }
      if (exp.contains && !fs.readFileSync(abs, 'utf8').includes(exp.contains)) {
        problems.push(`${q.id}: token "${exp.contains}" not found in ${exp.path}`);
      }
    }
    if (q.expectNoMatch && q.absent_token) {
      const hits = grepRepo(repo, q.absent_token);
      if (hits.length) problems.push(`${q.id}: absent_token "${q.absent_token}" is present in: ${hits.slice(0, 5).join(', ')}`);
    }
  }
  const ids = new Set();
  for (const q of DATASET) {
    if (ids.has(q.id)) problems.push(`duplicate id: ${q.id}`);
    ids.add(q.id);
    if (!CLASSES.includes(q.cls)) problems.push(`${q.id}: unknown class ${q.cls}`);
  }
  if (DATASET.length < 30 || DATASET.length > 50) problems.push(`dataset size ${DATASET.length} outside 30–50`);
  return problems;
}

function hitsOf(result, limit = 5) {
  return (result.hits || result.likelyFiles || []).slice(0, limit);
}

function recallAtK(result, query, k = 5) {
  const top = hitsOf(result, k).map((h) => h.path || h.file);
  const expected = query.expect || [];
  if (query.expectNoMatch) return null;
  if (!expected.length) return null;
  const got = new Set(top);
  const hit = expected.filter((e) => got.has(e.path)).length;
  return hit / expected.length;
}

function mrrAtK(result, query, k = 10) {
  if (query.expectNoMatch) return null;
  const top = hitsOf(result, k).map((h) => h.path || h.file);
  const expected = (query.expect || []).map((e) => e.path);
  for (let i = 0; i < top.length; i++) if (expected.includes(top[i])) return 1 / (i + 1);
  return 0;
}

function emptyAnswer(result) {
  return hitsOf(result, 5).length === 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo || process.env.BENCH_REPO || '/home/vova/trained-assist-agent');
  if (!fs.existsSync(repo)) { console.error(`repo not found: ${repo}`); process.exit(2); }

  if (args.integrity) {
    const problems = integrity(repo);
    if (problems.length) {
      console.error(`integrity FAILED (${problems.length}):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`integrity OK: ${DATASET.length} queries, labels verified against ${repo}`);
    return;
  }

  // The index must exist — repo_search reads it, never crawls a second time.
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'index-repo.js'), '--repo', repo, '--check', '--json'], { encoding: 'utf8' });
  let usable = false;
  try { usable = Boolean(JSON.parse(check.stdout).usable); } catch { usable = false; }
  if (!usable) {
    console.error('index not usable — building…');
    const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'index-repo.js'), '--repo', repo, '--json'], { encoding: 'utf8' });
    if (build.status !== 0) { console.error(build.stderr || build.stdout); process.exit(1); }
  }

  const strategies = String(args.strategies).split(',').map((s) => s.trim()).filter(Boolean);
  const sha = currentRevision(repo);
  const perStrategy = new Map();
  const embeddingTokens = new Map();

  for (const strategy of strategies) {
    const rows = [];
    for (const query of DATASET) {
      const started = Date.now();
      let result;
      if (strategy === 'current') {
        const raw = repoContext({ repoPath: repo, keywords: query.query, maxResults: 5 });
        result = { hits: (raw.entries || []).slice(0, 5).map((e) => ({ path: e.path || e.file })) };
      } else {
        result = await repoSearch({ repo_path: repo, query: query.query, strategy, limit: 10 });
        const t = result.dense && result.dense.stats && result.dense.stats.tokensApprox;
        if (t) embeddingTokens.set(strategy, (embeddingTokens.get(strategy) || 0) + t);
        if (strategy === 'keyword' || strategy === 'hybrid') {
          embeddingTokens.set('hybrid-shared', Math.max(embeddingTokens.get('hybrid-shared') || 0, 0));
        }
      }
      rows.push({ id: query.id, cls: query.cls, ms: Date.now() - started, result });
    }
    perStrategy.set(strategy, rows);
  }

  const summary = {};
  for (const [strategy, rows] of perStrategy) {
    const byClass = {};
    for (const cls of CLASSES) {
      const clsRows = rows.filter((r) => r.cls === cls);
      const recalls = clsRows.map((r) => recallAtK(r.result, DATASET.find((q) => q.id === r.id), 5)).filter((v) => v !== null);
      const mrrs = clsRows.map((r) => mrrAtK(r.result, DATASET.find((q) => q.id === r.id), 10)).filter((v) => v !== null);
      byClass[cls] = {
        n: clsRows.length,
        recall5: recalls.length ? Number((recalls.reduce((a, b) => a + b, 0) / recalls.length).toFixed(3)) : null,
        mrr10: mrrs.length ? Number((mrrs.reduce((a, b) => a + b, 0) / mrrs.length).toFixed(3)) : null,
        empty5: clsRows.length ? Number((clsRows.filter((r) => emptyAnswer(r.result)).length / clsRows.length).toFixed(3)) : null,
      };
    }
    const present = rows.filter((r) => !DATASET.find((q) => q.id === r.id).expectNoMatch);
    summary[strategy] = {
      byClass,
      overallRecall5: Number((present.map((r) => recallAtK(r.result, DATASET.find((q) => q.id === r.id), 5)).reduce((a, b) => a + (b || 0), 0) / Math.max(1, present.length)).toFixed(3)),
      latencyMsMedian: median(rows.map((r) => r.ms)),
      embeddingTokens: embeddingTokens.get(strategy) || 0,
    };
  }

  const report = {
    bench: 'engineering_repo_search',
    datasetSize: DATASET.length,
    repo,
    revision: sha,
    createdAt: new Date().toISOString(),
    strategies,
    summary,
    rows: Object.fromEntries([...perStrategy].map(([k, rows]) => [k, rows.map((r) => ({
      id: r.id,
      cls: r.cls,
      ms: r.ms,
      recall5: recallAtK(r.result, DATASET.find((q) => q.id === r.id), 5),
      mrr10: mrrAtK(r.result, DATASET.find((q) => q.id === r.id), 10),
      empty5: emptyAnswer(r.result),
      top: hitsOf(r.result, 5).map((h) => h.path || h.file),
      strategy: r.result.strategy,
      degraded: r.result.degraded || null,
    }))])),
  };

  const outFile = path.join(ROOT, 'bench', 'repo-search', `results-${String(sha || 'nosh').slice(0, 8)}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  const header = ['strategy', 'overall r@5', 'exact r@5', 'ru_en r@5', 'behavior r@5', 'absent empty@5', 'exact mrr', 'median ms'];
  const lines = [header.join('\t')];
  for (const [strategy, s] of Object.entries(summary)) {
    lines.push([
      strategy,
      s.overallRecall5,
      s.byClass.exact.recall5,
      s.byClass.ru_en.recall5,
      s.byClass.behavior.recall5,
      s.byClass.absent.empty5,
      s.byClass.exact.mrr10,
      s.latencyMsMedian,
    ].join('\t'));
  }
  console.log(lines.join('\n'));
  console.log(`\nembedding tokens: ${JSON.stringify(Object.fromEntries(embeddingTokens))}`);
  console.log(`report: ${outFile}`);
}

run().catch((e) => { console.error(e); process.exit(1); });