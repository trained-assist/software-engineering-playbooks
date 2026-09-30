'use strict';

// Spec (ТЗ) generation — the rule core: voice + content + style.
//
// Ported from trained-assist-freelance-skill (`10-freelance-project.js`:
// `SPEC_VOICE_RULES` / `buildSpecInstruction()`) and extended per Директива 2.В
// (voice, 28.09.2026):
//   - CONTENT_RULES — engineering concreteness and the SbDD run/verify block,
//     applied to EVERY variant, long and short alike (R5/R6/R8);
//   - STYLE_RULES — style is a switchable parameter, default = `oldschool`
//     (the new anti-AI black-and-white look); the previous look stays available
//     as `style: 'modern'` (R7).
//
// The rules live in code (visible as a git diff), never in chat. They are the
// executable form of the directive: scripts/sandbox/spec-generation.mjs asserts
// the canonical strings below verbatim — see docs/spec-generation-migration.md.
//
// Integration point with the complexity engine (R10): this module does NOT
// compute complexity. When a context already carries a complexity/price estimate
// (parallel plan, `src/complexity/`), reuse it secondarily in the spec
// («Стоимость и сроки»), never re-derive it here.

const SPEC_VARIANTS = ['long', 'short'];
const DEFAULT_STYLE = 'oldschool';

// Turns the output into a specification about the SYSTEM, not a recap of the
// client conversation. Verbatim from the freelance skill: normalize the source
// first, and state the ban explicitly on every axis.
const SPEC_VOICE_RULES = [
  'Голос документа — техническое задание о СИСТЕМЕ, а не конспект общения с заказчиком.',
  'ТЗ — это НЕ конспект созвона или переписки. В документе НЕ должно быть «кто что сказал»: дословных цитат, транскриптов голосовых, фраз «ответы заказчика», «правки заказчика/медиков», дат разговоров, конспектов переписки.',
  'ЗАПРЕЩЕНЫ разделы-источники: «Input Info», «Источники», «Исходные материалы», «История обсуждения», «Конспект переписки» и любые приложения с цитатами/транскриптами. После содержательной части ТЗ (критерии приёмки/коммерческие условия) НИЧЕГО не добавляй.',
  'ЗАПРЕЩЕНО: «клиент сказал/подтвердил/уточнил/прислал», «заказчик хочет», «из разговора следует», хронология обсуждения, ссылки на провенанс/ID источников (P-001, R-04 и т.п.), мета-разделы вида «почему это здесь», «наши допущения и их основания», «что нужно подтвердить у клиента».',
  'Любой важный факт из обсуждения переформулируй как требование/ограничение к системе БЕЗ указания источника; сама атрибуция («кто, когда, что прислал») остаётся в provenance и в текст ТЗ не переносится.',
  'Требования формулируй в утвердительной форме о системе: «Система должна …», «Реализовать …».',
  'Неподтверждённое требование выноси коротким пунктом в раздел «Открытые вопросы»; НЕ пиши «нужно подтвердить у клиента» внутри требований.',
  'Не выдумывай факты, числа, сроки, интеграции — только то, что есть в предоставленном контексте.',
].join('\n');

// Engineering concreteness (Директива 2.В.1) — same for every variant.
const CONTENT_RULES = [
  'Инженерная конкретика (обязательно и для long, и для short):',
  '- Укажи, какая инфраструктура поднимается: сервисы и их назначение, СУБД, очереди, кэш, где всё развёртывается (хостинг/контур заказчика). Не подменяй конкретику общими словами вроде «сервис будет работать».',
  '- Укажи тестовый сервер или тестовое окружение: адрес (например, localhost), порт, какие данные и фикстуры нужны для запуска, кто это окружение поднимает.',
  '- Опиши взаимодействие частей: кто с кем общается и по какому протоколу или очереди (HTTP/REST, WebSocket, шина/очередь сообщений), какие данные идут по каждому каналу и кто их инициирует.',
  '- Распиши по шагам, что именно делается: порядок действий от входа до результата, какой вызов за каким идёт, без абстрактных «реализуется функционал».',
  '- Требования и ограничения формулируй в утвердительной форме о системе: «Система должна …».',
].join('\n');

// The SbDD block (Директива 2.В.2). `long` gets the full section; `short` a
// one-to-three-line «Как проверяем» — both are emitted per requested variant
// (R8: content reaches every variant).
const SBD_LONG = '- long: обязателен раздел «Как запускается и как проверяется» — команды поднятия окружения (npm / node / docker / curl и т.п.), нужные данные и фикстуры, тестовый сервер и его порт, наблюдаемый сигнал замкнутой петли (что именно увидим, когда всё работает), уровень автономности S0–S5 и что в этой петле делает человек.';
const SBD_SHORT = '- short: краткий пункт «Как проверяем» — 1–3 строки: команда запуска (npm / node / docker / curl) и признак того, что проверка прошла.';
const SBD_LADDER = '- Уровни автономности: S0 — нет исполнения; S1 — статический анализ; S2 — код запускается частично; S3 — автотесты с моками; S4 — стейджинг с реальными зависимостями; S5 — полный замкнутый цикл без человека. Укажи, к какому уровню стремится этот план и где граница, за которой нужен человек.';

// Style layer (Директива 2.В.3 / R7). Default = the new oldschool look; the
// previous appearance stays available as `modern`. Unknown style is an error,
// never a silent fallback.
const STYLE_RULES = {
  oldschool: [
    'Строго чёрно-белый текст, без эмодзи, без цвета и декора.',
    'Простые заголовки: нумерация «1.», «1.1» или обычные «##» без оформления.',
    'Без вводных лид-абзацев и «красивых» обложек — документ начинается сразу с предмета.',
    'Без маркетинговых оборотов и штампов; короткие фразы, конкретные факты.',
    'Таблицы — только простые, если без таблицы не обойтись; никаких вложенных списков ради красоты.',
  ].join('\n'),
  modern: [
    'Аккуратная markdown-вёрстка без ограничений oldschool: допустимы акценты, списки любой вложенности, таблицы и оформление, принятое в проекте.',
  ].join('\n'),
};

const SBD_RULES = { long: SBD_LONG, short: SBD_SHORT, ladder: SBD_LADDER };

function normalizeStyle(style) {
  if (style === undefined || style === null || style === '') return DEFAULT_STYLE;
  if (!Object.prototype.hasOwnProperty.call(STYLE_RULES, style)) {
    throw new Error(
      `Неизвестный стиль документа: «${style}». Допустимые style: ${Object.keys(STYLE_RULES).join(', ')}.`
    );
  }
  return style;
}

function normalizeVariants(variants) {
  if (variants === undefined || variants === null || variants === '' || variants === 'both') return [...SPEC_VARIANTS];
  if (Array.isArray(variants)) {
    const want = variants.filter(v => SPEC_VARIANTS.includes(v));
    if (!want.length || want.length !== new Set(variants).size) {
      throw new Error(`Неизвестные variants: ${JSON.stringify(variants)}. Допустимые: both, long, short.`);
    }
    return [...new Set(want)];
  }
  if (SPEC_VARIANTS.includes(variants)) return [variants];
  throw new Error(`Неизвестные variants: «${variants}». Допустимые: both, long, short.`);
}

// Same two-step architecture as the freelance skill: STEP 1 normalize the source
// into spec/_source.md, STEP 2 generate each requested document independently.
// Voice + content apply to the whole instruction; style is its own layer.
function buildSpecInstruction({ name, variants, paths = {}, notes = {}, style } = {}) {
  const want = normalizeVariants(variants);
  const st = normalizeStyle(style);
  const title = name || 'проект';
  const sourcePath = paths._source || 'spec/_source.md';
  const lines = [];

  lines.push(`Сгенерируй ТЗ для проекта «${title}» (${want.join(' + ')}).`);
  lines.push(`Стиль документа: ${st}`);
  lines.push('');
  lines.push(`ШАГ 1 — нормализация (обязательно). По источникам ниже запиши в ${sourcePath} нормализованный рабочий контекст: атомарные требования (пронумеруй R-01, R-02…, в утвердительной форме о системе), факты о системе и ограничения, техническое решение. В нормализацию НЕ переноси хронологию общения, «клиент сказал», пересказ переписки и обоснования-провенанс — они остаются только в provenance как traceability.`);
  lines.push('');
  lines.push('ШАГ 2 — генерация. Каждый запрошенный документ генерируй НЕЗАВИСИМО из нормализованного контекста (spec/_source.md). Long и Short — самостоятельные версии из одного контекста, а НЕ «short = сжатие long»: подача и акценты могут отличаться.');
  lines.push('');
  lines.push('Правила документа (обязательно):');
  lines.push(SPEC_VOICE_RULES);
  lines.push('');
  lines.push(CONTENT_RULES);

  if (want.length) {
    lines.push('');
    lines.push('Блок запуска и проверки (sandbox-driven development):');
    if (want.includes('long')) lines.push(SBD_LONG);
    if (want.includes('short')) lines.push(SBD_SHORT);
    if (want.includes('long')) lines.push(SBD_LADDER);
  }

  lines.push('');
  lines.push(`Правила стиля «${st}»:`);
  lines.push(STYLE_RULES[st]);
  lines.push('');
  lines.push('КРИТИЧНО: документ заканчивается содержательной частью ТЗ (критерии приёмки, коммерческие условия). Никакого раздела «Input Info / Источники / Исходные материалы», никаких транскриптов, цитат и «кто что сказал» — ни в начале, ни в конце.');
  lines.push('');
  lines.push('Варианты:');
  lines.push('- long — подробное ТЗ для исполнителя: цель, объём, функциональные и нефункциональные требования, инфраструктура и взаимодействия, этапы, сроки, критерии приёмки, блок «Как запускается и как проверяется».');
  lines.push('- short — самостоятельное краткое ТЗ для заказчика: проблема, объём, сроки, цена, ключевые риски, результат, пункт «Как проверяем»; без архитектурных деталей и без «конспекта» long.');
  lines.push('');
  lines.push('Куда писать (markdown, только эти пути, без преамбул от себя):');
  for (const v of want) lines.push(`- ${v}: ${paths[v] || `<spec>/${v}.md`}`);

  if (notes.profile || notes.project) {
    lines.push('');
    lines.push('Постоянные инструкции пользователя (приоритет над шаблоном):');
    if (notes.profile) lines.push(`[профиль] ${notes.profile}`);
    if (notes.project) lines.push(`[проект] ${notes.project}`);
  }
  return lines.join('\n');
}

module.exports = {
  SBD_RULES,
  SPEC_VARIANTS,
  DEFAULT_STYLE,
  SPEC_VOICE_RULES,
  CONTENT_RULES,
  STYLE_RULES,
  normalizeStyle,
  normalizeVariants,
  buildSpecInstruction,
};
