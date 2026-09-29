#!/usr/bin/env node
// Sandbox loop for «прогон тестов в облаке»: ci-setup + ci-run (plan 3e40a139).
// One command, deterministic PASS/FAIL. Walks the scenario steps of
// docs/user-scenarios/ci/cloud-test-run.md through the REAL functional blocks
// of this repo, with a fake GitHub API (fetch stub, hermetic — no network,
// no token needed).
//
// Scenario coverage:
//   С1 (ci-setup, static contract of the executable parts):
//     templates/ci.yml (workflow_dispatch + inputs.ref + concurrency, no
//     deploy/merge/continue-on-error); step types ci-setup/ci-run;
//     verify-local → ci_run_branch; playbooks-src/ci-setup.json (stages
//     analyze→change→explain, «уже настроено», open-pr/ci-green/merged) and
//     ci-run.json (ci_run_branch + task_item_wait + ci_run_green); built
//     catalog is fresh (npm run check:playbooks).
//   С2 (ci-run, dynamic — real handler against fake GitHub):
//     not configured → {ok:false, configured:false, hint: ci-setup};
//     dispatch → own run_id (dispatch ref = default branch, tested branch +
//     suite as inputs); success → green + duration + url;
//     failure → conclusion failure + failed_jobs + log_tail with the failing
//     test; cancelled → explicit error; no token → no-github-token;
//     no merge/deploy/DELETE requests at all.
//   Core: ci_run_green validator in the trained-assist-agent checkout
//     (AGENT_REPO, default /home/vova/trained-assist-agent; explicit SKIP if
//     the checkout is absent — never turns the loop green).
//
// Run:  npm run test:sandbox:ci
// Level: S5 — full closed loop «changed → saw the result» locally in seconds
// (target cycle ≤30s; the dispatch poll is the only slow part). Real-repo
// acceptance (S4) stays in plan §5 smokes, outside this loop.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const t0 = Date.now();
let pass = 0, fail = 0, skip = 0;
const ok = (cond, msg) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`);
};
const skipped = msg => { skip++; console.log(`  SKIP ${msg}`); };
const section = name => console.log(`\n== ${name}`);
const fmt = v => { try { return JSON.stringify(v); } catch { return String(v); } };

// Real token may exist on this machine — the sandbox must never touch it.
process.env.GH_TOKEN = 'sandbox-token';
delete process.env.GITHUB_TOKEN;

/* ------------------------------------------------------------------ С1静态 */

section('С1: шаблон templates/ci.yml');
const tplPath = path.join(REPO, 'templates', 'ci.yml');
if (!fs.existsSync(tplPath)) {
  ok(false, 'templates/ci.yml существует (шаблон для репо без CI)');
} else {
  const tpl = fs.readFileSync(tplPath, 'utf8');
  ok(true, 'templates/ci.yml существует');
  ok(/workflow_dispatch/.test(tpl), 'workflow_dispatch объявлен');
  ok(/inputs:/.test(tpl) && /^\s+ref:/m.test(tpl), 'input ref есть');
  ok(/concurrency:/.test(tpl), 'concurrency объявлен');
  ok(!/continue-on-error/i.test(tpl), 'нет continue-on-error (красный ≠ пропуск)');
  ok(!/\bdeploy\b/i.test(tpl) && !/\bmerge\b/i.test(tpl), 'нет шагов деплоя/мержа');
}

section('С1: типы шагов (library/step-types.json)');
const lib = require(path.join(REPO, 'library', 'step-types.json'));
for (const id of ['ci-setup', 'ci-run']) {
  const t = lib.types[id];
  ok(!!t, `тип шага «${id}» объявлен`);
  if (t) {
    ok(Array.isArray(t.substeps) && t.substeps.length > 0, `«${id}»: substeps непустые`);
    ok(!!t.done_when, `«${id}»: done_when задан`);
    ok(t.validation && Object.keys(t.validation).length > 0, `«${id}»: validation задан`);
  }
}
{
  const vl = JSON.stringify(lib.types['verify-local'] || {});
  ok(/ci_run_branch/.test(vl), 'verify-local ссылается на ci_run_branch (полный набор — в облаке)');
}

section('С1: плейбуки ci-setup / ci-run');
const loadPbSrc = id => {
  const p = path.join(REPO, 'playbooks-src', `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const usesOf = pb => {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.use === 'string') out.push(n.use);
    Object.values(n).forEach(walk);
  })(pb && pb.stages);
  return out;
};
{
  const pb = loadPbSrc('ci-setup');
  ok(!!pb, 'playbooks-src/ci-setup.json существует');
  if (pb) {
    const ids = (pb.stages || []).map(s => s.id);
    ok(['analyze', 'change', 'explain'].every(s => ids.includes(s)),
      `ci-setup: стадии analyze→change→explain (got: ${ids.join(',')})`);
    const uses = usesOf(pb);
    for (const u of ['open-pr', 'ci-green', 'merged']) {
      ok(uses.includes(u), `ci-setup: штатный шаг «${u}»`);
    }
    const txt = JSON.stringify(pb);
    ok(/уже настроено/.test(txt), 'ci-setup: контракт идемпотентности «уже настроено»');
    ok(/workflow_dispatch/.test(txt), 'ci-setup: речь про workflow_dispatch');
  }
}
{
  const pb = loadPbSrc('ci-run');
  ok(!!pb, 'playbooks-src/ci-run.json существует');
  if (pb) {
    const uses = usesOf(pb);
    ok(uses.includes('ci-run'), 'ci-run: шаг типа ci-run');
    const txt = JSON.stringify(pb);
    ok(/ci_run_branch/.test(txt), 'ci-run: вызывает MCP-тул ci_run_branch');
    ok(/task_item_wait/.test(txt), 'ci-run: durable-ожидание task_item_wait');
    ok(/ci_run_green/.test(txt), 'ci-run: until {ci_run_green: …}');
  }
}

section('С1: сборка каталога плейбуков актуальна');
{
  const r = spawnSync('npm', ['run', 'check:playbooks'], { cwd: REPO, encoding: 'utf8' });
  ok(r.status === 0, `npm run check:playbooks exit 0 (got ${r.status}); ${((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop()}`);
}

/* ------------------------------------------------------------------ С2动态 */

section('С2: MCP-тул ci_run_branch против фейкового GitHub API');

// Fake GitHub: stateful fetch stub. Contract source: docs/ci-cloud-run.md §2.3.
function makeGitHub(cfg) {
  const dispatched = [];
  const requests = [];
  const runs = cfg.runs || {};
  const fakeFetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const base = 'https://api.github.com';
    const apiPath = u.startsWith(base) ? u.slice(base.length) : u;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* non-JSON */ }
    requests.push({ method, path: apiPath, body });
    const res = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });

    if (method === 'POST' && /\/actions\/workflows\/\d+\/dispatches$/.test(apiPath.split('?')[0])) {
      dispatched.push({ path: apiPath, body });
      // Own run becomes visible "after dispatch": future timestamp so any
      // "created_at > t_dispatch" filter (taken before or after POST) keeps it.
      const own = runs[cfg.dispatchRunId];
      if (own) own.created_at = new Date(Date.now() + 1000).toISOString();
      return res(204, null);
    }
    if (method === 'GET' && /\/actions\/jobs\/\d+\/logs/.test(apiPath)) {
      return res(200, cfg.logText || 'no log');
    }
    if (method === 'GET' && /\/actions\/runs\/\d+\/jobs/.test(apiPath)) {
      const id = apiPath.match(/runs\/(\d+)\/jobs/)[1];
      return res(200, { total_count: 1, jobs: (cfg.jobsByRun && cfg.jobsByRun[id]) || [] });
    }
    if (method === 'GET' && /\/actions\/runs\/\d+(\?|$)/.test(apiPath)) {
      const id = Number(apiPath.match(/runs\/(\d+)/)[1]);
      if (!runs[id]) return res(404, { message: 'Not Found' });
      return res(200, runs[id]);
    }
    if (method === 'GET' && /\/actions\/workflows\/\d+\/runs/.test(apiPath)) {
      const list = dispatched.length
        ? Object.values(runs).filter(r => r.event === 'workflow_dispatch')
        : [];
      return res(200, { total_count: list.length, workflow_runs: list });
    }
    if (method === 'GET' && /\/actions\/workflows(\?|$)/.test(apiPath)) {
      return res(200, { total_count: (cfg.workflows || []).length, workflows: cfg.workflows || [] });
    }
    // A real contents URL is /repos/{owner}/{repo}/contents/{path} — match the
    // marker anywhere in the path, not only at the start (a `startsWith` guard
    // could never fire for a valid GitHub contents request).
    if (method === 'GET' && apiPath.includes('/contents/')) {
      const rest = apiPath.slice(apiPath.indexOf('/contents/') + '/contents/'.length).split('?')[0].replace(/\/$/, '');
      const files = cfg.files || {};
      if (rest === '.github/workflows') {
        return res(200, Object.keys(files).map(name => ({
          name, path: `.github/workflows/${name}`, type: 'file',
        })));
      }
      const name = rest.split('/').pop();
      if (files[name] != null) {
        return res(200, {
          name, path: rest, type: 'file', encoding: 'base64',
          content: Buffer.from(files[name]).toString('base64'),
        });
      }
      return res(404, { message: 'Not Found' });
    }
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/?]+(\?|$)/.test(apiPath)) {
      return res(200, { default_branch: cfg.defaultBranch || 'main', full_name: 'owner/repo' });
    }
    return res(404, { message: `sandbox: no route ${method} ${apiPath}` });
  };
  fakeFetch.dispatched = dispatched;
  fakeFetch.requests = requests;
  return fakeFetch;
}

const MANUAL_YML = [
  'name: manual-tests',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      ref: {type: string, default: main}',
  '      suite: {type: choice, options: [unit, scenario, staging, all]}',
  'concurrency:',
  '  group: manual-tests-${{ inputs.ref }}',
  '  cancel-in-progress: true',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with: {ref: "${{ inputs.ref }}"}',
  '      - run: npm ci && npm test',
].join('\n');

const WFS = [{ id: 42, name: 'manual-tests', path: '.github/workflows/manual-tests.yml', state: 'active' }];
const run = (id, conclusion) => ({
  id, name: 'manual-tests', event: 'workflow_dispatch', head_branch: 'feature/x',
  status: 'completed', conclusion,
  run_started_at: '2026-09-29T04:00:00Z',
  updated_at: '2026-09-29T04:01:30Z',
  html_url: `https://github.com/owner/repo/actions/runs/${id}`,
  created_at: '2026-09-29T04:00:00Z',
});

const realFetch = globalThis.fetch;
let tool = null;

try {
  let mod = null;
  try {
    mod = require(path.join(REPO, 'src', 'mcp-skills', 'tools', '63-ci-cd.js'));
    ok(true, 'модуль 63-ci-cd.js загружается');
  } catch (e) {
    ok(false, `модуль 63-ci-cd.js загружается: ${e.message}`);
  }
  tool = mod && mod.tools && mod.tools.ci_run_branch;
  ok(!!tool && typeof tool.handler === 'function', 'tools.ci_run_branch объявлен с handler');
  if (tool) {
    try {
      const registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry.js'));
      const names = registry.listAllTools().map(t => t.name);
      ok(names.includes('ci_run_branch'), 'тул зарегистрирован в реестре engineering-skills');
    } catch (e) {
      ok(false, `реестр читается: ${e.message}`);
    }
  }

  if (!tool) {
    ok(false, 'С2.2: «не настроено» + hint ci-setup (тул не реализован)');
    ok(false, 'С2.3: dispatch → свой run_id, ветка/suite входами (тул не реализован)');
    ok(false, 'С2.5: зелёный прогон → success + duration + url (тул не реализован)');
    ok(false, 'С2.6: красный → failed_jobs + log_tail с упавшим тестом (тул не реализован)');
    ok(false, 'С2.7: cancelled → явная ошибка (тул не реализован)');
    ok(false, 'нет merge/deploy/DELETE-запросов (тул не реализован)');
    ok(false, 'нет токена → no-github-token (тул не реализован)');
  } else {
    const h = args => tool.handler(args);

    // С2.2 — not configured
    const g1 = makeGitHub({ workflows: [], files: {} });
    globalThis.fetch = g1;
    const r1 = await h({ repo: 'owner/repo', ref: 'feature/x' });
    ok(r1 && r1.ok === false && r1.configured === false,
      `С2.2: не настроено → ok:false, configured:false (got ${fmt(r1)})`);
    ok(/ci-setup/.test(String((r1 && r1.hint) || '')),
      `С2.2: hint предлагает запустить ci-setup (got ${fmt(r1 && r1.hint)})`);

    // С2.3/2.5/2.6/2.7 — configured repo
    const g2 = makeGitHub({
      workflows: WFS,
      files: { 'manual-tests.yml': MANUAL_YML },
      runs: { 777: run(777, 'success'), 888: run(888, 'failure'), 999: run(999, 'cancelled') },
      dispatchRunId: 777,
      jobsByRun: { 888: [{ id: 5, name: 'test (unit)', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/888/job/5' }] },
      logText: 'ok 1\ntests/broken.test.js\nFAIL tests/broken.test.js — expected 1 === 2\n1 failed, 12 passed',
    });
    globalThis.fetch = g2;

    const d = await h({ repo: 'owner/repo', ref: 'feature/x', suite: 'unit' });
    ok(d && d.ok === true && d.run_id === 777,
      `С2.3: dispatch → run_id 777 (got ${fmt(d)})`);
    const post = g2.dispatched[0];
    ok(!!post && post.body && post.body.ref === 'main',
      `С2.3: диспатч идёт с дефолтной ветки (got ${fmt(post && post.body && post.body.ref)})`);
    ok(!!post && post.body && post.body.inputs && post.body.inputs.ref === 'feature/x',
      'С2.3: тестируемая ветка — input ref');
    ok(!!post && post.body && post.body.inputs && post.body.inputs.suite === 'unit',
      'С2.3: suite пробрасывается');

    const s = await h({ repo: 'owner/repo', run_id: 777 });
    ok(s && s.ok === true && s.status === 'completed' && s.conclusion === 'success',
      `С2.5: зелёный → success (got ${fmt(s)})`);
    ok(s && s.duration !== undefined && s.duration !== null, 'С2.5: duration в ответе');
    ok(s && typeof s.url === 'string' && /runs\/777/.test(s.url),
      `С2.5: url рана (got ${fmt(s && s.url)})`);

    const f = await h({ repo: 'owner/repo', run_id: 888 });
    ok(f && f.ok === true && f.conclusion === 'failure',
      `С2.6: красный → conclusion failure (got ${fmt(f)})`);
    ok(f && Array.isArray(f.failed_jobs) && f.failed_jobs.length > 0,
      `С2.6: failed_jobs перечислены (got ${fmt(f && f.failed_jobs)})`);
    ok(f && /FAIL tests\/broken\.test\.js/.test(String(f.log_tail || '')),
      `С2.6: log_tail содержит упавший тест (got ${String((f && f.log_tail) || '').slice(0, 80)})`);

    const c = await h({ repo: 'owner/repo', run_id: 999 });
    ok(c && c.ok === false && /cancel/i.test(String(c.error || '')),
      `С2.7: cancelled → явная ошибка (got ${fmt(c)})`);

    const bad = g2.requests.filter(r =>
      r.method === 'DELETE' || /\/merges?(\/|$)|deploy/i.test(r.path));
    ok(bad.length === 0,
      `только чтение/диспатч — нет merge/deploy/DELETE (bad: ${bad.map(b => `${b.method} ${b.path}`).join('; ') || 'нет'})`);

    // No token → explicit error, checked before any API call.
    const saved = { GH_TOKEN: process.env.GH_TOKEN, USER_ID: process.env.USER_ID };
    delete process.env.GH_TOKEN;
    delete process.env.USER_ID;
    let nt;
    try {
      nt = await h({ repo: 'owner/repo', ref: 'feature/x' });
    } catch (e) {
      nt = { ok: false, error: e.message };
    } finally {
      if (saved.GH_TOKEN !== undefined) process.env.GH_TOKEN = saved.GH_TOKEN;
      if (saved.USER_ID !== undefined) process.env.USER_ID = saved.USER_ID;
    }
    ok(nt && nt.ok === false && /no-github-token/.test(String(nt.error || '')),
      `нет токена → {ok:false, error:"no-github-token"} (got ${fmt(nt)})`);
  }
} finally {
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------- ядро (другой репо) */

section('Ядро: валидатор ci_run_green (trained-assist-agent, PR-A)');
const agentRepo = process.env.AGENT_REPO || '/home/vova/trained-assist-agent';
const pv = path.join(agentRepo, 'src', 'playbook-validators.js');
if (!fs.existsSync(pv)) {
  skipped(`чекаут trained-assist-agent не найден по ${agentRepo} — задай AGENT_REPO=<путь> (валидатор живёт в ядре)`);
} else {
  const src = fs.readFileSync(pv, 'utf8');
  ok(/ci_run_green/.test(src), 'ci_run_green объявлен в src/playbook-validators.js');
  const tp = path.join(agentRepo, 'tests', 'unit', 'playbook-validators.test.js');
  ok(fs.existsSync(tp) && /ci_run_green/.test(fs.readFileSync(tp, 'utf8')),
    'unit-тест упоминает ci_run_green');
}

/* ------------------------------------------------------------------ summary */

const ms = Date.now() - t0;
console.log(`\nИтог: ${pass} ok, ${fail} fail, ${skip} skip — ${(ms / 1000).toFixed(1)} s`);
console.log(fail === 0 ? 'SANDBOX: PASS' : 'SANDBOX: FAIL');
process.exit(fail ? 1 : 0);
