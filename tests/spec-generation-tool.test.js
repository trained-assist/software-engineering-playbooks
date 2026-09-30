'use strict';

// Slice S2 (issue #43): the MCP module — registration through the real
// registry, plus a handler round-trip over a temporary context directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../src/mcp-skills/registry');

const EXPECTED = [
  'engineering_generate_spec',
  'engineering_get_spec',
  'engineering_generation_note',
  'engineering_generate_all',
  'engineering_spec_generation_defaults',
  'engineering_spec_generation_explained',
];

const cleanup = [];
const savedEnv = {};
for (const key of ['HOME', 'USER_ID']) savedEnv[key] = process.env[key];

test.after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function seedContext(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'facts.md'), '- факт один\n');
  fs.writeFileSync(path.join(dir, 'requirements.md'), '- Система должна принимать заявки.\n');
  fs.writeFileSync(path.join(dir, 'interpretation.md'), '- предположение\n');
  fs.writeFileSync(path.join(dir, 'solution.md'), '- PostgreSQL, очередь Redis\n');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources', 'dialog.md'), '> сырьё\n');
  fs.mkdirSync(path.join(dir, 'spec'), { recursive: true });
  return dir;
}

function call(name, args) { return registry.callTool(name, args); }

test('the six spec tools are registered by name, without collisions', () => {
  const names = registry.listAllTools().map(t => t.name);
  for (const name of EXPECTED) assert.ok(names.includes(name), `missing ${name}`);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  for (const name of EXPECTED) assert.ok(registry.listTools().some(t => t.name === name), `${name} must be exposed`);
});

test('generate_spec returns the instruction, the paths and the sources — never qna', async () => {
  const ctx = seedContext(tmp('spec-gen-'));
  const gen = await call('engineering_generate_spec', { context_dir: ctx });
  assert.deepEqual(gen.variants, ['long', 'short']);
  assert.equal(gen.style, 'oldschool');
  assert.ok(gen.instruction.length > 500);
  assert.ok(gen.spec_paths.long.endsWith(path.join('spec', 'long.md')));
  assert.ok(gen.spec_paths.short.endsWith(path.join('spec', 'short.md')));
  assert.ok(gen.spec_source_path.endsWith('_source.md'));
  assert.equal(gen.sources.facts, '- факт один\n');
  assert.ok(!('qna' in gen.sources), 'qna is not part of the sources');
  assert.ok(!JSON.stringify(gen).includes('qna.md'), 'no qna path leaks into the payload');
  assert.deepEqual(gen.raw_source_files, ['dialog.md'], 'raw sources are reported by name only');
  assert.ok(fs.existsSync(path.join(ctx, 'spec')), 'spec/ is created');
  assert.match(gen.instruction, /Стиль документа: oldschool/);
  await assert.rejects(
    () => call('engineering_generate_spec', { context_dir: ctx, style: 'vintage' }),
    /стил|style/i
  );
  await assert.rejects(() => call('engineering_generate_spec', {}), /context_dir/);
});

test('get_spec reads long/short and falls back to the legacy spec/tz.md', async () => {
  const ctx = seedContext(tmp('spec-get-'));
  const longPath = path.join(ctx, 'spec', 'long.md');
  fs.writeFileSync(longPath, '# ТЗ\n');
  const got = await call('engineering_get_spec', { context_dir: ctx, variant: 'long' });
  assert.equal(got.docs.long, '# ТЗ\n');
  assert.ok(got.instruction.length > 50);

  const legacyCtx = seedContext(tmp('spec-legacy-'));
  fs.writeFileSync(path.join(legacyCtx, 'spec', 'tz.md'), '# Legacy\n');
  const legacy = await call('engineering_get_spec', { context_dir: legacyCtx, variant: 'both' });
  assert.equal(legacy.docs.long, '# Legacy\n', 'read-compat with the old single-document pipeline');
});

test('generation_note appends, replaces and splits profile vs project scope', async () => {
  const home = tmp('spec-home-');
  process.env.HOME = home;
  process.env.USER_ID = 'spec-test';
  const ctx = seedContext(tmp('spec-note-'));

  await call('engineering_generation_note', { text: 'техничнее', context_dir: ctx, mode: 'append' });
  await call('engineering_generation_note', { text: 'без раздела X', context_dir: ctx, mode: 'append' });
  const projFile = path.join(ctx, 'spec', 'generation.md');
  assert.equal((fs.readFileSync(projFile, 'utf8').match(/^- /gm) || []).length, 2, 'append adds bullets');

  const replaced = await call('engineering_generation_note', { text: '  только короткие фразы  ', context_dir: ctx, mode: 'replace' });
  assert.equal(fs.readFileSync(projFile, 'utf8').trim(), 'только короткие фразы', 'replace overwrites without a list marker');
  assert.equal(replaced.saved, true);

  await call('engineering_generation_note', { text: 'профильная инструкция' });
  const profFile = path.join(home, 'agent-data', 'spec-generation', '_generation.md');
  assert.ok(fs.readFileSync(profFile, 'utf8').includes('профильная инструкция'), 'profile note lives in the profile, not the project');

  const gen = await call('engineering_generate_spec', { context_dir: ctx, variants: 'long' });
  assert.match(gen.generation_notes.project, /только короткие фразы/);
  assert.match(gen.generation_notes.profile, /профильная инструкция/);
  assert.match(gen.instruction, /Постоянные инструкции пользователя/);

  await assert.rejects(() => call('engineering_generation_note', { text: '   ' }), /text/);
});

test('generate_all scans the first level of the root for contexts in the window', async () => {
  const root = tmp('spec-batch-');
  const a = seedContext(path.join(root, 'alpha'));
  const b = seedContext(path.join(root, 'beta'));
  fs.writeFileSync(path.join(b, 'spec', 'long.md'), '# готово\n');
  fs.mkdirSync(path.join(root, 'not-a-context'));

  const all = await call('engineering_generate_all', { root, since: '6h' });
  assert.equal(all.projects.length, 2, 'both seeded contexts, nothing else');
  const dirs = all.projects.map(p => p.context_dir).sort();
  assert.deepEqual(dirs, [a, b].sort());
  for (const p of all.projects) assert.ok(p.spec_paths.long.endsWith('long.md'));
  assert.ok(all.instruction.length > 50);
  assert.equal(all.window.count, 2);
});

test('defaults and explained report the settings and the pipeline', async () => {
  const home = tmp('spec-home2-');
  process.env.HOME = home;
  const ctx = seedContext(tmp('spec-defs-'));
  const defs = await call('engineering_spec_generation_defaults', { context_dir: ctx });
  assert.ok(defs.text.length > 50);
  assert.match(JSON.stringify(defs), /_generation\.md|профиль|profile/i);
  assert.equal(defs.defaults.style, 'oldschool');
  assert.deepEqual(defs.defaults.styles, ['oldschool', 'modern']);

  const expl = await call('engineering_spec_generation_explained', {});
  assert.ok(expl.text.length > 50);
  assert.match(expl.text, /Как запускается и как проверяется/);
  assert.match(expl.text, /style/);
});
