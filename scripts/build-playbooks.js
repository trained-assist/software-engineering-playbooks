#!/usr/bin/env node
'use strict';

// Build the engineering playbooks from their sources.
//
//   library/step-types.json   typed step library: contract + sub-steps + ladders/flags
//   playbooks-src/<id>.json   a playbook as stages of { use: <step type>, ...overrides, notes }
//        │  node scripts/build-playbooks.js
//        ▼
//   playbooks/<id>.json       Playbook v1 (contracts/playbook.schema.json) — what the
//                             agent's PlaybookStore resolves from this sibling repo
//   docs/playbooks/*.md       the same, readable by a human
//   docs/playbooks-overview-and-owner-draft-mapping.md
//                             one document over ALL playbooks + owner-draft mapping
//
// Sub-steps are rendered into each step's `instructions` as a checklist, so the
// executing agent walks the whole checklist in one run; `step_type` keeps the
// link to the library. `--check` fails if the committed output is stale.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY_PATH = path.join(ROOT, 'library', 'step-types.json');
const SRC_DIR = path.join(ROOT, 'playbooks-src');
const OUT_DIR = path.join(ROOT, 'playbooks');
const DOCS_DIR = path.join(ROOT, 'docs', 'playbooks');
const OVERVIEW_PATH = path.join(ROOT, 'docs', 'playbooks-overview-and-owner-draft-mapping.md');

const REPO_LINE = 'Репозиторий: {repo} (если вместо имени репозитория тут слово repo в фигурных скобках — его не передали в playbook_run: определи из цели и итогов прошлых шагов или спроси пользователя).';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadLibrary() {
  return readJson(LIBRARY_PATH);
}

function loadSources() {
  return fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => readJson(path.join(SRC_DIR, f)));
}

function ladderBlock(library, id) {
  const ladder = library.ladders[id];
  if (!ladder) throw new Error(`unknown ladder: ${id}`);
  return [`${ladder.title}:`, ...ladder.levels.map(l => `  • ${l}`), `  Правило: ${ladder.rule}`].join('\n');
}

function flagsBlock(library) {
  const f = library.flags;
  return [`${f.title}:`, ...f.levels.map(l => `  • ${l}`), `  Правило: ${f.rule}`].join('\n');
}

// `context` replaces the default «Репозиторий: {repo}» line for playbooks whose
// steps work across repositories (epic-delivery: the architecture repo + an epic).
function renderInstructions(library, typeId, type, notes, context = REPO_LINE) {
  const parts = [`Тип шага: ${typeId} — ${type.purpose}`];
  if (type.execution_kind === 'agent') parts.push(context);
  parts.push([
    type.execution_kind === 'agent'
      ? 'Чек-лист (пройди все пункты за этот ран; в ИТОГЕ ШАГА коротко отметь каждый: ✅ сделано / ⏭ не нужно — почему):'
      : 'Что происходит:',
    ...type.substeps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n'));
  if (type.ladder) parts.push(ladderBlock(library, type.ladder));
  if (type.flags) parts.push(flagsBlock(library));
  parts.push(`Готово, когда: ${type.done_when}`);
  if (notes.length) parts.push(['Для этого плейбука:', ...notes.map(n => `- ${n}`)].join('\n'));
  return parts.join('\n\n');
}

const STEP_OVERRIDES = ['title', 'validation', 'already_done', 'executor_role', 'minimum_model_level', 'context_budget',
  'execution_timeout_seconds', 'max_attempts', 'delay_after_sec', 'wait', 'on_complete', 'on_fail'];

function buildStep(library, src, context, where) {
  const type = library.types[src.use];
  if (!type) throw new Error(`${where}: unknown step type "${src.use}"`);
  const merged = { ...type };
  for (const key of STEP_OVERRIDES) if (src[key] !== undefined) merged[key] = src[key];
  const notes = [...(src.notes || [])];
  const step = {
    title: merged.title,
    step_type: src.use,
    instructions: renderInstructions(library, src.use, type, notes, context),
    execution_kind: merged.execution_kind,
  };
  if (merged.execution_kind === 'agent') {
    step.executor_role = merged.executor_role;
    step.minimum_model_level = merged.minimum_model_level;
    step.context_budget = merged.context_budget;
  }
  step.validation = merged.validation;
  for (const key of ['already_done', 'delay_after_sec', 'max_attempts', 'execution_timeout_seconds', 'wait', 'on_complete', 'on_fail']) {
    if (merged[key] !== undefined) step[key] = merged[key];
  }
  return step;
}

function buildPlaybook(library, src) {
  const out = {
    id: src.id,
    version: src.version,
    scope: src.scope,
    title: src.title,
    goal_template: src.goal_template,
  };
  if (src.when_to_use) out.when_to_use = src.when_to_use;
  if (src.requires) out.requires = src.requires;
  if (src.user_value_template) out.user_value_template = src.user_value_template;
  if (src.defaults) out.defaults = src.defaults;
  if (src.inputs) out.inputs = src.inputs;
  out.stages = src.stages.map(stage => {
    const built = { id: stage.id, title: stage.title };
    if (stage.on_enter) built.on_enter = stage.on_enter;
    if (stage.on_exit) built.on_exit = stage.on_exit;
    built.steps = stage.steps.map((s, i) => buildStep(library, s, src.context || REPO_LINE, `${src.id}/${stage.id}[${i}]`));
    return built;
  });
  // Playbook-wide notes go to the first agent step, where the run starts.
  if (src.notes && src.notes.length) {
    const first = out.stages[0].steps.find(s => s.execution_kind === 'agent');
    if (first) first.instructions += `\n\nОбщее для плейбука «${src.id}»:\n${src.notes.map(n => `- ${n}`).join('\n')}`;
  }
  if (src.hooks) out.hooks = src.hooks;
  return out;
}

// ── human-readable docs ──────────────────────────────────────────────────────

const LEVEL_NOTE = { bachelor: 'дешёвая модель', master: 'сильная дешёвая', doctor: 'Claude (дорого)' };
// reviewer + doctor is the independent cross-review: a different model family than
// the Claude builder (Codex, fallback OpenCode doctor — never Claude).
const levelNote = step => (step.executor_role === 'reviewer' && step.minimum_model_level === 'doctor'
  ? 'Codex — другая семья моделей, не Claude' : LEVEL_NOTE[step.minimum_model_level]);

function contractCell(step) {
  const skip = step.already_done ? `, уже-выполнено: ${Object.keys(step.already_done).join(', ')}` : '';
  if (step.execution_kind === 'programmatic') {
    return `программно${step.wait ? `, ждёт (опрос ${step.wait.poll_every_sec / 60} мин, таймаут ${Math.round(step.wait.timeout_sec / 3600)} ч)` : ''}${skip}`;
  }
  return `${step.executor_role} · ${step.minimum_model_level} (${levelNote(step)}) · ${step.context_budget}${skip}`;
}

function renderPlaybookDoc(library, src, built) {
  const lines = [
    `# Плейбук \`${built.id}\` — ${built.title}`,
    '',
    '> Сгенерировано `scripts/build-playbooks.js` из `playbooks-src/' + built.id + '.json` и `library/step-types.json`. Правь источники, не этот файл.',
    '',
    `**Когда:** ${src.when}`,
    '',
    `**Результат:** ${built.user_value_template || '—'}`,
    '',
  ];
  if (src.notes && src.notes.length) lines.push(...src.notes.map(n => `- ${n}`), '');
  lines.push('**Запуск:** `playbook_run(playbook_id: "' + built.id + '", goal: "<что делаем>", vars: ' + (src.run_vars || '{repo: "<owner/repo>"}') + ')` → черновик плана → `task_update(status: "active")`.', '');
  let n = 0;
  lines.push('| # | Стадия | Шаг | Тип | Исполнитель | Проверка |', '|---|---|---|---|---|---|');
  for (const stage of built.stages) {
    for (const step of stage.steps) {
      n += 1;
      lines.push(`| ${n} | ${stage.title} | ${step.title} | \`${step.step_type}\` | ${contractCell(step)} | \`${Object.keys(step.validation).join(', ')}\` |`);
    }
  }
  lines.push('', '## Шаги подробно', '');
  n = 0;
  for (const stage of built.stages) {
    lines.push(`### Стадия «${stage.title}»`, '');
    for (const step of stage.steps) {
      n += 1;
      lines.push(`#### ${n}. ${step.title}`, '', '```text', step.instructions, '```', '');
    }
  }
  return lines.join('\n');
}

function renderLibraryDoc(library, builtAll) {
  const usage = {};
  for (const b of builtAll) {
    for (const stage of b.stages) for (const step of stage.steps) (usage[step.step_type] ||= new Set()).add(b.id);
  }
  const lines = [
    '# Библиотека типов шагов',
    '',
    '> Сгенерировано из `library/step-types.json`. Правь источник, не этот файл.',
    '',
    library.description,
    '',
    '| Тип | Название | OpenSpec / аналог | Исполнитель | Проверка | Где используется |',
    '|---|---|---|---|---|---|',
  ];
  for (const [id, t] of Object.entries(library.types)) {
    const who = t.execution_kind === 'programmatic' ? 'программно' : `${t.executor_role} · ${t.minimum_model_level}`;
    lines.push(`| \`${id}\` | ${t.title} | ${t.openspec} | ${who} | \`${Object.keys(t.validation).join(', ')}\` | ${[...(usage[id] || [])].join(', ') || '—'} |`);
  }
  lines.push('', '## Лестницы', '');
  for (const id of Object.keys(library.ladders)) lines.push('```text', ladderBlock(library, id), '```', '');
  lines.push('## Флаги сложности требований', '', '```text', flagsBlock(library), '```', '');
  return lines.join('\n');
}

// ── one overview over ALL playbooks + owner-draft mapping ────────────────────
// The mechanical sections (inventory, level counts, per-step tables) are
// regenerated from the built playbooks, so `npm run check:playbooks` fails the
// moment they go stale. The owner-draft mapping and the model notes are prose
// kept next to the generator on purpose: they are analysis, and a regeneration
// pass re-verifies them by hand — the generator only owns the facts.

const OWNER_DRAFT = 'черновиком владельца «Software Engineering Playbooks» (2026-09-27)';
const ROLE_RU = { researcher: 'исследователь', developer: 'разработчик', reviewer: 'ревьюер', verifier: 'проверяющий' };
const LEVEL_MODEL = {
  bachelor: 'bachelor → Go deepseek',
  master: 'master → Go deepseek',
  doctor: 'doctor → Claude → Codex → opencode doctor',
};

// [что просили в черновике, где живёт сейчас, статус] — перепроверяется при каждой
// перегенерации; 🟡 = не сделано/не подтверждено, честно помечено.
const OWNER_MAPPING = [
  ['Сначала большие сценарии, потом стандартные блоки подробно',
    '7 плейбуков + библиотека 32 типов шагов с чек-листами (`library/step-types.json`, `docs/playbooks/step-library.md`)', '✅'],
  ['Playbook Zero: новый софт/модуль, свобода в архитектуре',
    '`new-software`: use case → infra-discovery → explore → сложность → варианты → план → песочница → bootstrap → … → go-live → archive', '✅'],
  ['Infrastructure / environment discovery: что есть (VM, маки, GCP, GPU, ключи), какой доступ даст юзер',
    '`infra-discovery` + лестница **S** (автономность песочницы S0–S5)', '✅'],
  ['Генерация подходов по максимальному повторению в песочнице, ранжирование',
    '`solution-options` («ранжированные по песочнице»); уровень doctor держат 6 шагов: `solution-options` в `new-software` и 5 в `epic-delivery`', '✅'],
  ['Подход: не spec-driven, а environment/execution-driven',
    'назван **Sandbox-Driven Development (SbDD)**; сверка с OpenSpec, Spec Kit, Kiro/EARS, Shape Up и др.', '✅'],
  ['«В шаге всегда прототип следующего шага»',
    'явного механизма нет; частично — песочница до кода и мини-ресерч перед вопросами', '🟡'],
  ['Feature: use case → explore → propose → plan-declaration → sandboxing → apply → archive',
    '`feature`: все 7 есть; apply развёрнут в implement → verify-local → open-pr → ci-green → merged → deployed → verify-real → observe', '✅'],
  ['Plan-declaration: GitHub issue, «если учёный погибнет, соратники доведут»',
    '`plan-declaration` + уведомление владельцу', '✅'],
  ['Archive: requirements log + issue + user stories + LLM-сжатие лога сессии бесплатными моделями',
    '`archive`: статус требований — в issues (правило владельца 2026-09-28), закрытый issue, сжатая память о решениях; упоминаний `docs/requirements-log.md` в `playbooks-src` нет', '✅'],
  ['Debugging: контекст → повторение в песочнице → propose → apply → archive',
    '`debugging`: bug-context → reproduce → root-cause → propose-change → … → confirm-fixed → archive', '✅'],
  ['Лестница воспроизведения бага L0–L5', 'лестница **R**', '✅'],
  ['Ценность L0–L5, явно предупреждать о риске при низком уровне',
    'лестница **V** (V0–V5), правило «при V ≤ 1 явно сказать пользователю»', '✅'],
  ['Steps с конкретными блоками UI/API/CLI, EARS', '`define-use-case`: шаги в форме «КОГДА … ТОГДА …»', '✅'],
  ['Не мучить анкетой: сначала мини-ресерч в репо, сжатая версия репо',
    'под-шаг 1 в `define-use-case`; **сжатый индекс репо — не сделан** (открыто)', '🟡'],
  ['Explore: внутри репо для фикса, снаружи для новой фичи',
    '`explore-context` («как устроено сейчас и как делают другие»), правило repo_map-first закреплено тестом в CI', '✅'],
  ['Флаги сложности требований: прозрачный / зелёный / жёлтый / красный (права доступа) / неоднозначность',
    'флаги ⚪🟢🟡🔴⚫ + шаг `requirements-complexity` с челленджем', '✅'],
  ['Apply: ветки, имена, без конкуренции, git-менеджмент',
    '`implement` в изолированном workspace (`engineering_spawn_workspace`)', '✅'],
  ['Главная боль: агент не должен ждать «деплой закончился»',
    'durable wait движка: «PR смержен» — опрос каждые 5 мин до 24 ч без агента (смержено: trained-assist-agent#1611, 2026-09-27)', '✅'],
  ['Explore через Hermes-ноутбук',
    'авторинг плейбуков есть (`playbook_draft` / `playbook_edit`); полнота контракта для `wait`/`step_type` не подтверждена', '🟡'],
];

const MODEL_NOTES = [
  '**Master ≠ bachelor пока не выполняются.** Оба уровня идут на один и тот же профиль opencode `deepseek` (фолбэк — free-лестница; Claude/Codex для них запрещены — владелец 2026-09-29, #1899). «Думающие» шаги (use case, сложность, propose-change, root-cause) стоит развести с «делающими» (implement, sandbox): план — сильной моделью, выполнение — дешёвой (в opencode это профиль с разными моделями для агентов `plan` и `build`).',
  '**Doctor устроен иначе, чем предлагалось в первом обзоре:** с 2026-09-28 (#1689) он идёт Claude → Codex → opencode `doctor`; отдельная лестница внутри opencode живёт в llm-ladder (#1687). Второй по частоте уровень после master — 6 шагов.',
  '**Исследовательские шаги с 2026-10-01 идут через llm-ladder**, а не напрямую через Go-профиль (инцидент: недельный кап Go-подписки убил все research-шаги плана) — учитывать при разведении master/bachelor.',
  '**Сначала замер:** прогнать 10 прошлых шагов каждого «думающего» типа на deepseek-flash vs более сильной модели vs Claude, сравнить вслепую; только потом менять карту уровней.',
  '**Этот документ генерируется** `scripts/build-playbooks.js` вместе с `docs/playbooks/*.md`; `npm run check:playbooks` в CI не даёт ему устареть.',
];

function pluralRu(n, one, few, many) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function countSteps(built) {
  return built.stages.reduce((n, st) => n + st.steps.length, 0);
}

function levelCounts(built) {
  const counts = { bachelor: 0, master: 0, doctor: 0, programmatic: 0 };
  for (const st of built.stages) {
    for (const s of st.steps) {
      if (s.execution_kind === 'programmatic') counts.programmatic += 1;
      else counts[s.minimum_model_level] += 1;
    }
  }
  return counts;
}

function fmtTimeout(sec) {
  if (!sec) return '—';
  return sec % 3600 === 0 ? `${sec / 3600} ч` : `${Math.round(sec / 60)} мин`;
}

function fmtWait(wait) {
  const poll = Math.max(1, Math.round(wait.poll_every_sec / 60));
  const hours = Math.round((wait.timeout_sec / 3600) * 10) / 10;
  return `опрос каждые ${poll} мин, до ${hours} ч`;
}

function renderOverviewDoc(library, builtAll) {
  const versions = builtAll.map(b => `${b.id} v${b.version}`).join(' · ');
  const totalSteps = builtAll.reduce((n, b) => n + countSteps(b), 0);
  const totals = builtAll.reduce((acc, b) => {
    const c = levelCounts(b);
    for (const k of Object.keys(acc)) acc[k] += c[k];
    return acc;
  }, { bachelor: 0, master: 0, doctor: 0, programmatic: 0 });

  const lines = [
    '# Плейбуки разработки: обзор и сверка с черновиком владельца',
    '',
    '> Сгенерировано `scripts/build-playbooks.js` из `playbooks-src/*.json` и `library/step-types.json`.',
    '> Прави источники и генератор, не этот файл: `npm run build:playbooks`, свежесть держит `npm run check:playbooks` (гейт CI).',
    `> Сверка с ${OWNER_DRAFT}. Версии источников: ${versions}.`,
    '',
    '## Коротко',
    '',
    `- **${builtAll.length} ${pluralRu(builtAll.length, 'плейбук', 'плейбука', 'плейбуков')}**, ${totalSteps} ${pluralRu(totalSteps, 'шаг', 'шага', 'шагов')}: ${builtAll.map(b => `\`${b.id}\` (${countSteps(b)})`).join(', ')} — на библиотеке из ${Object.keys(library.types).length} типов шагов. У каждого типа есть роль, уровень модели, бюджет контекста, чек-лист под-шагов и критерий готовности.`,
    `- Распределение: bachelor ${totals.bachelor}, master ${totals.master}, doctor ${totals.doctor}, программных шагов ${totals.programmatic}.`,
    '- Уровни → движок (`trained-assist-agent/src/playbook-executor.js`, `DEFAULT_LEVEL_MAP`): bachelor и master → opencode, профиль `deepseek` (фолбэк — free-лестница, без Claude/Codex); doctor → Claude, при недоступности Codex → opencode `doctor`.',
    '',
    '## Сводка по плейбукам',
    '',
    '| Плейбук | Заголовок | Шагов | bachelor | master | doctor | программных |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const b of builtAll) {
    const c = levelCounts(b);
    lines.push(`| \`${b.id}\` | ${b.title} | ${countSteps(b)} | ${c.bachelor} | ${c.master} | ${c.doctor} | ${c.programmatic} |`);
  }

  lines.push('', '## Шаги', '');
  for (const b of builtAll) {
    lines.push(`### \`${b.id}\` — ${b.title} (${countSteps(b)} ${pluralRu(countSteps(b), 'шаг', 'шага', 'шагов')})`, '');
    lines.push('| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |',
      '|---|---|---|---|---|---|---|---|---|---|');
    let n = 0;
    for (const st of b.stages) {
      for (const s of st.steps) {
        n += 1;
        const agent = s.execution_kind === 'agent';
        const notify = (s.on_complete || []).some(a => a.type === 'notify');
        const tail = [s.wait ? fmtWait(s.wait) : '', notify ? 'уведомить владельца' : ''].filter(Boolean).join('; ');
        lines.push(`| ${n} | ${st.title} | ${s.title} | \`${s.step_type}\` | ${agent ? (ROLE_RU[s.executor_role] || s.executor_role) : 'код (без LLM)'} | ${agent ? LEVEL_MODEL[s.minimum_model_level] : '—'} | ${agent ? s.context_budget : '—'} | ${agent ? fmtTimeout(s.execution_timeout_seconds) : '—'} | \`${Object.keys(s.validation).join('`, `')}\` | ${tail} |`);
      }
    }
    lines.push('');
  }

  lines.push('## Сверка с черновиком владельца', '',
    '| Что просили | Где живёт сейчас | Статус |', '|---|---|---|');
  for (const [draft, impl, mark] of OWNER_MAPPING) lines.push(`| ${draft} | ${impl} | ${mark} |`);

  lines.push('', '## Выводы и предложения по моделям', '');
  MODEL_NOTES.forEach((note, i) => lines.push(`${i + 1}. ${note}`));
  return lines.join('\n');
}

function buildAll() {
  const library = loadLibrary();
  const sources = loadSources();
  const files = {};
  const builtAll = [];
  for (const src of sources) {
    const built = buildPlaybook(library, src);
    builtAll.push(built);
    files[path.join(OUT_DIR, `${built.id}.json`)] = `${JSON.stringify(built, null, 2)}\n`;
    files[path.join(DOCS_DIR, `${built.id}.md`)] = `${renderPlaybookDoc(library, src, built)}\n`;
  }
  files[path.join(DOCS_DIR, 'step-library.md')] = `${renderLibraryDoc(library, builtAll)}\n`;
  files[OVERVIEW_PATH] = `${renderOverviewDoc(library, builtAll)}\n`;
  return { library, sources, built: builtAll, files };
}

function main() {
  const check = process.argv.includes('--check');
  const { files } = buildAll();
  const stale = [];
  for (const [file, content] of Object.entries(files)) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === content) continue;
    if (check) { stale.push(path.relative(ROOT, file)); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
  if (check && stale.length) {
    console.error(`stale build output (run: npm run build:playbooks):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  if (check) console.log('playbooks build is up to date');
}

if (require.main === module) main();

module.exports = { buildAll, buildPlaybook, renderInstructions };
