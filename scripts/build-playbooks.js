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

const STEP_OVERRIDES = ['title', 'validation', 'executor_role', 'minimum_model_level', 'context_budget',
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
  for (const key of ['delay_after_sec', 'max_attempts', 'execution_timeout_seconds', 'wait', 'on_complete', 'on_fail']) {
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
  if (step.execution_kind === 'programmatic') {
    return `программно${step.wait ? `, ждёт (опрос ${step.wait.poll_every_sec / 60} мин, таймаут ${Math.round(step.wait.timeout_sec / 3600)} ч)` : ''}`;
  }
  return `${step.executor_role} · ${step.minimum_model_level} (${levelNote(step)}) · ${step.context_budget}`;
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
