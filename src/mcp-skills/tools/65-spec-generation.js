'use strict';

// Spec generation (ТЗ) — MCP module moved here from trained-assist-freelance-skill
// (Директива 3, voice 28.09.2026). The rules live in src/spec-generation/rules.js;
// this file only exposes them as tools and owns the filesystem layout.
//
// Layout (read-compat with the freelance projects: same `spec/` shape, so no
// data migration is needed — existing contexts are readable as they are):
//   <context_dir>/facts.md|requirements.md|interpretation.md|solution.md   stage files
//   <context_dir>/sources/*.md                                            raw sources (traceability)
//   <context_dir>/spec/_source.md   normalized context (STEP 1)
//   <context_dir>/spec/long.md      STEP 2, independent
//   <context_dir>/spec/short.md     STEP 2, independent
//   <context_dir>/spec/tz.md        legacy single-document pipeline (read-compat)
//   <context_dir>/spec/generation.md                        project-level standing notes
//   ~/agent-data/spec-generation/_generation.md              profile-level standing notes
//
// Tools: engineering_generate_spec | engineering_get_spec |
//        engineering_generation_note | engineering_generate_all |
//        engineering_spec_generation_defaults | engineering_spec_generation_explained
//
// Provenance and qna are deliberately NOT fed to generation: sources of the
// conversation stay traceability and never reach the text of the ТЗ.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SPEC_VARIANTS,
  DEFAULT_STYLE,
  buildSpecInstruction,
  normalizeStyle,
  normalizeVariants,
  STYLE_RULES,
} = require('../../spec-generation/rules');

const STAGE_FILES = ['facts.md', 'requirements.md', 'interpretation.md', 'solution.md'];

function contextDir(context_dir) {
  const d = String(context_dir || '').trim();
  if (!d) throw new Error('context_dir обязателен: каталог контекста проекта, где лежат facts.md и остальные stage-файлы.');
  return path.resolve(d);
}

function specDir(ctx) { return path.join(ctx, 'spec'); }
function specFile(ctx, variant) {
  if (!SPEC_VARIANTS.includes(variant)) throw new Error(`Unknown spec variant: ${variant}`);
  return path.join(specDir(ctx), `${variant}.md`);
}
function legacySpecFile(ctx) { return path.join(specDir(ctx), 'tz.md'); }
function specSourcePath(ctx) { return path.join(specDir(ctx), '_source.md'); }
function projectNotePath(ctx) { return path.join(specDir(ctx), 'generation.md'); }
function profileNotePath() {
  return path.join(process.env.HOME || os.homedir(), 'agent-data', 'spec-generation', '_generation.md');
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

function readStageFiles(ctx) {
  const sources = {};
  for (const f of STAGE_FILES) sources[f.replace(/\.md$/, '')] = readText(path.join(ctx, f));
  return sources;
}

// Raw sources exist as traceability only: their file NAMES are reported so the
// agent knows they are part of the context, but their content is never handed
// to the generator — that is what keeps «кто что сказал» out of the ТЗ.
function rawSourceNames(ctx) {
  const dir = path.join(ctx, 'sources');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  } catch { return []; }
}

function readNotes(ctx) {
  return {
    profile: readText(profileNotePath()).trim(),
    project: ctx ? readText(projectNotePath(ctx)).trim() : '',
  };
}

function writeGenerationNote(file, text, mode) {
  ensureDir(path.dirname(file));
  if (mode === 'replace') {
    fs.writeFileSync(file, String(text).trim() + '\n');
  } else {
    const prev = readText(file).trim();
    fs.writeFileSync(file, (prev ? prev + '\n' : '') + `- ${String(text).trim()}\n`);
  }
  return readText(file).trim();
}

// `since` accepts '30m' | '2h' | '6h' | '2d' | 'today'/'сегодня' |
// 'YYYY-MM-DD..YYYY-MM-DD'. Empty/missing → last 6 hours (batch default).
function parseSince(since) {
  const now = Date.now();
  const s = String(since || '').trim().toLowerCase();
  let m;
  if (!s) return { from: now - 6 * 3600e3, to: null, label: 'последние 6 часов' };
  if ((m = s.match(/^(\d+)\s*m/))) return { from: now - (+m[1]) * 60e3, to: null, label: `последние ${m[1]} мин` };
  if ((m = s.match(/^(\d+)\s*h/))) return { from: now - (+m[1]) * 3600e3, to: null, label: `последние ${m[1]} ч` };
  if ((m = s.match(/^(\d+)\s*d/))) return { from: now - (+m[1]) * 86400e3, to: null, label: `последние ${m[1]} сут` };
  if (s === 'today' || s === 'сегодня') { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: null, label: 'за сегодня' }; }
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/))) {
    return { from: Date.parse(`${m[1]}T00:00:00`), to: Date.parse(`${m[2]}T23:59:59`), label: `${m[1]}..${m[2]}` };
  }
  return { from: now - 6 * 3600e3, to: null, label: 'последние 6 часов', invalid: true };
}

function isProjectDir(dir) {
  if (fs.existsSync(path.join(dir, 'spec'))) return true;
  if (STAGE_FILES.some(f => fs.existsSync(path.join(dir, f)))) return true;
  return fs.existsSync(path.join(dir, 'sources'));
}

function lastMtime(dir) {
  let t = 0;
  try { t = fs.statSync(dir).mtimeMs; } catch { return t; }
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      try { const m = fs.statSync(path.join(dir, e.name)).mtimeMs; if (m > t) t = m; } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return t;
}

// Last change to this module's generation rules for the DEPLOYED revision. The
// rules ship with the code, so the current git commit is exactly what the
// generator was built from — surfacing it lets a user see «the prompt changed»
// without trusting the conversation. Best-effort: null without a git checkout.
function lastGenerationChange() {
  try {
    const { execFileSync } = require('child_process');
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const out = execFileSync('git', [
      '-C', repoRoot, 'log', '-1', '--format=%h|%cs|%s', '--',
      'src/spec-generation/rules.js', 'src/mcp-skills/tools/65-spec-generation.js',
    ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const [sha, date, subject] = out.split('|');
    return sha ? { sha, date, subject } : null;
  } catch {
    return null;
  }
}

function specPathsFor(ctx, want) {
  return Object.fromEntries(want.map(v => [v, specFile(ctx, v)]));
}

const generateSpec = {
  name: 'engineering_generate_spec',
  description: [
    'Подготовить генерацию ТЗ: возвращает нормализуемый контекст (facts/requirements/interpretation/solution), постоянные инструкции и пути.',
    'По умолчанию генерируются ДВА независимых документа — long.md и short.md (short НЕ является сжатием long: это самостоятельная версия из того же контекста).',
    'Файлы не пишет сама — формулировка ТЗ генеративна: модель сначала нормализует контекст в spec/_source.md, затем пишет каждый вариант по своему пути.',
    'Инструкция обязана содержать инженерную конкретику (инфраструктура, тестовый сервер, взаимодействия, шаги) и блок «Как запускается и как проверяется».',
    'style: "oldschool" (по умолчанию, новый ЧБ-олдскульный вид) | "modern" (прежний вид). Правила стиля — в коде.',
    'Провенанс и qna в генерацию НЕ подаются: источники общения остаются traceability и в текст ТЗ не попадают.',
    'variants: "both" (по умолчанию) | "long" | "short".',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['context_dir'],
    properties: {
      context_dir: { type: 'string', description: 'Каталог контекста проекта (stage-файлы facts/…; сюда же создаётся spec/)' },
      variants: { type: 'string', enum: ['both', 'long', 'short'], description: 'Какие версии генерировать (по умолчанию both)' },
      style: { type: 'string', enum: ['oldschool', 'modern'], description: 'Стиль документа (по умолчанию oldschool — новый)' },
    },
  },
  handler: async ({ context_dir, variants = 'both', style } = {}) => {
    const ctx = contextDir(context_dir);
    const want = normalizeVariants(variants);
    const st = normalizeStyle(style);
    const notes = readNotes(ctx);
    const paths = specPathsFor(ctx, want);
    const sourcePath = specSourcePath(ctx);
    ensureDir(specDir(ctx));
    return {
      context_dir: ctx,
      name: path.basename(ctx),
      variants: want,
      style: st,
      spec_source_path: sourcePath,
      spec_paths: paths,
      generation_notes: notes,
      sources: readStageFiles(ctx),
      raw_source_files: rawSourceNames(ctx),
      instruction: buildSpecInstruction({
        name: path.basename(ctx),
        variants: want,
        paths: { ...paths, _source: sourcePath },
        notes,
        style: st,
      }),
    };
  },
};

const getSpec = {
  name: 'engineering_get_spec',
  description: [
    'Вернуть текущий текст готового ТЗ (long/short) из spec/ для ТОЧЕЧНОГО РЕДАКТИРОВАНИЯ.',
    'Используй, когда просят изменить существующий документ (убери раздел, добавь, перепиши блок, сократи, измени только Short, обнови обе версии).',
    'Полученный текст правь и перезаписывай по тому же пути, НЕ перегенерируя документ с нуля и НЕ восстанавливая удалённое по шаблону.',
    'Legacy spec/tz.md читается как long (read-compat со старым одностраничным пайплайном).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['context_dir'],
    properties: {
      context_dir: { type: 'string' },
      variant: { type: 'string', enum: ['both', 'long', 'short'], description: 'Что вернуть (по умолчанию both)' },
    },
  },
  handler: async ({ context_dir, variant = 'both' } = {}) => {
    const ctx = contextDir(context_dir);
    const want = normalizeVariants(variant);
    const docs = {}; const paths = {};
    for (const v of want) {
      const p = specFile(ctx, v);
      let text = readText(p);
      if (!text && v === 'long') text = readText(legacySpecFile(ctx));
      docs[v] = text; paths[v] = p;
    }
    return {
      context_dir: ctx,
      docs,
      spec_paths: paths,
      instruction: 'Правь существующий текст по указанию пользователя и перезапиши его по ТОМУ ЖЕ пути через Write. ' +
        'Пользовательская правка имеет приоритет над шаблоном: если просят убрать раздел — не восстанавливай его. ' +
        'Соблюдай выбранный стиль документа и правила из src/spec-generation/rules.js. ' +
        'Не перегенерируй документ целиком без явной просьбы; не добавляй того, о чём не просили.',
    };
  },
};

const generationNote = {
  name: 'engineering_generation_note',
  description: [
    'Сохранить ПОСТОЯННУЮ инструкцию генерации ТЗ — она действует на все СЛЕДУЮЩИЕ генерации.',
    'Без context_dir — для всего профиля (~/agent-data/spec-generation/_generation.md); с context_dir — только для проекта (context_dir/spec/generation.md, приоритет выше профиля).',
    'Примеры: «всегда делай ТЗ техничнее», «никогда не писать „клиент сказал"», «не добавлять раздел X», «Short — максимально компактный».',
    'Это НЕ разовая правка конкретного документа — для разовой используй engineering_get_spec.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Инструкция пользователя' },
      context_dir: { type: 'string', description: 'Если задан — инструкция только для этого контекста' },
      mode: { type: 'string', enum: ['append', 'replace'], description: 'append (по умолчанию) добавляет пункт; replace перезаписывает' },
    },
  },
  handler: async ({ text, context_dir, mode = 'append' } = {}) => {
    if (text === undefined || text === null || !String(text).trim()) {
      throw new Error('text обязателен: постоянная инструкция генерации ТЗ.');
    }
    const ctx = context_dir ? contextDir(context_dir) : null;
    const file = ctx ? projectNotePath(ctx) : profileNotePath();
    const note = writeGenerationNote(file, text, mode);
    const scope = ctx ? path.basename(ctx) : 'profile';
    return { saved: true, scope, path: file, note, text: `Запомнил (${scope}):\n${note}` };
  },
};

const generateAll = {
  name: 'engineering_generate_all',
  description: [
    'Batch: собрать контексты за период (по умолчанию — за последние 6 часов) и подготовить генерацию ТЗ для каждого.',
    'Сканирует первый уровень root на подкаталоги с spec/ или stage-файлами; порядок ответа — сначала одной таблицей, затем по каждому контексту.',
    'variants применяется ко всем; для исключений вызови engineering_generate_spec отдельно по нужному каталогу.',
    'Другой период — повтори вызов с другим since.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Каталог, первый уровень которого сканируется на проекты' },
      since: { type: 'string', description: '6h (по умолчанию) | 2h | today | YYYY-MM-DD..YYYY-MM-DD' },
      variants: { type: 'string', enum: ['both', 'long', 'short'] },
      style: { type: 'string', enum: ['oldschool', 'modern'] },
    },
  },
  handler: async ({ root, since, variants = 'both', style } = {}) => {
    const w = parseSince(since);
    const to = w.to || Date.now() + 86400e3;
    const want = normalizeVariants(variants);
    const st = normalizeStyle(style);
    const base = path.resolve(String(root || '').trim() || '.');
    const projects = [];
    if (fs.existsSync(base)) {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(base, ent.name);
        if (!isProjectDir(dir)) continue;
        const ts = lastMtime(dir);
        if (ts < w.from || ts > to) continue;
        projects.push({
          name: ent.name,
          context_dir: dir,
          updatedAt: new Date(ts).toISOString(),
          spec_paths: specPathsFor(dir, want),
        });
      }
    }
    projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const label = w.invalid ? `${w.label} (период не распознан — по умолчанию)` : w.label;
    return {
      window: { since: since || null, label, from: new Date(w.from).toISOString(), to: w.to ? new Date(w.to).toISOString() : null, count: projects.length },
      variants: want,
      style: st,
      projects,
      message: `Взял контексты за ${label}. Если нужен другой период — скажи.`,
      instruction:
        `Сначала покажи одной таблицей ${projects.length} контекст(ов) за ${label}. ` +
        `Затем по каждому позови engineering_generate_spec (context_dir берётся из projects[].context_dir, style=${st}) и сгенерируй ${want.join(' + ')}: сначала нормализация в spec/_source.md, затем каждая версия независимо.`,
    };
  },
};

const specDefaults = {
  name: 'engineering_spec_generation_defaults',
  description: [
    'Показать текущие настройки/дефолты генерации ТЗ: формат, версии, стиль по умолчанию, нормализацию,',
    'постоянные инструкции профиля и контекста и последнее изменение правил генерации.',
    'Команда только для чтения — ничего не меняет.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { context_dir: { type: 'string' } },
  },
  handler: async ({ context_dir } = {}) => {
    const ctx = context_dir ? contextDir(context_dir) : null;
    const notes = readNotes(ctx);
    const lc = lastGenerationChange();
    const text = [
      'Настройки генерации ТЗ (текущее)',
      '',
      '• Формат: только markdown (.md)',
      '• Версии: long + short по каждому контексту (независимо; short — не сжатие long)',
      `• Стиль по умолчанию: ${DEFAULT_STYLE} (новый ЧБ-олдскульный вид); прежний вид — style=modern`,
      '• Нормализация: контекст → spec/_source.md (атомарные требования R-01…)',
      '• Batch: окно по умолчанию 6 часов',
      '• Содержание: инженерная конкретика + блок «Как запускается и как проверяется» — для ОБЕИХ версий',
      '• В ТЗ запрещено: «клиент сказал», хронология, провенанс, мета-разделы, разделы-источники',
      '• Доступные стили: ' + Object.keys(STYLE_RULES).join(', '),
      '',
      'Постоянные инструкции пользователя:',
      `• профиль: ${notes.profile || '(нет)'}`,
      `• проект: ${notes.project || '(нет)'}`,
      '',
      lc ? `Последнее изменение правил генерации: ${lc.sha} (${lc.date}) — ${lc.subject}` : 'Последнее изменение правил: нет данных (не git-чек).',
    ].join('\n');
    return {
      defaults: {
        output_format: 'только markdown (.md)',
        variants: 'long + short по каждому контексту',
        independence: 'long и short генерируются независимо (short — не сжатие long)',
        style: DEFAULT_STYLE,
        styles: Object.keys(STYLE_RULES),
        content: 'инженерная конкретика + sandbox-блок, для всех вариантов',
        normalization: 'source → spec/_source.md',
        batch_window: 'по умолчанию 6 часов',
        forbidden_in_spec: '«клиент сказал», хронология, провенанс, мета-разделы',
      },
      notes,
      last_change: lc,
      paths: { profile: profileNotePath(), project: ctx ? projectNotePath(ctx) : null },
      text,
    };
  },
};

const specExplained = {
  name: 'engineering_spec_generation_explained',
  description: 'Объяснить, как работает генерация ТЗ: пайплайн, нормализация, независимые long/short, инженерная конкретика, sandbox-блок, стили, постоянные инструкции, точечные правки и batch.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const lc = lastGenerationChange();
    const text = [
      'Как работает генерация ТЗ',
      '',
      '1. Источники (диалог, файлы, скриншоты) → provenance: это traceability, в текст ТЗ не попадает.',
      '2. Facts / requirements / interpretation / solution → атомарные требования «Система должна …».',
      '3. Нормализация → spec/_source.md: единый вход для обеих версий.',
      '4. Генерация: long.md (для исполнителя) и short.md (для заказчика) — НЕЗАВИСИМО из одного контекста; short — не сжатие long.',
      '5. Содержание обязательно для ОБЕИХ версий: инфраструктура, тестовый сервер и порт, взаимодействие частей (кто с кем и по какому протоколу), шаги «что именно делается», и блок «Как запускается и как проверяется» (long) / «Как проверяем» (short).',
      `6. Стиль — отдельный параметр: по умолчанию ${DEFAULT_STYLE} (новый ЧБ-олдскульный вид), прежний вид — style=modern. Правила стиля лежат в коде.`,
      '7. В ТЗ нет «клиент сказал», хронологии, провенанса и мета-разделов; неподтверждённое — в «Открытые вопросы».',
      '',
      'Постоянные инструкции (действуют на все следующие генерации):',
      '• профиль → ~/agent-data/spec-generation/_generation.md',
      '• проект → <context_dir>/spec/generation.md (приоритет выше)',
      'Добавить: скажи боту словами («запомни: всегда делай ТЗ техничнее») или вызови engineering_generation_note.',
      '',
      'Точечные правки (убери раздел, сократи, измени только Short) — engineering_get_spec правит существующий long.md/short.md, без перегенерации.',
      'Batch («сделай все контексты») — engineering_generate_all, окно по умолчанию 6 часов + таблица.',
      '',
      'Стоимость/сложность в генераторе НЕ считается: если в контексте уже есть готовый расчёт — используй его вторично (раздел «Стоимость и сроки»), сам движок не вызывай.',
      'Правила генерации версионируются в репозитории и собираются при деплое (CI/CD), поэтому изменения видны как diff.',
      lc ? `Последнее изменение правил: ${lc.sha} (${lc.date}) — ${lc.subject}` : 'Последнее изменение правил: нет данных (не git-чек).',
    ].join('\n');
    return { explanation: text, last_change: lc, text };
  },
};

module.exports = [generateSpec, getSpec, generationNote, generateAll, specDefaults, specExplained];
