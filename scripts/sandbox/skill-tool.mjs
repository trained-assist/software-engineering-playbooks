#!/usr/bin/env node
// Sandbox loop for the `skill-tool` playbook (scenario, issue #53) — one
// command, deterministic PASS/FAIL.
//
// The loop walks the 9 steps of docs/user-scenarios/playbooks/skill-tool.md
// through the REAL functional blocks of this repository: the playbook builder,
// the vendored Playbook v1 schema and the repo test suite (which is exactly
// the acceptance criterion #53: "проходит tests/playbooks.test.js").
//
// Level: S3 — autotests over real modules, no network, no engine; the parts of
// the scenario that live outside this repo (PR/CI, релиз, живая сессия) are
// checked here as CONTRACTS the compiled playbook must declare (gates, waits,
// notes), not as executions. The real executions are the later steps of the
// plan (deploy + пробный прогон on a real tool = S5).
// Cycle target: ≤10 s.
//
// Run:
//   npm run test:sandbox:skill-tool
//   node scripts/sandbox/skill-tool.mjs
//
// The loop is RED while playbooks-src/skill-tool.json does not exist — that is
// the correct reason (the feature is not built yet). A skipped scenario step
// never counts as passed.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'playbooks-src', 'skill-tool.json');

const t0 = Date.now();

// Real block: the same builder CI and tests use.
const { buildAll } = require(path.join(REPO, 'scripts', 'build-playbooks.js'));
const { built } = buildAll();
const pb = built.find(b => b.id === 'skill-tool');
const flat = p => p ? p.stages.flatMap(s => s.steps) : [];
const types = p => flat(p).map(s => s.step_type);

const checks = [];
const run = (id, step, label, fn) => checks.push({ id, step, label, fn });

const pass = detail => ({ ok: true, detail });
const fail = detail => ({ ok: false, detail });
const skip = detail => ({ ok: false, skipped: true, detail });

// ── C0: the feature itself ──────────────────────────────────────────────────
run('source', 0, 'источник playbooks-src/skill-tool.json существует', () => {
  if (!fs.existsSync(SRC)) return skip('фичи ещё нет: файла нет → шаги сценария не собираются');
  if (!pb) return fail('источник есть, но плейбук не собрался (npm run build:playbooks)');
  return pass();
});

// Real block: committed build output must be in sync (CI runs the same --check).
run('build', 0, 'сборка свежая: node scripts/build-playbooks.js --check', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-playbooks.js'), '--check'],
    { cwd: REPO, encoding: 'utf8' });
  if (r.status === 0) return pass();
  return fail(`устаревшая сборка — npm run build:playbooks\n    ${((r.stderr || r.stdout) || '').trim().split('\n')[0]}`);
});

// Real block: the repo acceptance test for #53 (schema + invariants + freshness).
run('repo-tests', 0, 'node --test tests/playbooks.test.js (приёмка #53, схема + инварианты)', () => {
  const r = spawnSync(process.execPath, ['--test', 'tests/playbooks.test.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status === 0) return pass();
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const firstFail = (out.split('\n').find(l => /not ok |failureType|Error:/.test(l)) || 'тест упал').trim();
  return fail(`tests/playbooks.test.js красный\n    ${firstFail}`);
});

// ── scenario steps 1–9, as contracts of the compiled playbook ───────────────
const whenBuilt = fn => () => (pb ? fn(pb) : skip('нет плейбука — шаг сценария не проверяем'));

run('input-repo', 1, 'шаг 1: без repo → INPUT_REQUIRED (вход объявлен и обязательный)', whenBuilt(p => {
  const repo = (p.inputs || []).find(i => i.name === 'repo');
  if (!repo) return fail('нет входа repo');
  if (repo.derive !== 'github_repo') return fail('derive !== github_repo');
  if (repo.required === false) return fail('repo необязательный — INPUT_REQUIRED не сработает');
  return pass();
}));

run('order', 2, 'шаги 2–9: порядок этапов (конвенции → песочница → код → PR → CI → релиз → проверка)', whenBuilt(p => {
  const t = types(p);
  const chain = ['explore-context', 'sandbox', 'implement', 'verify-local', 'open-pr',
    'ci-green', 'merged', 'deployed', 'verify-real', 'archive'];
  let last = -1;
  for (const type of chain) {
    const i = t.indexOf(type);
    if (i < 0) return fail(`нет шага типа ${type}`);
    if (i < last) return fail(`${type} идёт раньше предыдущего обязательного шага`);
    last = i;
  }
  return pass();
}));

run('conventions', 2, 'шаг 2: конвенции скила — workspace и каталог тулов в notes', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'explore-context');
  if (!/engineering_spawn_workspace/.test(s.instructions)) return fail('нет указания выдать workspace');
  if (!/src\/mcp-skills\/tools/.test(s.instructions)) return fail('нет пути каталога тулов src/mcp-skills/tools');
  return pass();
}));

run('tool-draft', 3, 'шаг 3: заготовка файла тула (схема входа, описание, конфликт = падение)', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'implement');
  if (!s) return fail('нет шага implement');
  if (!/inputSchema|схем/i.test(s.instructions)) return fail('нет требования о схеме входа');
  if (!/конфликт|перезапис/i.test(s.instructions)) return fail('нет правила: конфликт имени = падение, не перезапись');
  return pass();
}));

run('executable-test', 4, 'шаг 4: исполняемый тест хендлера и регистрации (красный до, зелёный после)', whenBuilt(p => {
  const t = types(p);
  const si = t.indexOf('sandbox');
  if (si < 0 || si >= t.indexOf('implement')) return fail('песочница не стоит до implement (нет красного теста)');
  const s = flat(p).find(x => x.step_type === 'verify-local');
  if (!s || !/npm test/.test(s.instructions)) return fail('verify-local не гоняет npm test скила');
  return pass();
}));

run('prompt-rule', 5, 'шаг 5: условное правило в промпт-домене (или явное ⏭ не нужно)', whenBuilt(p => {
  const text = flat(p).map(s => s.instructions).join('\n');
  if (!/промпт-домен/.test(text)) return fail('нет шага про правило в промпт-домене');
  if (!/⏭ не нужно/.test(text)) return fail('нет явного закрытия «⏭ не нужно — почему» для неизменяющего поведение тула');
  return pass();
}));

run('ci-staging', 6, 'шаг 6: CI + staging зелёные; нет staging-job → блок, не молчаливый skip', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'ci-green');
  if (!s) return fail('нет шага ci-green');
  if (s.validation.ci_and_staging_green !== true) return fail('validation не ci_and_staging_green (правило 2026-09-16)');
  if (!/staging-gate/.test(s.instructions)) return fail('нет проверки job staging-gate');
  if (!/#9/.test(s.instructions)) return fail('нет ветки «нет staging → задача в issue #9»');
  if (!/skip/i.test(s.instructions)) return fail('нет явного запрета молчаливого skip');
  return pass();
}));

run('release', 7, 'шаг 7: релиз содержит мерж-коммит (не «зелёный deploy») + запасной путь', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'deployed');
  if (!s) return fail('нет шага deployed');
  if (!/merge-base|мерж-коммит|merge-коммит/i.test(s.instructions)) return fail('нет проверки предка мерж-коммита в чекауте скила');
  if (!/#1818/.test(s.instructions)) return fail('нет запасного пути на случай снятия ssh-доступа (#1818)');
  return pass();
}));

run('visible', 8, 'шаг 8: тул виден в НОВОЙ сессии', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'verify-real'
    && /новой сессии|нов.*сесси/i.test(`${x.title} ${x.instructions}`));
  if (!s) return fail('нет verify-real «виден в новой сессии»');
  return pass();
}));

run('real-call', 9, 'шаг 9: живой вызов реальными аргументами; креды = ждём, не фейкуем', whenBuilt(p => {
  const s = flat(p).find(x => x.step_type === 'verify-real'
    && /реальн.*вызов|живой вызов/i.test(`${x.title} ${x.instructions}`));
  if (!s) return fail('нет verify-real «реальный вызов»');
  if (!/awaiting_user|кред/.test(s.instructions)) return fail('нет ветки «нет кредов → durable wait», риск фейкового вызова');
  if (!/мусор/i.test(s.instructions)) return fail('нет запрета оставлять тестовый мусор в проде');
  return pass();
}));

// Negative value of the scenario: «смержено, но в сессии тула нет» must be
// structurally impossible → two DIFFERENT verify-real gates, not one generic.
run('two-gates', 9, 'негативная ценность: «виден» и «вызван» — два разных гейта', whenBuilt(p => {
  const vr = flat(p).filter(s => s.step_type === 'verify-real');
  if (vr.length !== 2) return fail(`verify-real: ожидалось 2, найдено ${vr.length}`);
  if (vr[0].title === vr[1].title) return fail('оба verify-real с одинаковым title — гейты не различимы');
  return pass();
}));

run('closure', 9, 'план закрывается только после проверки (archive в конце, уведомления владельцу)', whenBuilt(p => {
  const t = types(p);
  if (t[t.length - 1] !== 'archive') return fail('последний шаг не archive');
  if (!p.hooks || !p.hooks.task_done || !p.hooks.task_failed) return fail('нет hooks task_done/task_failed');
  return pass();
}));

// ── run ─────────────────────────────────────────────────────────────────────
console.log('[skill-tool sandbox] S3, цель цикла ≤10s — реальные блоки: buildAll, схема/тесты репо, собранный плейбук\n');

let failed = 0;
const results = [];
for (const c of checks) {
  let res;
  try { res = c.fn(); } catch (err) { res = fail(`исключение: ${err.message}`); }
  results.push(res);
  const mark = res.ok ? 'PASS' : (res.skipped ? 'SKIP' : 'FAIL');
  if (!res.ok) failed += 1;
  const head = c.step ? `шаг сценария ${c.step}` : 'блок';
  console.log(`  ${mark}  [${head}] ${c.label}`);
  if (res.detail) console.log(`        → ${res.detail.split('\n').join('\n        ')}`);
}

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nИТОГ: ${failed ? 'FAIL' : 'PASS'} — ${checks.length - failed}/${checks.length} проверок, ${sec}s`);
if (failed) {
  const failedIds = checks.filter((c, i) => !results[i].ok).map(c => c.id);
  const onlyGlobal = failedIds.every(id => ['source', 'build', 'repo-tests'].includes(id));
  const hint = failedIds.includes('source')
    ? 'нет playbooks-src/skill-tool.json — фичи ещё нет: создай источник и npm run build:playbooks.'
    : onlyGlobal
      ? 'сборка есть, но tests/playbooks.test.js красный — синхронизируй список плейбуков/инварианты с источником, потом прогони снова.'
      : 'красные шаги сценария выше: правь playbooks-src/skill-tool.json → npm run build:playbooks → прогони снова.';
  console.log(`Подсказка: ${hint}`);
}
process.exit(failed ? 1 : 0);
