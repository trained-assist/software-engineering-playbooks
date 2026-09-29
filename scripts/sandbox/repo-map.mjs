#!/usr/bin/env node
// Sandbox loop for repo_map L0/L1 (issue #49) — one command, deterministic PASS/FAIL.
//
// Scenario (docs/user-scenarios/engineering/repo-map-fast-discovery.md):
//   2. Новый sha main после мержа → ленивая достройка при первом обращении.
//   3. repo_map(repo, level: 0) → карта ≤ 2k токенов с честной шапкой (sha,
//      что опущено, как получить L1), ответ из кеша < 1 с.
//   4. repo_map(repo, level: 1, focus) → скелет: сигнатуры (в т.ч. CJS-экспорт
//      и методы классов), focus-файлы наверху, повтор = байт-в-байт.
//   6. Правило «сначала repo_map» в плейбуках feature/debugging + промпт-домен.
//   1. Спавн строит карту в фоне (kill-switch) — в песочнице статически;
//      динамика хука — tests/workspace.test.js (срез 7).
//   Крайние случаи: нет ключа LLM → структура без описаний; чужой sha → не
//   отдаётся; ответ никогда не пустой (#1481).
//
// КОНТРАКТ для шага implement (реализация обязана ему соответствовать):
//   require('../src/repo-map') → {
//     buildMap({ repoPath, workspacesRoot }) → Promise<{ status: 'built'|'exists', sha, dir }>,
//     renderMap({ repoPath, workspacesRoot, level, focus?, sha? })
//       → Promise<{ status: 'ready'|'missing'|'failed', text, sha }>,  // text не пустой всегда
//     mapStatus({ repoPath, workspacesRoot }) → { status, sha, dir },   // синхронный
//   }
//   Асинхронность обязательна: LLM-описания для L0 собираются через fetch,
//   а await в синхронном коде невозможен — поэтому три первых метода
//   возвращают промис (mapStatus остаётся синхронным: он ничего не строит).
//   Кеш: <workspacesRoot>/repo-maps/<repoId>/<sha>/ (вне worktree).
//   LLM: src/repo-map/llm.js зовёт ГЛОБАЛЬНЫЙ fetch к OpenRouter
//   POST https://openrouter.ai/api/v1/chat/completions и читает
//   choices[0].message.content; ключ process.env.OPENROUTER_API_KEY;
//   без ключа / при ошибке → L0 собирается без описаний (L1 не зависит от LLM).
//   Тул: src/mcp-skills/tools/35-repo-map.js, имя /repo_map$/,
//   аргументы { repo | repo_path, level, focus }, есть в provider-manifest.json.
//
// Внешние зависимости замоканы: fetch подменён стабом (сеть недоступна вообще),
// LLM-ключом песочница управляет сама, кеш — во временной папке.
//
// Run:  node scripts/sandbox/repo-map.mjs   (npm run sandbox:repo-map)
// Level: S5 — фикстура-репо, реальные модули, мок LLM, полный цикл за ~10–30 с.
// Первый запуск ДО реализации падает: «модуль src/repo-map отсутствует».

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const failures = [];
const log = (...a) => console.log('[sandbox]', ...a);
function check(cond, msg) {
  if (cond) console.log('   ok  -', msg);
  else { failures.push(msg); console.log('   FAIL-', msg); }
}
function skipDependent(msg) {
  failures.push(msg);
  console.log('   SKIP-', msg, '(зависимый шаг: модуля нет)');
}

// Conservative deterministic estimator: <= real tokenizer output for RU+code.
const estTokens = (text) => Math.ceil(text.length / 3);

// ── network guard: no real fetch ever happens in this sandbox ──────────────
let fetchCalls = 0;
const MOCK_DESCRIPTION = 'mock module description';
globalThis.fetch = async () => {
  fetchCalls += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: MOCK_DESCRIPTION } }],
    }),
  };
};

function git(dir, args) {
  return execFileSync('git', ['-c', 'user.name=sandbox', '-c', 'user.email=sandbox@local',
    '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixtureRepo(root) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'fixture-')));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write('package.json', JSON.stringify({ name: 'sandbox-fixture', version: '1.0.0', main: 'src/server.js' }, null, 2) + '\n');
  write('src/server.js', `'use strict';
class Server {
  constructor(port) { this.port = port; }
  start() { return 'listening :' + this.port; }
}
module.exports = { Server };
`);
  write('src/router.js', `'use strict';
const { Server } = require('./server');
function routeTask(task) { return task && task.id ? task.id : null; }
const formatTask = (task) => 'task:' + task.id;
function bootServer(port) { const s = new Server(port); return s.start(); }
module.exports = { routeTask, formatTask, bootServer };
`);
  write('tests/router.test.js', `'use strict';
const { routeTask } = require('../src/router');
test('route', () => { routeTask({ id: 1 }); });
`);
  write('docs/arch.md', '# Architecture\n\nrouter dispatches tasks to server.\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture v1']);
  const sha1 = git(dir, ['rev-parse', 'HEAD']);

  // Second commit is NOT created here: scenario step 2 needs a map that is
  // first built at sha1 and then invalidated by a new commit, so the bump
  // happens right before the invalidation section.
  const bump = () => {
    write('src/new-feature.js', `'use strict';
function newFeature(flag) { return flag ? 'on' : 'off'; }
module.exports = { newFeature };
`);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'fixture v2']);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  return { dir, sha1, bump };
}

// Fresh require of everything under src/ (LLM key is read at load time).
function reloadSrc() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(REPO, 'src') + path.sep)) delete require.cache[key];
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-sandbox-'));
  const workspacesRoot = path.join(root, 'workspaces');
  fs.mkdirSync(workspacesRoot, { recursive: true });
  const fixture = makeFixtureRepo(root);
  log(`fixture: ${path.basename(fixture.dir)}, sha1=${fixture.sha1.slice(0, 8)} (второй коммит создаётся в фазе инвалидации)`);

  delete process.env.OPENROUTER_API_KEY;
  const started = Date.now();

  // ── 1. Module exists (the right failure reason before implementation) ────
  let repoMap = null;
  try {
    repoMap = require(path.join(REPO, 'src', 'repo-map'));
    check(true, 'модуль src/repo-map загружается');
  } catch (e) {
    check(false, `модуль src/repo-map отсутствует (фича ещё не реализована): ${e.message.split('\n')[0]}`);
  }
  const hasApi = Boolean(repoMap && typeof repoMap.buildMap === 'function'
    && typeof repoMap.renderMap === 'function' && typeof repoMap.mapStatus === 'function');
  if (repoMap) check(hasApi, 'API: buildMap / renderMap / mapStatus экспортированы');

  // ── 2–3. Build + L0 without LLM key (degradation path) ───────────────────
  let sha1 = null;
  if (hasApi) {
    let built;
    try {
      built = await repoMap.buildMap({ repoPath: fixture.dir, workspacesRoot });
      check(built && built.status === 'built', `buildMap: статус built (получено ${built && built.status})`);
      sha1 = built && built.sha;
      check(sha1 === fixture.sha1, `buildMap: sha совпадает с HEAD (${sha1 && sha1.slice(0, 8)})`);
      const dir = path.join(workspacesRoot, 'repo-maps');
      check(fs.existsSync(dir), 'кеш лежит в <workspacesRoot>/repo-maps/ (вне worktree)');
      check(!fs.existsSync(path.join(fixture.dir, '.engineering', 'repo-maps')), 'worktree не засорён кешем карт');
    } catch (e) {
      check(false, `buildMap упал: ${e.message.split('\n')[0]}`);
    }

    try {
      const r = await repoMap.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0 });
      const text = (r && r.text) || '';
      check(r && r.status === 'ready', `L0 без ключа: status=ready (получено ${r && r.status})`);
      check(text.trim().length > 0, 'L0 без ключа: ответ не пустой');
      check(fetchCalls === 0, `LLM не вызывалась без ключа (вызовов: ${fetchCalls})`);
      check(!text.includes(MOCK_DESCRIPTION), 'L0 без ключа: описаний LLM нет (структура)');
      if (text) {
        const head = text.split('\n').slice(0, 15).join('\n');
        check(estTokens(text) <= 2000, `L0 бюджет: ≤ 2k токенов (${estTokens(text)} по оценке)`);
        check(head.includes(fixture.sha1.slice(0, 8)), 'L0 шапка: содержит sha');
        check(/опущено/i.test(head), 'L0 шапка: честно указано, что опущено');
        check(/L1|скелет/i.test(head), 'L0 шапка: сказано, как получить L1');
        check(/router/i.test(text) && /server/i.test(text), 'L0: видны модули router/server');
        check(/test/i.test(text) && /docs/i.test(text), 'L0: указаны, где тесты и где доки');
      } else {
        check(false, 'L0: текст пуст — шапку/бюджет проверить не удалось');
      }
    } catch (e) {
      check(false, `renderMap(L0) упал: ${e.message.split('\n')[0]}`);
    }
  } else {
    skipDependent('L0 (без ключа): нет модуля');
  }

  // ── 4. With a (fake) key: descriptions via mocked fetch, then cached ─────
  if (hasApi) {
    process.env.OPENROUTER_API_KEY = 'sk-sandbox-fake';
    fetchCalls = 0;
    fs.rmSync(path.join(workspacesRoot, 'repo-maps'), { recursive: true, force: true });
    reloadSrc();
    const mod = require(path.join(REPO, 'src', 'repo-map'));
    try {
      await mod.buildMap({ repoPath: fixture.dir, workspacesRoot });
      check(fetchCalls > 0, `с ключом: LLM вызвана через fetch (вызовов: ${fetchCalls})`);
      const l0 = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0 });
      check(String((l0 && l0.text) || '').includes(MOCK_DESCRIPTION), 'L0 с ключом: описания LLM в карте');

      const before = fetchCalls;
      const again = await mod.buildMap({ repoPath: fixture.dir, workspacesRoot });
      check(again && again.status === 'exists', `повторная сборка того же sha: status=exists (${again && again.status})`);
      check(fetchCalls === before, `кеш описаний: повторная сборка без LLM-вызовов (${fetchCalls - before})`);
    } catch (e) {
      check(false, `фаза LLM-ключ упала: ${e.message.split('\n')[0]}`);
    }
    delete process.env.OPENROUTER_API_KEY;

    // ── 5. L1: skeleton, CJS/methods, focus, byte-identical, cache < 1s ────
    try {
      const a = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 1 });
      const b = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 1 });
      const text = (a && a.text) || '';
      check(a && a.status === 'ready' && text.trim().length > 0, 'L1: готовый не пустой ответ');
      check(typeof b.text === 'string' && a.text === b.text, 'L1: повтор = байт-в-байт');
      for (const token of ['routeTask', 'formatTask', 'class Server', 'start(', 'src/router.js']) {
        if (text.includes(token)) check(true, `L1 содержит «${token}» (CJS-экспорт/метод)`);
        else check(false, `L1 содержит «${token}» (CJS-экспорт/метод)`);
      }
      const t0 = Date.now();
      await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0 });
      const dt = Date.now() - t0;
      check(dt < 1000, `L0 из кеша < 1 с (${dt} мс)`);

      const f = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 1, focus: ['routeTask'] });
      const ft = (f && f.text) || '';
      const iRouter = ft.indexOf('src/router.js');
      const iServer = ft.indexOf('src/server.js');
      check(iRouter !== -1 && iServer !== -1 && iRouter < iServer, 'focus: файл с focus-символом выше (src/router.js < src/server.js)');
    } catch (e) {
      check(false, `L1-фаза упала: ${e.message.split('\n')[0]}`);
    }

    // ── 6. Invalidation: new sha after commit is served lazily ─────────────
    try {
      fixture.sha2 = fixture.bump();
      const r = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0 });
      check(r && r.sha === fixture.sha2, `после коммита: ленивая достройка нового sha (${r && r.sha && r.sha.slice(0, 8)})`);
      check(String(r.text || '').includes('new-feature'), 'после коммита: новый файл в карте');
      const st = mod.mapStatus({ repoPath: fixture.dir, workspacesRoot });
      check(st && st.sha === fixture.sha2 && st.status === 'ready', `mapStatus: sha2 ready (${st && st.status})`);
      fs.rmSync(path.join(workspacesRoot, 'repo-maps'), { recursive: true, force: true });
      const rebuilt = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0 });
      check(rebuilt && rebuilt.status === 'ready', 'кеш удалён → renderMap достраивает сам');
      check(fs.existsSync(path.join(workspacesRoot, 'repo-maps')), 'после достройки кеш-каталог снова есть');
    } catch (e) {
      check(false, `инвалидация упала: ${e.message.split('\n')[0]}`);
    }

    // ── 7. Foreign sha is never served as ready; answer never empty ────────
    try {
      const foreignSha = '0'.repeat(40);
      const r = await mod.renderMap({ repoPath: fixture.dir, workspacesRoot, level: 0, sha: foreignSha });
      check(r && r.status !== 'ready', `чужой sha не отдаётся как ready (${r && r.status})`);
      check(Boolean(r && String(r.text || '').trim()), 'чужой sha: ответ всё равно не пустой (совет читать сырой репо)');
      const st = mod.mapStatus({ repoPath: fixture.dir, workspacesRoot });
      check(!(st && st.sha === foreignSha), 'mapStatus не выдаёт чужой sha');
    } catch (e) {
      check(false, `guard чужого sha упал: ${e.message.split('\n')[0]}`);
    }
  } else {
    skipDependent('L1/фокус/инвалидация/чужой sha: нет модуля');
  }

  // ── 8. MCP tool: registered, non-empty, in the manifest ──────────────────
  let registry = null;
  try {
    registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry'));
    const names = registry.listTools().map((t) => t.name);
    const toolName = names.find((n) => /repo_map$/.test(n));
    if (toolName) check(true, `MCP-тул зарегистрирован: ${toolName}`);
    else check(false, 'MCP-тул /repo_map$/ не зарегистрирован в registry (35-repo-map.js)');

    if (toolName && hasApi) {
      let result;
      try {
        result = await registry.callTool(toolName, { repo: fixture.dir, level: 0 });
      } catch {
        result = await registry.callTool(toolName, { repo_path: fixture.dir, level: 0 });
      }
      const text = typeof result === 'string' ? result
        : (result && (result.text || (result.content && result.content[0] && result.content[0].text))) || JSON.stringify(result);
      check(String(text).trim().length > 0, 'тул: ответ не пустой');
      check(String(text).includes(fixture.sha2.slice(0, 8)), 'тул: ответ содержит актуальный sha');

      let emptyOk = false;
      try {
        const e = await registry.callTool(toolName, {});
        emptyOk = Boolean(String(typeof e === 'string' ? e : JSON.stringify(e)).trim());
      } catch { emptyOk = true; } // explicit error is fine, silent empty is not
      check(emptyOk, 'тул с пустыми аргументами: не молчит (никогда пусто, #1481)');
    } else if (!toolName) {
      // уже зафиксировано выше
    } else {
      skipDependent('тул: нет модуля — вызвать нечего');
    }
  } catch (e) {
    check(false, `registry/тул упал: ${e.message.split('\n')[0]}`);
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'provider-manifest.json'), 'utf8'));
    check(manifest.actions.some((a) => /repo_map$/.test(a.name || '')), 'provider-manifest.json: есть действие repo_map');
  } catch (e) {
    check(false, `manifest: ${e.message.split('\n')[0]}`);
  }

  // ── 9. Spawn trigger (static): hook wiring + kill-switch ─────────────────
  try {
    const wsFiles = [
      ...fs.readdirSync(path.join(REPO, 'src', 'workspace')).map((f) => path.join('src', 'workspace', f)),
      path.join('src', 'mcp-skills', 'tools', '20-workspace.js'),
    ].filter((rel) => fs.existsSync(path.join(REPO, rel)));
    const wsBlob = wsFiles.map((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')).join('\n');
    check(/REPO_MAP_SPAWN_BUILD/.test(wsBlob), 'спавн-хук: есть kill-switch REPO_MAP_SPAWN_BUILD');
    check(/repo-map|repoMap|buildMap/i.test(wsBlob), 'спавн-хук: workspace подключает сборку карты (afterSpawn, в фоне)');
  } catch (e) {
    check(false, `спавн-хук: ${e.message.split('\n')[0]}`);
  }

  // ── 10. Playbook rule «сначала repo_map» ─────────────────────────────────
  const ruleFiles = [
    'playbooks-src/feature.json',
    'playbooks-src/debugging.json',
    'library/step-types.json',
    'src/prompt-domains/engineering.md',
  ];
  for (const rel of ruleFiles) {
    try {
      const blob = fs.readFileSync(path.join(REPO, rel), 'utf8');
      check(/repo_map/.test(blob), `правило «сначала repo_map»: ${rel}`);
    } catch (e) {
      check(false, `правило: ${rel} не читается (${e.message.split('\n')[0]})`);
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  log(`уровень: S5 (полный цикл: фикстура-репо → сборка → L0/L1 → инвалидация; LLM замокана, сети нет); время цикла: ${secs}s`);
  if (failures.length) {
    log(`провалено проверок: ${failures.length}`);
    log(`временные файлы оставлены для разбора: ${root}`);
    log('RESULT: FAIL');
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
  log('RESULT: PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('[sandbox] error:', (e && e.message) || e);
  console.log('[sandbox] RESULT: FAIL');
  process.exit(1);
});
