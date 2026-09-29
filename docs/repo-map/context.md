# repo_map (#49) — карта контекста (шаг explore-context)

Сценарий: [docs/user-scenarios/engineering/repo-map-fast-discovery.md](../user-scenarios/engineering/repo-map-fast-discovery.md).

## Что уже есть и переиспользуем

| Что | Где | Как используем |
|---|---|---|
| Детерминированный индекс v1 (files/modules/symbols/tests + revision) | `src/index/build.js:170` `buildIndex()` | Сырьё для L1: файлы, символы с строками, модули, hotspots. Не пишем второй сканер. |
| Контракт индекса: схема, generator, путь | `src/index/schema.js:7-10` | L0/L1 — новые файлы/версия схемы рядом, `INDEX_SCHEMA_VERSION` поднимаем. |
| Проверка свежести (repo id + revision + schema) | `src/index/status.js:44` `indexCompatibility()` | Тот же гейт «карта только для своего sha и своего репо» для repo_map. |
| Regex-сканер символов по 12 языкам | `src/index/lang.js:42-94`, `extractSymbols` `:116` | Фолбэк для языков без парсера; для JS/TS — заменить парсером (см. ограничения). |
| Модули + git-hotspots | `src/index/build.js:90,111` | Основа L0 (топ-уровень + «где чаще меняют»). |
| Ранжирование по ключам | `src/context-sources/repo-context.js`, `indexed-repo.js:49`, `raw-repo.js` | `focus` в repo_map = тот же ранкер; raw-repo — вечный фолбэк. |
| MCP-тул-образец | `src/mcp-skills/tools/30-repo-context.js` | repo_map = новый файл `src/mcp-skills/tools/3x-repo-map.js` по той же форме; регистрация авто по каталогу tools/. |
| Хуки создания рабочей копии | `src/workspace/workspace.js:252,271,291,318` (`hooks.afterWorktree/afterSpawn`), зеркало `src/workspace/for-task.js:34` `ensureMirror()` | Точка «сборка при engineering_spawn_workspace»: после fetch зеркала строим/берём карту для baseRevision. |
| CLI индекса | `scripts/index-repo.js` (`npm run index:build/check`) | Расширить флагами `--level`, либо отдельный `scripts/repo-map.js`. |
| Шаг explore-context | `library/step-types.json:87` | Сюда правило «сначала repo_map» → попадёт в feature и debugging (`playbooks-src/feature.json:20`; debugging использует `bug-context`, `playbooks-src/debugging.json:19` — дописать туда тоже). После правки `npm run build:playbooks`. |
| Дешёвая LLM | в этом репо LLM нет; в ядре `trained-assist-agent/src/llm-client.js:17` (`llmCall`, OpenRouter, ключ `OPENROUTER_API_KEY` `:152`) | Для L0-описаний — минимальный свой вызов OpenRouter через `fetch` (Node 22), без зависимости от ядра. |

## Замеры на trained-assist-agent (сегодня, VM)

- 682 файла в git, 344 JS/TS; `buildIndex` = 0.58 с, 80 МБ; symbols.json 520 КБ, 2702 символа; files.json 616 КБ.
- Вывод: построение дешёвое (можно синхронно при spawn), но сырой индекс ≈ 300k токенов — L0 ≤ 2k токенов надо собирать агрегированием (модули + по строке на файл/папку), не срезом.

## Реальные ограничения (контракты, которые нельзя ломать)

1. **Прод-чекаут скила без npm install.** Сиблинг `trained-assist-engineering` на VM обновляется `git reset --hard` в `trained-assist-agent/scripts/deploy.sh:106 sync_sibling_checked`; `node_modules` там нет. Любая парсер-зависимость (typescript/acorn/tree-sitter) требует либо вендоринга в репо, либо добавить `npm ci` в deploy.sh ядра (второй репо). Нативный tree-sitter — ещё и сборка на VM → отвергаем.
2. **MCP-контракт #1481**: результат тула никогда не пустой; ревизия, не прошедшая `check-mcp-conformance.js`, не выкатывается (deploy.sh:113).
3. **Индекс — только ускорение**, raw-repo — вечный фолбэк (`docs/INDEXER.md`). repo_map при любой проблеме отвечает «карты нет → читай исходники», не ошибкой.
4. **`provider-manifest.json` + `npm run manifest:check`** в CI — новый тул должен пройти контракт манифеста.
5. **Слот ta-agent-N**: нет доступа к чужим каталогам; кеш должен жить под workspaceRoot/mirrorsRoot профиля, не в общем /tmp.

## «Так написано», можно менять

- Индекс пишется ВНУТРЬ рабочей копии (`<repo>/.engineering/index`, schema.js:8) и `.engineering` не в `.gitignore` целевых репо → при spawn это грязнит worktree и не шарится между рабочими копиями одного sha. Для кеша «по commit sha» переносим хранилище в `<mirrorsRoot>/../repo-maps/<repoId>/<sha>/` (общий для всех рабочих копий профиля).
- Regex-сканер пропускает CJS-стиль `module.exports = { a, b }` и методы объектов/классов — основной стиль trained-assist-agent. Для L1 «скелета» это главный пробел.
- «После мержа в main»: в этом репо деплоя нет; ближайшая точка — `ensureMirror` при следующем spawn (fetch → новый sha → сборка) плюс опционально сборка в deploy.sh ядра для сиблингов. Отдельный вебхук не нужен для v1.

## Снаружи (кратко, берём / не берём)

- Aider repo-map (tree-sitter теги + PageRank по ссылкам, бюджет токенов) — **берём идею**: ранжировать символы по числу входящих ссылок и резать под бюджет; **не берём** код/tree-sitter (Python, нативка).
- TypeScript Compiler API (`typescript`, чистый JS, парсит JS+TS) — **кандидат №1** для L1 JS/TS, при условии решения по п.1 ограничений (вендорить или npm ci в deploy).
- acorn (~150 КБ, чистый JS, только JS) — **кандидат-запасной**: легко завендорить, но без TS.
- Universal ctags — **не берём**: внешний бинарник на VM.
- Эмбеддинги/векторный поиск — **не берём** (явный non-goal INDEXER.md).

## Открытые вопросы для дизайна (шаг propose)

1. Парсер для JS/TS: вендорить acorn (JS only) vs `typescript` + `npm ci` в deploy.sh ядра (кросс-репо изменение). Рекомендация: acorn-вендор + regex для TS/прочих в v1.
2. Хранилище кеша по sha вне рабочей копии — путь и уборка старых sha (держать N последних).
3. Модель и бюджет для L0-описаний (OpenRouter, дешёвая модель), поведение без ключа — L0 без описаний, но всё равно ≤ 2k токенов.
4. A/B-приёмка: источник «10 прошлых задач» — логи сессий (session_search) + число Read/grep до первого правильного файла.
