# Карта контекста: плейбук `skill-tool` (#53)

Шаг explore-context плана aa96d610. Сценарий — [skill-tool.md](skill-tool.md).
Ссылки на core (trained-assist-agent) даны по прод-релизу `0e4be3b` (`/home/vova/agent-master`).

## 1. Как плейбук попадает в систему (этот репо)

| Что | Где | Вывод |
|---|---|---|
| Источник плейбука | `playbooks-src/<id>.json` (образец: `playbooks-src/feature.json`) | новый файл `playbooks-src/skill-tool.json`, шаги через `{ "use": "<step-type>", "notes": [...] }` + переопределения |
| Библиотека шагов | `library/step-types.json` (23 типа; `define-use-case` … `archive`) | переиспользуем типы; новых типов минимум (см. §5) |
| Сборка | `scripts/build-playbooks.js:96` `buildPlaybook`, `:72` `buildStep` (переопределяемые поля `:69` STEP_OVERRIDES: title, validation, executor_role, model level, context_budget …), `:115` общие notes → первый agent-шаг | `npm run build:playbooks` → `playbooks/skill-tool.json` + `docs/playbooks/skill-tool.md` + обновлённый `docs/playbooks/step-library.md` |
| Контракт | `contracts/playbook.schema.json` (копия из core, `required: id, version, scope, title, goal_template, stages`; `inputs[]` с `derive`) | валидируется в тестах |
| Тесты | `tests/playbooks.test.js:59` свежесть сборки; `:66` **жёсткий список трёх плейбуков** `['debugging','feature','new-software']`; `:70-113` цикл по всем built: схема, контракт шагов, `repo`-input (`required !== false` кроме new-software), инварианты порядка (`sandbox`→`implement`, `plan-declaration` до `implement`, `open-pr`→`ci-green`→`merged`, последний — `archive`, есть `verify-real`, хуки `task_done/task_failed`) | тест `:66` надо расширить (иначе красный); инварианты применимы к skill-tool как есть — плейбук обязан содержать `sandbox`, `plan-declaration`, `verify-real`, `archive` |
| Валидаторы ожидания | `tests/playbooks.test.js:19` DETERMINISTIC_KEYS (`ci_and_staging_green`, `merged`, `merged_and_deployed`, `command_exit_zero`, `http_ok` …) | гейты «CI+staging», «мерж», «в релизе» выражаются существующими ключами; нового валидатора в core не нужно |
| Как core читает плейбуки | core `src/playbook-store.js:38` DEFAULT_SIBLING_REPOS (включает `software-engineering-playbooks`/`trained-assist-engineering`), алиас `src/playbook-reachability.js:41` | плейбук доступен в `playbook_run` после того, как прод-чекаут `trained-assist-engineering` обновится (см. §3) |

## 2. Как устроен тул в доменном скиле (целевые репо плейбука)

Скилы: hh, sales, documents, speech, search, freelance, engineering (core `src/skill-siblings.js:14` SKILL_SIBLINGS).

- **Форма репо** — core `scripts/check-skill-contract.js:1-80`: `package.json` со скриптом `test`; `src/mcp-skills/{index.js,registry.js,tools/*.js}`; каждый `tools/*.js` экспортирует `tools = { name: { description, handler, inputSchema? } }`; имя `^[a-z][a-z0-9_]*$`, описание ≥20 символов, префикс домена; **дубль имени — ошибка** (registry молча выкинул бы второй).
- **Регистрация — авто-обнаружение**, явного списка нет: `src/mcp-skills/registry.js` (search-skill) читает `tools/*.js` по сортировке, `isReady()`/`setupTools`, `listAllTools` для статического каталога (#1530). Значит «тест регистрации» = require registry → тул есть в `listTools()`/`listAllTools()` с той же схемой.
- **Образец тула**: `trained-assist-search-skill/src/mcp-skills/tools/99-search-serper.js` — шапка-комментарий (зачем, роль, конвенции), таймаут + 1 ретрай, ошибки возвращаются объектом `{error, hint}`, не throw; `fetchImpl` инжектится для офлайн-теста; живой смоук только под env-флагом (`SMOKE_SERPER=1`), в CI не бежит. Тест: `tests/search-serper.test.cjs`.
- **Промпт-домен скила**: `<skill>/src/prompt-domains/<domain>.md` (напр. `trained-assist-hh-skill/src/prompt-domains/hh.md`; core держит только свои: `src/prompt-domains/cron.md`). Сборка блока — core `src/prompt-domains/index.js`, скрытие по профилю — `src/skills/enforce.js:16,56`.
- **Скрытие по профилю** (`src/skills/enforce.js:8-11`): модуль, которого нет ни в одной секции каталога, **всегда виден** → новый файл тула не пропадёт из-за skills.json; если его надо гейтить секцией — это отдельная правка каталога.
- **Различия между скилами (реальные)**: hh-skill дополнительно держит `action-provider-manifest.json` + `mcp.manifest.json` с `approvedManifest.actions[]` и `artifactDigest` — новый тул в hh требует обновить манифест (иначе conformance/approval расходится); search/speech — без манифеста. hh-skill CI имеет `staging-gate` (`.github/workflows/ci.yml:83`), search-skill CI — только `check + unit + core contracts` (без staging).
- **CI скила** (search-skill `.github/workflows/ci.yml`): `npm run check` (require всех тулов) → `npm test` → core `scripts/check-mcp-conformance.js` → core `scripts/check-skill-contract.js`. Эти же проверки — локальный verify-local плейбука.

## 3. Как изменение скила доходит до прода — главное ограничение

- core `scripts/deploy.sh:131-154` `ensure_sibling`: чекауты скилов (`/home/vova/trained-assist-<x>-skill`, линк в `/home/vova/agent-releases/<repo>`) синхронизируются на main **только во время деплоя ядра** (за MCP-contract-чеком). У скил-репо нет своего deploy-workflow (search: только `ci.yml`), таймера синхронизации на VM нет.
- Следствие: **мерж в скил ≠ прод**. Нужен деплой ядра (следующий мерж в core или ручной `deploy-manual.yml` workflow_dispatch в core). Проверка «в релизе» для скила = `ssh vm "git -C /home/vova/agent-releases/<repo> merge-base --is-ancestor <merge-sha> HEAD"`, а не `/health` (там commit ядра).
- MCP-серверы скилов стартуют на каждую сессию из этих чекаутов (core `src/browser.js` writeMcpConfig) → после синхронизации новый тул появляется в **новой** сессии без отдельного рестарта; текущие сессии его не видят.
- То же ограничение для самого плейбука: `playbooks/skill-tool.json` станет доступен `playbook_run` только после деплоя ядра, который подтянет `trained-assist-engineering`.

## 4. История

- #53 (эта задача), #50 п.6 (бэклог). Прошлых попыток плейбука «новый тул» нет: `gh issue/pr list --search` ничего не нашёл.
- #9 (open) «Adopt domain-skill test & CI rules (docs/domain-skill-repo-test-rules.md)» — правила тестов скилов; плейбук должен на них ссылаться, а не дублировать.
- #51 (open) ci-setup/ci-run — прогон тестов в облаке; если смержится раньше, verify-local плейбука может звать его.
- PR #48 (merged) — `inputs.repo` c `derive: github_repo`; skill-tool объявляет тот же вход.
- PR #40 (open) — schema-sync job для `contracts/playbook.schema.json`; не блокирует.

## 5. Что переиспользуем

- Типы шагов как есть: `define-use-case`, `explore-context`, `propose-change`, `plan-declaration`, `sandbox` (= исполняемый тест хендлера + регистрации, сначала красный), `implement`, `verify-local`, `open-pr`, `ci-green` (с `ci_and_staging_green` где staging есть), `merged`, `deployed`, `verify-real`, `archive`.
- Специфику скила — через `notes` и переопределения `title`/`validation` в `playbooks-src/skill-tool.json`, без правки библиотеки. Кандидаты в отдельные шаги (решить на propose-change): «конвенции скила» (explore-context с notes), «правило в промпт-домене» (implement-срез с notes или отдельный шаг), «тул виден в новой сессии» + «реальный вызов» (два verify-real с разными `title`/`validation`).
- Проверки из core: `check-skill-contract.js`, `check-mcp-conformance.js` — локально и в CI скила.

## 6. Реальные ограничения vs «так написано»

Реальные (контракты других частей):
- схема плейбука в core (`contracts/playbook.schema.json`) и набор валидаторов ожидания core — менять нельзя без PR в core;
- форма скил-репо из `check-skill-contract.js` и MCP-conformance — от них зависит deploy.sh;
- доставка скила только через деплой ядра (§3);
- hh-манифест `approvedManifest` для hh-тулов.

«Так написано» (можно менять в этом PR):
- `tests/playbooks.test.js:66` фиксирует ровно три плейбука — расширяем список;
- заголовки README/CLAUDE «три плейбука» — обновляем.

## 7. Открытые вопросы (для propose-change)

1. Шаг `deployed` для скила: ждать ближайший деплой ядра или запускать `deploy-manual.yml` (согласованный рестарт разрешён владельцем 2026-09-23)? Рекомендация: запускать штатный deploy-manual после мержа скила, проверка — `merge-base --is-ancestor` в чекауте.
2. Staging-гейт в скилах без `staging-gate` (search, speech?): правило владельца 2026-09-16 требует staging до мержа. Для плейбука: `ci_and_staging_green`, если job есть; если нет — фиксировать как пробел (issue #9), не молча пропускать.
3. Пробный прогон — какой маленький read-only тул и в каком скиле (решаем на шаге пробного прогона).
