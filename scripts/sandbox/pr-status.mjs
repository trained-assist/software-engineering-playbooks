#!/usr/bin/env node
// Песочница pr_status / issue_status (#52, план a738d291) — одна команда,
// детерминированный pass/fail. Сценарий: docs/user-scenarios/engineering/
// pr-issue-status.md, шаги 1–6 + крайние случаи; дизайн: ...-design.md.
//
// Layer A (≈1–3 с): эфемерный локальный сервер-заглушка GitHub API
//   (tests/fixtures/github/pr-status.js) + герметичный fetch-guard: любой
//   запрос наружу вне фикстур — отказ. Через РЕАЛЬНЫЙ реестр MCP идут вызовы
//   pr_status / issue_status / github_pr_checks — то есть настоящие
//   обработчики тулов, а не копия логики. Замкнутый цикл «изменил → увидел».
// Layer B (≈20–60 с): живой слой на реальном GitHub API токеном сессии:
//   смерженный PR agent#1843, красный PR (agent#1832 + поиск по открытым),
//   issue agent#1725 с PR в ≥2 репо, типизированные ошибки (NOT_FOUND,
//   NOT_A_PR) и поведение алиаса на живых данных.
//
// Запуск:
//   npm run test:sandbox:pr              оба слоя (цель S5 + живая приёмка)
//   npm run test:sandbox:pr -- --fast    только Layer A (~1–3 с)
//   SANDBOX_LIVE=0 npm run test:sandbox:pr   то же, что --fast
//
// Уровень: S5 — скрипт сам поднимает эфемерную среду (сервер-заглушка,
// временной HOME) и гоняет сценарий end-to-end за секунды на фейках; живой
// Layer B добавляет реальные зависимости (реальный GitHub — S4-приёмка).
// Доказательство падения по правильной причине: фикстуры/SC1–SC4 зелёные,
// фича отсутствует в реестре → «ФИЧА ЕЩЁ НЕ РЕАЛИЗОВАНА» + RESULT: FAIL.
//
// Контракт аргументов (фиксирует схему до среза S6):
//   pr_status({repo, pr_number, include_logs?, head_sha?})
//   issue_status({repo, issue_number, include_logs?, max_prs?}) — имя
//   issue_number согласовано с github_pr_checks/pr_number в неймспейсе github_*.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ORIGINAL_FETCH = globalThis.fetch;

const FAST = process.argv.includes('--fast') || process.env.SANDBOX_LIVE === '0';
const ENV0 = {
  GH_TOKEN: process.env.GH_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  AGENT_PUBLIC_URL: process.env.AGENT_PUBLIC_URL,
};
const FAKE_TOKEN = 'sandbox-fake-token';
const EXPECTED_TOOLS = ['pr_status', 'issue_status'];

const failures = [];
let featureOk = false;
let server = null;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-sandbox-'));

const log = (...a) => console.log('[sandbox]', ...a);
function check(cond, msg) {
  if (cond) console.log('   ok  -', msg);
  else { failures.push(msg); console.log('   FAIL-', msg); }
}

// ── Layer A: герметичная эфемерная среда ───────────────────────────────────

function installFetchGuard(port) {
  const local = `http://127.0.0.1:${port}`;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input
      : (input && typeof input.url === 'string') ? input.url
      : String(input);
    let u;
    try { u = new URL(raw); } catch { u = new URL(raw, 'https://api.github.com'); }
    if (u.origin === 'https://api.github.com') {
      return ORIGINAL_FETCH(local + u.pathname + u.search, init);
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      return ORIGINAL_FETCH(raw, init);
    }
    return Promise.reject(new Error(`[sandbox] сетевой вызов вне фикстур запрещён: ${u.origin}${u.pathname}`));
  };
}

function startFixtureServer(fixture) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('error', () => {});
      let r = null;
      try { r = fixture.resolve(req.method, `http://127.0.0.1${req.url}`); } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `fixture error: ${e.message}` }));
        return;
      }
      const status = r ? r.status : 404;
      const headers = { ...(r && r.headers) };
      if (status >= 300 && status < 400) { res.writeHead(status, headers); res.end(); return; }
      let body = r ? r.body : { message: 'Not Found' };
      if (typeof body === 'string') {
        headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8';
        body = Buffer.from(body);
      } else {
        headers['content-type'] = 'application/json';
        body = Buffer.from(JSON.stringify(body === undefined ? null : body));
      }
      headers['content-length'] = String(body.length);
      res.writeHead(status, headers);
      res.end(body);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function layerA(registry, fixture) {
  log('Layer A (эфемерная среда: локальная заглушка GitHub + герметичный fetch-guard)');
  const port = server.address().port;
  installFetchGuard(port);
  process.env.AGENT_PUBLIC_URL = `http://127.0.0.1:${port}/agent`;

  log('-- самопроверки петли (работают ДО фичи: отличают сломанную песочницу от отсутствующей фичи)');
  const raw = await globalThis.fetch('https://api.github.com/repos/trained-assist/X/pulls/42');
  const rawPr = await raw.json();
  check(raw.ok && rawPr.number === 42, 'SC1: фикстурный сервер отвечает через guarded fetch (PR42 прочитан)');

  const alias = await registry.callTool('github_pr_checks', { repo: 'trained-assist/X', pr_number: 42 });
  check(alias.ci && alias.ci.status === 'failure', `SC2: существующий github_pr_checks работает через петлю (ci=${alias.ci && alias.ci.status})`);
  check(alias.summary && alias.summary.total === 3, 'SC2: alias-контракт полей (summary.total=3)');
  check(Array.isArray(alias.check_runs) && alias.check_runs.length === 3, 'SC2: check_runs из фикстур (3)');

  let guardBlocked = false;
  try { await globalThis.fetch('https://example.com/leak'); } catch { guardBlocked = true; }
  check(guardBlocked, 'SC3: герметичность — вызов вне фикстур отклоняется');

  log('-- SC4: ключевые маршруты фикстур (сид сценария)');
  const probe = (p, init) => globalThis.fetch(`https://api.github.com${p}`, init);
  const p77 = await (await probe('/repos/trained-assist/X/pulls/77')).json();
  check(p77.merged === true && p77.merge_commit_sha === 'sha-merged', 'SC4: смерженный PR77 читается из фикстур');
  const pChecks = await (await probe('/repos/trained-assist/X/commits/sha-red/check-runs')).json();
  check(pChecks.total_count === 3 && pChecks.check_runs.some(r => r.name === 'ci'), 'SC4: красные чекраны sha-red (3)');
  const pLog = await probe('/repos/trained-assist/X/actions/jobs/22/logs');
  const pLogText = await pLog.text();
  check(pLog.ok && pLogText.includes('AssertionError'), 'SC4: 302-редирект лога джоба отдаёт сырой лог');
  const pExpired = await probe('/repos/trained-assist/X/actions/jobs/23/logs');
  check(pExpired.status === 410, `SC4: протухший лог → 410 (получено ${pExpired.status})`);
  const pList = await (await probe('/repos/trained-assist/X/pulls?state=all&per_page=50')).json();
  check(Array.isArray(pList) && pList.some(p => p.number === 43 && String(p.head.ref).startsWith('fix/ci-feature-red-change-')),
    'SC4: autofix-PR #43 лежит в списке PR репо X');
  const pHealth = await (await probe('/agent/health')).json();
  check(pHealth.commit === 'sha-merged', 'SC4: health-фикстура отдаёт commit для прод-compare');
  const pGql = await (await probe('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const pNodes = pGql && pGql.data && pGql.data.repository.issue.timelineItems.nodes;
  check(Array.isArray(pNodes) && pNodes.length === 6, `SC4: GraphQL timeline — 6 узлов (дубль, пустой source, cross-repo), получено ${pNodes && pNodes.length}`);
  const p404 = await probe('/repos/nope/nope/pulls/1');
  check(p404.status === 404, 'SC4: неизвестный путь → 404, как в GitHub');
  const p401 = await probe('/repos/auth-test/x/pulls/1');
  check(p401.status === 401, 'SC4: auth-test-репо → 401 Bad credentials');

  const all = registry.listAllTools().map(t => t.name);
  const listed = new Set(registry.listTools().map(t => t.name));
  const missing = EXPECTED_TOOLS.filter(n => !all.includes(n));
  if (missing.length) {
    console.log('');
    log('ФИЧА ЕЩЁ НЕ РЕАЛИЗОВАНА — цикл падает по правильной причине.');
    log('  сама песочница работает (SC1–SC4 зелёные), в реестре нет инструментов:');
    log('  ожидались:  ' + EXPECTED_TOOLS.join(', '));
    log('  не найдены: ' + missing.join(', '));
    log('  см. docs/user-scenarios/engineering/pr-issue-status-design.md, срезы S1–S6.');
    log('RESULT: FAIL');
    failures.push(`в реестре нет: ${missing.join(', ')}`);
    return;
  }
  const gated = EXPECTED_TOOLS.filter(n => !listed.has(n));
  check(gated.length === 0, `тулы регистрируются без гейта (gated: ${gated.join(',') || 'нет'})`);
  featureOk = gated.length === 0;

  const call = async (name, args) => {
    try { return await registry.callTool(name, args); }
    catch (e) {
      check(false, `${name}(${JSON.stringify(args)}) → исключение: ${e && e.message}`);
      return { ok: false, thrown: true, error: { code: 'THROWN', message: e && e.message } };
    }
  };
  const rawCall = (name, args) => registry.callTool(name, args);
  const j = o => JSON.stringify(o);

  // ── Шаг 1: открытый PR с упавшим CI ──
  log('-- Шаг 1: открытый PR с упавшим CI (X#42)');
  const s1 = await call('pr_status', { repo: 'trained-assist/X', pr_number: 42 });
  check(s1.ok === true, `pr_status: ok:true (получено ${j(s1.error || null)})`);
  check(s1.pr && s1.pr.state === 'open', `state: open (получено ${s1.pr && s1.pr.state})`);
  check(s1.pr && s1.pr.number === 42, 'номер PR в ответе');
  check(s1.ci && s1.ci.status === 'failure', `ci.status: failure (получено ${s1.ci && s1.ci.status})`);
  check(s1.ci && s1.ci.verdict === 'red', `ci.verdict: red (получено ${s1.ci && s1.ci.verdict})`);
  check(j(s1).includes('staging-gate'), 'staging-gate виден в сводке по head');
  const fj = Array.isArray(s1.failed_jobs) ? s1.failed_jobs : [];
  check(fj.length >= 1 && fj.length <= 3, `failed_jobs: 1..3 (получено ${fj.length})`);
  const withLog = fj.find(x => x.log_tail);
  const expired = fj.find(x => x.log_error === 'expired');
  check(!!withLog && !!withLog.name && !!withLog.url, 'упавший джоб: name + url');
  check(!!withLog && withLog.log_tail.length > 0 && withLog.log_tail.length < fixture.JOB_LOG_22.length / 4,
    `log_tail сжат (raw=${fixture.JOB_LOG_22.length}, got=${withLog && withLog.log_tail.length})`);
  check(!!withLog && /ERROR|AssertionError|Process completed/.test(withLog.log_tail), 'сжатый хвост сохраняет ошибку');
  check(!!expired, '410 лог → log_error:"expired", log_tail:null');
  check(!j(s1).includes(FAKE_TOKEN), 'ответ не содержит значения токена');

  // ── Шаг 2: autofix-PR ──
  log('-- Шаг 2: autofix-PR (найден для X#42, отсутствует для Y#78)');
  check(s1.autofix_pr && s1.autofix_pr.number === 43, `autofix_pr: X#43 (получено ${j(s1.autofix_pr)})`);
  check(s1.autofix_pr && !!s1.autofix_pr.url && !!s1.autofix_pr.state, 'autofix_pr: url + state');
  const s2 = await call('pr_status', { repo: 'trained-assist/Y', pr_number: 78 });
  check(s2.ok === true && !s2.autofix_pr, `без autofix → null (получено ${j(s2.autofix_pr)})`);

  // ── Шаг 3: смержен + прод ──
  log('-- Шаг 3: смержен + прод-вердикт (X#77 live, Y#78 not_yet, skill#5 никогда не live)');
  const s3 = await call('pr_status', { repo: 'trained-assist/X', pr_number: 77 });
  check(s3.ok === true, 'merged PR: ok:true');
  check(s3.pr && (s3.pr.merged === true || s3.pr.state === 'merged'), `merged:true (получено ${j(s3.pr)})`);
  check(j(s3).includes('sha-merged'), 'merge_commit_sha в ответе');
  check(s3.prod && s3.prod.verdict === 'live', `prod: live (получено ${j(s3.prod)})`);
  check(s3.prod && s3.prod.source === 'health-compare', `источник live — только health-compare (получено ${s3.prod && s3.prod.source})`);
  const s3b = await call('pr_status', { repo: 'trained-assist/Y', pr_number: 78 });
  check(s3b.prod && s3b.prod.verdict === 'not_yet', `отставший прод → not_yet (получено ${j(s3b.prod)})`);
  const s3c = await call('pr_status', { repo: 'trained-assist/skill', pr_number: 5 });
  check(s3c.prod && s3c.prod.verdict === 'unknown', `репо без health → unknown, не live (получено ${j(s3c.prod)})`);
  check(s3c.prod && /deploy/i.test(String(s3c.prod.evidence || '')), `evidence: deploy-green (получено ${s3c.prod && s3c.prod.evidence})`);
  check(!s1.prod, 'у открытого PR нет prod-блока');

  // ── Шаг 4: issue с PR в разных репо ──
  log('-- Шаг 4: issue_status — связанные PR, включая cross-repo (X#52)');
  const s4 = await call('issue_status', { repo: 'trained-assist/X', issue_number: 52 });
  check(s4.ok === true, `issue_status: ok:true (получено ${j(s4.error || null)})`);
  check(s4.issue && s4.issue.state === 'open' && !!s4.issue.title, `issue: state+title (получено ${j(s4.issue)})`);
  const prs = Array.isArray(s4.prs) ? s4.prs : [];
  const x42 = prs.filter(p => p.repo === 'trained-assist/X' && Number(p.number) === 42);
  check(x42.length === 1, `дедуп: X#42 ровно один раз (получено ${x42.length})`);
  const l4repos = new Set(prs.filter(p => !p.error).map(p => p.repo));
  check(l4repos.size >= 2, `связанные PR минимум из 2 репо (${[...l4repos].join(', ') || 'нет'})`);
  check(prs.some(p => p.error === 'no_access' && String(p.ref || '').includes('other-private')),
    `cross-repo PR без доступа → {ref, error:no_access} (получено ${j(prs.filter(p => p.error))})`);
  check(!j(s4).includes('log_tail'), 'issue_status компактный: без логов');

  // ── Шаг 5: алиас github_pr_checks ──
  log('-- Шаг 5: алиас github_pr_checks — надмножество полей, ошибки по-прежнему бросает');
  const al = await call('github_pr_checks', { repo: 'trained-assist/X', pr_number: 42 });
  check(al.ci && al.ci.status === 'failure', `алиас: ci.status=failure (получено ${j(al.ci)})`);
  check(al.summary && typeof al.summary.total === 'number' && Array.isArray(al.check_runs), 'алиас: summary + check_runs на месте');
  check(al.ci && s1.ci && al.ci.status === s1.ci.status, 'алиас и pr_status дают один ci.status (делегирование ядру)');
  let aliasThrew = false;
  try { await rawCall('github_pr_checks', { repo: 'trained-assist/X', pr_number: 404 }); } catch { aliasThrew = true; }
  check(aliasThrew, 'алиас продолжает БРОСАТЬ ошибку (прежнее поведение сохранено)');

  // ── Крайние случаи ──
  log('-- Крайние случаи: NOT_A_PR / NOT_FOUND / 401 без утечки токена');
  const e1 = await call('pr_status', { repo: 'trained-assist/X', pr_number: 52 });
  check(e1.ok === false && e1.error && e1.error.code === 'NOT_A_PR', `номер issue → NOT_A_PR (получено ${j(e1.error)})`);
  check(/issue_status/.test(String((e1.error && (e1.error.hint || e1.error.message)) || '')), 'NOT_A_PR: подсказка «используй issue_status»');
  const e2 = await call('pr_status', { repo: 'trained-assist/X', pr_number: 404 });
  check(e2.ok === false && e2.error && e2.error.code === 'NOT_FOUND', `несуществующий PR → NOT_FOUND (получено ${j(e2.error)})`);
  const e3 = await call('pr_status', { repo: 'auth-test/x', pr_number: 1 });
  check(e3.ok === false && e3.error && e3.error.code === 'GITHUB_AUTH', `401 → GITHUB_AUTH (получено ${j(e3.error)})`);
  check(!j(e3).includes(FAKE_TOKEN), 'ошибка авторизации не утекает токен');

  // ── Шаг 6: бюджет ответа ──
  log('-- Шаг 6: бюджет ответа (X#99: 60 прогонов, 5 падений)');
  const s6 = await call('pr_status', { repo: 'trained-assist/X', pr_number: 99 });
  check(s6.ok === true, 'budget PR: ok:true');
  check(s6.truncated === true, `truncated:true (получено ${j(s6.truncated)})`);
  const om = s6.truncated_omitted || {};
  check((om.check_runs || 0) > 0 || (om.failed_jobs || 0) > 0, `truncated_omitted со счётчиками (получено ${j(om)})`);
  check(Array.isArray(s6.check_runs) && s6.check_runs.length <= 20, `check_runs ≤20 (получено ${s6.check_runs && s6.check_runs.length})`);
  check(!Array.isArray(s6.failed_jobs) || s6.failed_jobs.length <= 3, `failed_jobs ≤3 (получено ${s6.failed_jobs && s6.failed_jobs.length})`);
  check(!Array.isArray(s6.failed_jobs) || s6.failed_jobs.every(x => !x.log_tail || x.log_tail.length <= 8000),
    'log_tail каждого джоба в пределах бюджета');
  check(j(s6).length <= 20000, `размер ответа ≤20k символов (получено ${j(s6).length})`);
}

// ── Layer B: живой слой на реальном GitHub ─────────────────────────────────

async function liveApi(p) {
  const res = await ORIGINAL_FETCH(`https://api.github.com${p}`, {
    headers: {
      'Authorization': `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`live api ${res.status} on ${p}`);
  return res.json();
}

async function layerB(registry) {
  log('Layer B (живой слой: реальный GitHub API, токен сессии)');
  if (!ENV0.GH_TOKEN && !ENV0.GITHUB_TOKEN) { log('SKIP: в окружении нет GitHub-токена'); return 'skipped: no token'; }
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.GH_TOKEN = ENV0.GH_TOKEN || ENV0.GITHUB_TOKEN;
  if (ENV0.GITHUB_TOKEN) process.env.GITHUB_TOKEN = ENV0.GITHUB_TOKEN; else delete process.env.GITHUB_TOKEN;
  delete process.env.AGENT_PUBLIC_URL; // ядро само подставит дефолтный публичный health

  const call = async (name, args) => {
    try { return await registry.callTool(name, args); }
    catch (e) { check(false, `L: ${name}(${j(args)}) → исключение: ${e && e.message}`); return { ok: false, error: { code: 'THROWN' } }; }
  };
  const j = o => JSON.stringify(o);

  log('-- L1: смерженный PR agent#1843');
  const m = await call('pr_status', { repo: 'trained-assist/trained-assist-agent', pr_number: 1843 });
  check(m.ok === true, `L1: ok:true (получено ${j(m.error || null)})`);
  check(m.pr && (m.pr.merged === true || m.pr.state === 'merged' || m.pr.state === 'closed'), `L1: смержен (получено ${j(m.pr)})`);
  check(m.prod && ['live', 'not_yet', 'unknown'].includes(m.prod.verdict), `L1: prod.verdict из разрешённого набора (получено ${j(m.prod)})`);
  if (m.prod && m.prod.verdict === 'live') check(m.prod.source === 'health-compare', 'L1: live только из health-compare');
  log(`L1 prod: ${j(m.prod)}`);

  log('-- L2: красный PR (agent#1832 + открытые PR agent/playbooks)');
  const candidates = [['trained-assist/trained-assist-agent', 1832]];
  for (const repo of ['trained-assist/trained-assist-agent', 'trained-assist/software-engineering-playbooks']) {
    try {
      const list = await liveApi(`/repos/${repo}/pulls?state=open&per_page=5`);
      for (const p of list) candidates.push([repo, p.number]);
    } catch (e) { log(`L2: открытые PR ${repo} недоступны: ${e.message}`); }
  }
  let red = null; let redR = null; const seen = new Set();
  for (const [repo, num] of candidates.slice(0, 8)) {
    const key = `${repo}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await call('pr_status', { repo, pr_number: num });
    if (r.ok && (r.ci?.verdict === 'red' || r.ci?.status === 'failure')) { red = { repo, num }; redR = r; break; }
  }
  if (red) {
    check(redR.ci && typeof redR.ci.verdict === 'string', `L2: красный PR ${red.repo}#${red.num} разобран`);
    check((redR.failed_jobs?.length || 0) >= 1 || (redR.ci?.check_runs_failed?.length || 0) >= 1,
      `L2: причина падения видна (failed_jobs=${redR.failed_jobs?.length}, check_runs_failed=${j(redR.ci?.check_runs_failed)})`);
    check(!Array.isArray(redR.failed_jobs) || redR.failed_jobs.length <= 3, 'L2: логи максимум по 3 джоба');
    log(`L2 красный PR: ${red.repo}#${red.num}, failed_jobs=${redR.failed_jobs?.length}`);
  } else {
    log('L2: SKIP — среди кандидатов нет красного PR (пропуск не переводит FAIL в PASS)');
  }

  log('-- L3: issue agent#1725 — PR в разных репо');
  const i = await call('issue_status', { repo: 'trained-assist/trained-assist-agent', issue_number: 1725 });
  check(i.ok === true, `L3: ok:true (получено ${j(i.error || null)})`);
  const acc = (i.prs || []).filter(p => !p.error);
  check(acc.length >= 2, `L3: ≥2 доступных связанных PR (получено ${acc.length})`);
  const l3repos = new Set(acc.map(p => p.repo || String(p.url || p.ref || '').replace(/^https:\/\/github\.com\//, '').replace(/\/pull\/\d+.*$/, '')));
  check(l3repos.size >= 2, `L3: ≥2 разных репозитория (${[...l3repos].join(', ') || 'нет'})`);
  check(!j(i).includes('log_tail'), 'L3: компактный ответ без логов');
  log(`L3 PRs: ${(i.prs || []).map(p => `${p.repo || p.ref}#${p.number}${p.error ? `(${p.error})` : ''}`).join(', ')}`);

  log('-- L4/L5: типизированные ошибки на живых данных');
  const nf = await call('pr_status', { repo: 'trained-assist/trained-assist-agent', pr_number: 999999 });
  check(nf.ok === false && nf.error && nf.error.code === 'NOT_FOUND', `L4: NOT_FOUND (получено ${j(nf.error)})`);
  let aliasThrew = false;
  try { await registry.callTool('github_pr_checks', { repo: 'trained-assist/trained-assist-agent', pr_number: 999999 }); }
  catch (e) { aliasThrew = /404/.test(String(e.message)); }
  check(aliasThrew, 'L4: алиас на живых данных бросает с 404');
  const nap = await call('pr_status', { repo: 'trained-assist/trained-assist-agent', pr_number: 1725 });
  check(nap.ok === false && nap.error && nap.error.code === 'NOT_A_PR', `L5: живой issue → NOT_A_PR (получено ${j(nap.error)})`);

  return 'ran';
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('Песочница pr_status / issue_status (issue #52, план a738d291)');
  log('цель: S5 — замкнутый цикл сценария за секунды на фикстурах' + (FAST ? ' (живой слой выключен: --fast)' : ' + живой слой на реальном GitHub'));

  // Изоляция состояния: временной HOME, фейковый токен, полный каталог реестра.
  process.env.HOME = path.join(ROOT, 'home');
  process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
  process.env.USERS_DIR = path.join(ROOT, 'users');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.USER_ID = 'pr-status-sandbox';
  process.env.GH_TOKEN = FAKE_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.SKILLS_RESOLVED;
  delete process.env.AGENT_PUBLIC_URL;

  const fixture = require(path.join(REPO, 'tests', 'fixtures', 'github', 'pr-status.js'));
  const registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry.js'));

  server = await startFixtureServer(fixture);

  const startedA = Date.now();
  await layerA(registry, fixture);
  const secsA = ((Date.now() - startedA) / 1000).toFixed(1);

  let liveState = 'skipped: layer A failed';
  let secsB = '0.0';
  if (!failures.length && !FAST) {
    const startedB = Date.now();
    liveState = await layerB(registry);
    secsB = ((Date.now() - startedB) / 1000).toFixed(1);
  } else if (FAST) {
    liveState = 'skipped: --fast';
  }

  const level = !featureOk
    ? 'цель S5; статус: фича не в реестре — цикл падает по правильной причине'
    : liveState === 'ran'
      ? 'S5 (эфемерная среда на фикстурах, цикл ~секунды) + живой слой на реальном GitHub (реальные зависимости)'
      : `S5 (эфемерная среда на фикстурах); живой слой: ${liveState}`;

  console.log('');
  log(`уровень: ${level}`);
  log(`время цикла: Layer A ${secsA}s, живой слой ${secsB}s`);
  if (failures.length) { log(`провалено проверок: ${failures.length}`); log('RESULT: FAIL'); return 1; }
  log('RESULT: PASS');
  return 0;
}

main().then(code => {
  try { if (server) server.close(); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(code);
}).catch(e => {
  console.error('[sandbox] error:', (e && e.stack) || e);
  try { if (server) server.close(); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  console.log('[sandbox] RESULT: FAIL');
  process.exit(1);
});
