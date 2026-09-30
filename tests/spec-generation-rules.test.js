'use strict';

// Slice S1 (issue #43, Директива 2.В): the rule core of spec generation.
// Deterministic contract of buildSpecInstruction() — the same markers the
// sandbox asserts (scripts/sandbox/spec-generation.mjs), so a regression here
// is caught by `npm test` without booting the loop.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SPEC_VARIANTS,
  DEFAULT_STYLE,
  SPEC_VOICE_RULES,
  CONTENT_RULES,
  SBD_RULES,
  STYLE_RULES,
  normalizeStyle,
  normalizeVariants,
  buildSpecInstruction,
} = require('../src/spec-generation/rules');

const PATHS = {
  long: '/ctx/spec/long.md',
  short: '/ctx/spec/short.md',
  _source: '/ctx/spec/_source.md',
};

const VOICE_MARKERS = [
  'Голос документа — техническое задание о СИСТЕМЕ',
  'ТЗ — это НЕ конспект созвона или переписки',
  'Не выдумывай факты, числа, сроки, интеграции',
];
const CONTENT_MARKERS = [
  [/инфраструктур/i, 'инфраструктура'],
  [/тестов\w*\s+(?:сервер|стенд|окружение)|localhost|:\d{2,5}|порт/i, 'тестовый сервер/окружение и порт'],
  [/взаимодейств|протокол|кто с кем/i, 'взаимодействие частей'],
  [/(?:по шагам|что именно делается)/i, 'шаги «что именно делается»'],
];
const SBD_MARKERS = [
  [/Как запускается и как проверяется/, 'sandbox-заголовок'],
  [/S0[\s\S]{0,400}S5|S0–S5|S0-S5/i, 'лестница S0–S5'],
  [/команд/i, 'команды запуска'],
];

function build(overrides = {}) {
  return buildSpecInstruction({
    name: 'Учёт заявок',
    variants: ['long', 'short'],
    paths: PATHS,
    notes: {},
    ...overrides,
  });
}

test('voice rules are carried over verbatim from the freelance skill', () => {
  for (const marker of VOICE_MARKERS) assert.ok(SPEC_VOICE_RULES.includes(marker), marker);
  assert.ok(SPEC_VOICE_RULES.split('\n').length >= 8, 'the whole rule list is kept, not a summary');
});

test('content rules: engineering concreteness + sandbox block for every variant', () => {
  for (const [re, label] of CONTENT_MARKERS) {
    assert.ok(re.test(CONTENT_RULES), `CONTENT_RULES must cover ${label}`);
    assert.ok(re.test(build({ variants: ['long'] })), `long must carry ${label}`);
    assert.ok(re.test(build({ variants: ['short'] })), `short must carry ${label}`);
  }
  const sbd = Object.values(SBD_RULES).join('\n');
  for (const [re, label] of SBD_MARKERS) {
    assert.ok(re.test(sbd), `SBD rules must cover ${label}`);
    assert.ok(re.test(CONTENT_RULES) || re.test(sbd), `content+sandbox must cover ${label}`);
    assert.ok(re.test(build({ variants: ['long'] })), `long must carry ${label}`);
  }
  assert.match(build({ variants: ['short'] }), /Как проверяем/, 'short gets the «Как проверяем» item');
  assert.match(build({ variants: ['long'] }), /Как запускается и как проверяется/, 'long gets the full section');
  assert.match(build(), /Система должна/, 'requirements stay in the affirmative form');
});

test('style is a switchable parameter: default oldschool, modern available, unknown throws', () => {
  assert.equal(DEFAULT_STYLE, 'oldschool');
  assert.deepEqual(SPEC_VARIANTS, ['long', 'short']);
  assert.ok(Object.keys(STYLE_RULES).join(',') === 'oldschool,modern', 'both styles are in the code');

  const def = build();
  assert.match(def, /Стиль документа: oldschool/);
  assert.ok(/без эмодзи/.test(STYLE_RULES.oldschool), 'oldschool bans emoji');

  const modern = build({ style: 'modern' });
  assert.match(modern, /Стиль документа: modern/);
  assert.doesNotMatch(modern, /Стиль документа: oldschool/);
  assert.notEqual(modern, def, 'the two styles produce different instructions');

  assert.equal(normalizeStyle(undefined), 'oldschool');
  assert.equal(normalizeStyle(''), 'oldschool');
  assert.equal(normalizeStyle('modern'), 'modern');
  assert.throws(() => normalizeStyle('vintage'), /стил|style/i);
  assert.throws(() => build({ style: 'vintage' }), /стил|style/i);
});

test('unknown variants are an error, never a silent fallback', () => {
  assert.deepEqual(normalizeVariants('both'), ['long', 'short']);
  assert.deepEqual(normalizeVariants('short'), ['short']);
  assert.deepEqual(normalizeVariants(undefined), ['long', 'short']);
  assert.throws(() => normalizeVariants('medium'), /variants/);
  assert.throws(() => build({ variants: 'medium' }), /variants/);
});

test('standing notes are appended to the instruction only when present', () => {
  assert.doesNotMatch(build(), /Постоянные инструкции пользователя/);
  const withNotes = build({ notes: { profile: 'всегда техничнее', project: 'без раздела X' } });
  assert.match(withNotes, /Постоянные инструкции пользователя/);
  assert.match(withNotes, /\[профиль\] всегда техничнее/);
  assert.match(withNotes, /\[проект\] без раздела X/);
});

test('the instruction names every requested output path and the normalization target', () => {
  const text = build();
  assert.ok(text.includes(PATHS.long) && text.includes(PATHS.short), 'both output paths');
  assert.ok(text.includes(PATHS._source), 'normalization path');
  assert.match(text, /ШАГ 1 — нормализация/);
  assert.match(text, /ШАГ 2 — генерация/);
  assert.ok(!text.includes('qna'), 'qna/provenance is never fed to generation');
});
