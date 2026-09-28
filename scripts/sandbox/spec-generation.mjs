#!/usr/bin/env node
// Sandbox loop for spec generation (ТЗ) — one command, deterministic PASS/FAIL.
//
// Scenario (docs/spec-generation-migration.md, §1):
//   1. КОГДА запускается генерация ТЗ, ТОГДА инструкция содержит инженерную
//      конкретику (инфраструктура / тестовое окружение / взаимодействия / шаги),
//      sandbox-блок «Как запускается и как проверяется» и выбранный стиль.
//   2. КОГДА документ сохранён, ТОГДА long.md/short.md содержат эти же блоки
//      и отформатированы в выбранном стиле.
//
// Layer A (always, deterministic, ~1s): real MCP module through the real
//   registry — registration, instruction contract, style switch, read/write of
//   spec/, generation notes, batch scan. This is the fast inner loop.
// Layer B (e2e, minutes): real `opencode` runs the returned instruction in an
//   ephemeral context dir → structural checks on the generated documents
//   (+ optional LLM judge when OPENROUTER_API_KEY is set). Skip reasons are
//   printed explicitly; a skip never turns a red loop green.
//
// Run:
//   npm run test:sandbox            full loop (Layer A + Layer B)
//   npm run test:sandbox -- --fast  Layer A only (~1s) — workhorse loop
//   SANDBOX_E2E=0 npm run test:sandbox   same as --fast
// Env: E2E_MODEL (default opencode-go/deepseek-v4.1-flash),
//      JUDGE_MODEL, E2E_TIMEOUT_MS (default 8 min).
//
// Level: S5 when Layer B runs (agent boots an ephemeral environment and walks
// the scenario end-to-end in minutes); S3 when only Layer A runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'context');
// The engine needs the real profile (opencode providers/auth live in
// $HOME/.config/opencode). Profile STATE of this sandbox must stay in tmp, so
// HOME is swapped after modules load and restored only for the engine child.
const REAL_HOME = process.env.HOME;

const FAST = process.argv.includes('--fast') || process.env.SANDBOX_E2E === '0';
const ENGINE_MODEL = process.env.E2E_MODEL || 'opencode-go/deepseek-v4.1-flash';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek/deepseek-chat';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const ENGINE_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 8 * 60 * 1000);

const EMOJI = /\p{Extended_Pictographic}/u;
const STYLE_TOKEN = /Стиль документа:\s*(oldschool|modern)/;
const SANDBOX_HEADER = /Как запускается и как проверяется/;

// Canonical contract strings. The implementation MUST emit these verbatim —
// they are what the sandbox asserts on, i.e. the executable form of
// Директива 2.В (see docs/spec-generation-migration.md, «Контракт песочницы»).
const VOICE_MARKERS = [
  'Голос документа — техническое задание о СИСТЕМЕ',
  'ТЗ — это НЕ конспект созвона или переписки',
  'Не выдумывай факты, числа, сроки, интеграции',
];
const CONTENT_MARKERS = [
  [/инфраструктур/i, 'инженерная конкретика: упомянута поднимаемая инфраструктура'],
  [/тестов\w*\s+(?:сервер|стенд|окружение)|localhost|:\d{2,5}|порт/i, 'инженерная конкретика: есть тестовый сервер/окружение и порт'],
  [/взаимодейств|протокол|кто с кем/i, 'инженерная конкретика: описано взаимодействие частей (кто с кем, по какому протоколу)'],
  [/(?:по шагам|что именно делается)/i, 'инженерная конкретика: шаги «что именно делается»'],
];
const SBD_MARKERS = [
  [SANDBOX_HEADER, 'sandbox-блок «Как запускается и как проверяется»'],
  [/S0[\s\S]{0,400}S5|S0–S5|S0-S5/i, 'sandbox-блок: лестница уровней автономности S0–S5'],
  [/команд/i, 'sandbox-блок: даны команды запуска'],
];

const EXPECTED_TOOLS = [
  'engineering_generate_spec',
  'engineering_get_spec',
  'engineering_generation_note',
  'engineering_generate_all',
  'engineering_spec_generation_defaults',
  'engineering_spec_generation_explained',
];

const failures = [];
const log = (...a) => console.log('[sandbox]', ...a);
function check(cond, msg) {
  if (cond) console.log('   ok  -', msg);
  else { failures.push(msg); console.log('   FAIL-', msg); }
}

function which(bin) { return spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0; }
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

// ── Layer A: deterministic contract through the real registry ───────────────

function assertRegistration(registry) {
  const declared = registry.listAllTools();
  const names = declared.map(t => t.name);
  const missing = EXPECTED_TOOLS.filter(n => !names.includes(n));
  if (missing.length) {
    console.log('');
    log('ФИЧА ЕЩЁ НЕ РЕАЛИЗОВАНА — цикл падает по правильной причине.');
    log('Реестр не содержит инструментов генерации ТЗ.');
    log('  ожидались:  ' + EXPECTED_TOOLS.join(', '));
    log('  не найдены: ' + missing.join(', '));
    log('  см. src/spec-generation/rules.js + src/mcp-skills/tools/65-spec-generation.js (design, срезы S1–S2).');
    log('RESULT: FAIL');
    process.exit(1);
  }
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  check(dup.length === 0, `нет коллизий имён в реестре (${names.length} инструментов)`);
}

function instructionContract(text, { variant, style }) {
  for (const s of VOICE_MARKERS) check(text.includes(s), `voice-правила дословно: ${s.slice(0, 40)}…`);
  for (const [re, label] of CONTENT_MARKERS) check(re.test(text), label);
  for (const [re, label] of SBD_MARKERS) check(re.test(text), label);
  const m = text.match(STYLE_TOKEN);
  check(!!m, 'в инструкции есть строка «Стиль документа: <style>»');
  check(m && m[1] === style, `стиль документа = ${style}`);
  if (variant === 'long') check(SANDBOX_HEADER.test(text), 'long: полный sandbox-блок «Как запускается и как проверяется»');
  if (variant === 'short') check(/Как проверяем/i.test(text), 'short: краткий пункт «Как проверяем»');
  check(/Система должна|требован/i.test(text), 'правила: требования в утвердительной форме о системе');
}

async function layerA(registry, root) {
  log('Layer A (детерминированный контракт инструкции и тулов)');
  assertRegistration(registry);

  const ctx = path.join(root, 'context');
  copyTree(FIXTURE, ctx);

  const gen = await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'both' });
  check(Array.isArray(gen.variants) && gen.variants.join(',') === 'long,short', 'generate_spec: variants = long + short');
  check(typeof gen.instruction === 'string' && gen.instruction.length > 500, 'generate_spec: возвращена инструкция');
  check(!!gen.spec_paths && !!gen.spec_paths.long && !!gen.spec_paths.short, 'generate_spec: spec_paths для long и short');
  check(typeof gen.spec_source_path === 'string' && gen.spec_source_path.endsWith('_source.md'), 'generate_spec: путь нормализации spec/_source.md');
  check(!!gen.sources && typeof gen.sources.facts === 'string', 'generate_spec: источники (facts/…) прочитаны');
  check(fs.existsSync(path.join(ctx, 'spec')), 'generate_spec: каталог spec/ создан');
  check(!('qna' in (gen.sources || {})) && !JSON.stringify(gen).includes('qna.md'), 'generate_spec: qna/провенанс не подаются в генерацию');
  instructionContract(gen.instruction, { variant: 'long', style: 'oldschool' });

  log('-- переключение стиля (R7)');
  const modern = await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'long', style: 'modern' });
  check(STYLE_TOKEN.test(modern.instruction) && modern.instruction.match(STYLE_TOKEN)[1] === 'modern', "style='modern' включает прежний вид");
  check(!/Стиль документа:\s*oldschool/.test(modern.instruction), "style='modern' выключает новый стиль");
  check(modern.instruction !== gen.instruction, 'инструкции стилей различаются');
  let unknownThrew = false;
  try { await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'long', style: 'vintage' }); }
  catch (e) { unknownThrew = true; check(/style|стил/i.test(String(e && e.message)), `неизвестный style → понятная ошибка: ${e.message}`); }
  check(unknownThrew, 'неизвестный style → throw (а не молчаливый дефолт)');

  log('-- содержательные правила действуют на ЛЮБОЙ вариант (R8)');
  const shortOnly = await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'short' });
  for (const [re, label] of CONTENT_MARKERS) check(re.test(shortOnly.instruction), `short-вариант: ${label}`);
  check(/Как проверяем/i.test(shortOnly.instruction), 'short-вариант: пункт «Как проверяем» присутствует');

  log('-- чтение и точечная правка (get_spec)');
  const longPath = gen.spec_paths.long;
  const sample = '# ТЗ для смены\n\nСистема должна принимать заявку из веб-формы.\n';
  fs.writeFileSync(longPath, sample);
  const got = await registry.callTool('engineering_get_spec', { context_dir: ctx, variant: 'long' });
  check(got.docs && got.docs.long === sample, 'get_spec: возвращает текущий текст long.md');
  check(typeof got.instruction === 'string' && got.instruction.length > 50, 'get_spec: отдаёт инструкцию точечного редактирования');
  const legacyCtx = path.join(root, 'legacy');
  copyTree(FIXTURE, legacyCtx);
  fs.mkdirSync(path.join(legacyCtx, 'spec'), { recursive: true });
  fs.writeFileSync(path.join(legacyCtx, 'spec', 'tz.md'), '# Legacy ТЗ\n');
  const legacy = await registry.callTool('engineering_get_spec', { context_dir: legacyCtx, variant: 'both' });
  check(legacy.docs && legacy.docs.long === '# Legacy ТЗ\n', 'get_spec: legacy spec/tz.md читается как long (read-compat)');

  log('-- постоянные инструкции (generation_note)');
  const note1 = await registry.callTool('engineering_generation_note', { text: 'всегда делай ТЗ техничнее', context_dir: ctx, mode: 'append' });
  await registry.callTool('engineering_generation_note', { text: 'не добавлять раздел «Input Info»', context_dir: ctx, mode: 'append' });
  const projNote = path.join(ctx, 'spec', 'generation.md');
  check(fs.existsSync(projNote) && fs.readFileSync(projNote, 'utf8').includes('техничнее'), 'generation_note: проектная записка лежит в context_dir/spec/generation.md');
  check((fs.readFileSync(projNote, 'utf8').match(/^- /gm) || []).length === 2, 'generation_note: режим append добавляет пункты, а не затирает');
  await registry.callTool('engineering_generation_note', { text: 'только короткие фразы', context_dir: ctx, mode: 'replace' });
  check(fs.readFileSync(projNote, 'utf8').trim() === 'только короткие фразы', 'generation_note: режим replace перезаписывает целиком (без маркера списка, как в исходном freelance)');
  check(!!note1 && note1.saved === true, 'generation_note: подтверждает сохранение');
  const profNote = path.join(process.env.HOME, 'agent-data', 'spec-generation', '_generation.md');
  await registry.callTool('engineering_generation_note', { text: 'профильная инструкция' });
  check(fs.existsSync(profNote) && fs.readFileSync(profNote, 'utf8').includes('профильная инструкция'), 'generation_note: профильная записка в ~/agent-data/spec-generation/_generation.md');
  const withProj = await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'long' });
  check(!!withProj.generation_notes && /только короткие фразы/.test(withProj.generation_notes.project || ''), 'generate_spec: проектные инструкции попадают в generation_notes');
  check(/профильная инструкция/.test(withProj.generation_notes.profile || ''), 'generate_spec: профильные инструкции попадают в generation_notes');
  check(/Постоянные инструкции пользователя/.test(withProj.instruction), 'generate_spec: инструкция содержит блок постоянных инструкций');

  log('-- пакетная генерация (generate_all)');
  const batchRoot = path.join(root, 'batch');
  const p1 = path.join(batchRoot, 'project-alpha'); const p2 = path.join(batchRoot, 'project-beta');
  copyTree(FIXTURE, p1); copyTree(FIXTURE, p2);
  fs.mkdirSync(path.join(p2, 'spec'), { recursive: true });
  fs.writeFileSync(path.join(p2, 'spec', 'long.md'), '# уже готово\n');
  const all = await registry.callTool('engineering_generate_all', { root: batchRoot, since: '6h' });
  check(Array.isArray(all.projects) && all.projects.length === 2, `generate_all: нашёл 2 проекта (получено ${all.projects && all.projects.length})`);
  check(!!all.projects && !!all.projects[0].spec_paths && !!all.projects[0].spec_paths.long, 'generate_spec: у каждого проекта есть spec_paths');
  check(typeof all.instruction === 'string' && all.instruction.length > 50, 'generate_all: отдаёт инструкцию пакетной генерации');

  log('-- настройки и объяснение');
  const defs = await registry.callTool('engineering_spec_generation_defaults', { context_dir: ctx });
  check(!!defs && typeof defs.text === 'string' && defs.text.length > 50, 'defaults: возвращает текущие настройки');
  check(JSON.stringify(defs).match(/_generation\.md|профиль|profile/i), 'defaults: показывает путь постоянных инструкций');
  const expl = await registry.callTool('engineering_spec_generation_explained', {});
  check(!!expl && typeof expl.text === 'string' && expl.text.length > 50, 'explained: объясняет пайплайн генерации');

  return { ctx, instruction: gen.instruction };
}

// ── Layer B: e2e generation through the real engine ─────────────────────────

function structuralIssues(long, short) {
  const issues = [];
  const has = (t, re) => re.test(t || '');
  if (!long || long.trim().length < 400) issues.push('long.md пустой или слишком короткий');
  if (!short || short.trim().length < 200) issues.push('short.md пустой или слишком короткий');
  if (!has(long, /инфраструктур|PostgreSQL|docker|очеред|Redis|сервис|хостинг/i)) issues.push('long: нет упоминания инфраструктуры, которая поднимается');
  if (!has(long, /тестов\w*\s+(?:сервер|стенд|окружение)|localhost|:\d{2,5}|порт/i)) issues.push('long: нет тестового окружения/сервера/порта');
  if (!has(long, /взаимодейств|протокол|HTTP|REST|очеред/i)) issues.push('long: не описано взаимодействие частей');
  const hasRunVerify = has(long, /Как запускается и как проверяется/i)
    || (has(long, /запуск|подъ[её]м|поднять|собрать/i) && has(long, /провер/i));
  if (!hasRunVerify) issues.push('long: нет sandbox-блока «как запускается и как проверяется» (запуск + проверка)');
  if (!has(long, /S[0-5]\b/)) issues.push('long: не указан уровень автономности S0–S5');
  if (!has(long, /(?:npm|node|docker|curl|http:\/\/localhost)/i)) issues.push('long: в sandbox-блоке нет ни одной команды запуска');
  if (!has(short, /Как проверяем/i)) issues.push('short: нет краткого пункта «Как проверяем»');
  if (EMOJI.test(long) || EMOJI.test(short)) issues.push('стиль oldschool: в документах есть эмодзи/декор');
  if (has(long, /клиент\s+(?:сказал|подтвердил|уточнил|прислал)|Input Info|Источники|Исходные материалы|История обсуждения|из разговора следует/i)) issues.push('long: в ТЗ просочился провенанс («кто что сказал» / раздел-источник)');
  if (/(?:…|\.\.\.)\s*$/.test((long || '').trim())) issues.push('long: документ оборван');
  return issues;
}

async function judge(input, long, short) {
  const prompt = [
    'Ты — приёмочный судья. На вход: исходный контекст проекта, требования к ТЗ и само ТЗ.',
    'Оцени: получилось ли технически конкретное ТЗ, по которому инженер может начать работу — с описанием инфраструктуры, взаимодействий и блоком «Как запускается и как проверяется»?',
    'Не оценивай красоту формулировок. Верни СТРОГО JSON: {"verdict":"PASS"|"FAIL","reasons":["..."]}.',
    'Контекст:\n' + input,
    'Long:\n' + long.slice(0, 9000),
    'Short:\n' + short.slice(0, 4000),
  ].join('\n\n');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}` },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const text = (await res.json()).choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge: no JSON in answer: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]);
  return { verdict: String(parsed.verdict || '').toUpperCase(), reasons: parsed.reasons || [] };
}

function runEngine(workDir, prompt) {
  return new Promise((resolve) => {
    const child = spawn('opencode', ['run', '-m', ENGINE_MODEL, '--auto', '--dir', workDir, prompt], {
      cwd: workDir, env: { ...process.env, HOME: REAL_HOME, XDG_CONFIG_HOME: path.join(REAL_HOME, '.config') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ code: null, signal: 'TIMEOUT', out, err }); }, ENGINE_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', (code, signal) => finish({ code, signal, out, err }));
    child.on('error', e => finish({ code: -1, signal: null, out, err: e.message }));
  });
}

async function layerB(root, registry) {
  if (FAST) { log('Layer B (e2e через opencode): SKIP (--fast / SANDBOX_E2E=0)'); return 'skipped: fast mode'; }
  if (!which('opencode')) { log('Layer B (e2e через opencode): SKIP (opencode не найден)'); return 'skipped: no opencode'; }

  const ctx = path.join(root, 'e2e-context');
  rmrf(ctx);
  copyTree(FIXTURE, ctx);
  const gen = await registry.callTool('engineering_generate_spec', { context_dir: ctx, variants: 'both' });

  const input = fs.readFileSync(path.join(FIXTURE, 'sources', 'dialog.md'), 'utf8');
  const task = [
    'Это тест сквозного процесса генерации ТЗ. Действуй без вопросов.',
    'Ниже — нормализуемый контекст проекта. Выполни полученную инструкцию по шагам:',
    'ШАГ 1 — нормализуй контекст в spec/_source.md; ШАГ 2 — сгенерируй каждый запрошенный вариант независимо.',
    'Пиши ровно в те пути, что указаны в инструкции. Не задавай вопросов.',
    '', '--- ИНСТРУКЦИЯ ---', gen.instruction,
    '', '--- ИСХОДНЫЙ КОНТЕКСТ ---', input,
  ].join('\n');

  log(`Layer B: engine=${ENGINE_MODEL} judge=${JUDGE_MODEL} dir=${path.basename(ctx)}`);
  const started = Date.now();
  const run = await runEngine(ctx, task);
  log(`engine finished in ${Math.round((Date.now() - started) / 1000)}s, exit=${run.code}${run.signal ? ` signal=${run.signal}` : ''}`);
  if (run.code !== 0) log(`engine tail: ${(run.err || run.out || '').slice(-400)}`);

  const longPath = path.join(ctx, 'spec', 'long.md');
  const shortPath = path.join(ctx, 'spec', 'short.md');
  const long = fs.existsSync(longPath) ? fs.readFileSync(longPath, 'utf8') : '';
  const short = fs.existsSync(shortPath) ? fs.readFileSync(shortPath, 'utf8') : '';
  log(`documents: long=${long.length}b short=${short.length}b`);

  const issues = structuralIssues(long, short);
  for (const i of issues) check(false, `e2e: ${i}`);
  if (!issues.length) check(true, 'e2e: структурные проверки документов пройдены');

  if (!OPENROUTER_KEY) log('judge: SKIP (нет OPENROUTER_API_KEY)');
  else if (!long && !short) log('judge: SKIP (документы не сгенерированы)');
  else {
    try {
      const r = await judge(input, long, short);
      log(`judge: ${r.verdict} — ${(r.reasons || []).join('; ')}`);
      check(r.verdict === 'PASS', 'e2e: вердикт судьи PASS');
    } catch (e) { check(false, `e2e: судья недоступен (${e.message})`); }
  }
  return 'ran';
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sandbox-'));
  // Profile state must stay inside the sandbox: set HOME before loading modules
  // so nothing writes to the real ~/agent-data.
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.USER_ID = process.env.USER_ID || 'spec-sandbox';
  process.env.AGENT_TOKENS_DIR = path.join(process.env.HOME, 'agent-tokens');

  const registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry.js'));

  const started = Date.now();
  let e2eState = 'skipped: layer A failed';
  await layerA(registry, root);
  if (!failures.length) e2eState = await layerB(root, registry);
  else log('Layer B не запускается: Layer A не пройден');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const level = e2eState === 'ran' ? 'S5 (полный замкнутый цикл, e2e запущен)'
    : e2eState.startsWith('skipped: fast') || e2eState.startsWith('skipped: no') ? `S3 (только детерминированный контракт; e2e: ${e2eState})`
    : `— (e2e: ${e2eState})`;
  console.log('');
  log(`уровень: ${level}; время цикла: ${secs}s`);
  if (failures.length) { log(`провалено проверок: ${failures.length}`); log('RESULT: FAIL'); process.exit(1); }
  log('RESULT: PASS');
  process.exit(0);
}

main().catch(e => {
  console.error('[sandbox] error:', e && e.message || e);
  console.log('[sandbox] RESULT: FAIL');
  process.exit(1);
});
