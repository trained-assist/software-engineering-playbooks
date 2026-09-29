# Предложение изменения: плейбук `skill-tool` (шаг 4/15 плана aa96d610)

Источники: сценарий [skill-tool.md](skill-tool.md), карта [skill-tool.context.md](skill-tool.context.md), требования [skill-tool.requirements.md](skill-tool.requirements.md), issue #53.

Базовый факт: `node --test tests/playbooks.test.js` зелёный на текущем HEAD (`7141870`) — 0 fail.

## 1. Proposal

**Зачем.** Владелец добавляет MCP-инструменты в доменные скилы вручную: каждый раз заново собирается цепочка «найти конвенции скила → файл тула → схема → тест → регистрация → правило в промпт-домене → PR → релиз → проверка в сессии». Сценарий `skill-tool.md` закрывает это одним запуском `playbook_run(playbook_id: "skill-tool", goal, vars: {repo})`. Негативная ценность: план не закрывается в состояниях «смержено, но в сессии тула нет» и «описание расходится со схемой».

**Что меняется.** Только этот репозиторий (`software-engineering-playbooks`), аддитивно:
- новый источник `playbooks-src/skill-tool.json` и его сборка (`playbooks/skill-tool.json`, `docs/playbooks/skill-tool.md`, обновлённый `docs/playbooks/step-library.md`);
- `scripts/sandbox/skill-tool.mjs` (+ скрипт `npm run test:sandbox:skill-tool`) — песочница шага 6/15: одна команда прогоняет 9 шагов сценария через реальные блоки репо (builder, схема, тесты) и сейчас красная, потому что источника ещё нет; сценарные гейты живут ТОЛЬКО здесь (одно место, без дублей с тестами);
- `tests/playbooks.test.js`: список плейбуков (`:66`) → четыре id (гейты сценария — в песочнице, тест держит схему/инварианты/свежесть сборки);
- `README.md` / `CLAUDE.md`: строка в таблице плейбуков.

**Влияние.** Рантайм плейбуков, core MCP, схема `contracts/playbook.schema.json`, `library/step-types.json` — **не трогаем**. Данных, миграций, других сервисов не затрагиваем. Новый файл станет видим `playbook_run` только после деплоя ядра, который подтянет sibling-чекаут (карта §3) — до этого он просто не существует, прод не ломается.

## 2. Design (наименьшее изменение)

**Затронутые файлы**
| Файл | Что |
|---|---|
| `playbooks-src/skill-tool.json` | новый, ~95 строк: те же паттерны, что `feature.json`, плюс скил-специфика в `notes`/переопределениях |
| `playbooks/skill-tool.json`, `docs/playbooks/skill-tool.md`, `docs/playbooks/step-library.md` | генерируются `npm run build:playbooks` |
| `tests/playbooks.test.js` | `:66` список из четырёх id (гейты сценария не дублируем — они в песочнице) |
| `scripts/sandbox/skill-tool.mjs`, `package.json` | петля песочницы 9 шагов сценария (закоммичена на шаге 6/15); гейты: вход `repo`, порядок этапов, `ci_and_staging_green`, два разных `verify-real`, мерж-коммит в релизе (#1818 как запасной путь), `⏭ не нужно` для промпт-домена |
| `README.md`, `CLAUDE.md` | строка `skill-tool` в таблице, заголовки |

**Структура плейбука** (те же типы шагов из библиотеки, без новых типов):
```
frame    define-use-case · explore-context «Скил-репо и конвенции» · requirements-complexity
propose  propose-change · plan-declaration (notify owner)
sandbox  sandbox  — красный тест хендлера и регистрации в репо скила
apply    implement · verify-local · open-pr (notify owner)
deliver  ci-green (validation ci_and_staging_green) · merged · deployed ·
         verify-real «Тул виден в новой сессии» · verify-real «Реальный вызов в живой сессии»
archive  archive
```
- `inputs`: `{ name: "repo", derive: "github_repo" }` (required, как feature/debugging).
- `explore-context` notes: выдать workspace (`engineering_spawn_workspace`, `root_task_id` плана), собрать конвенции скила — путь `src/mcp-skills/tools/`, свободный номер NN, авто-регистрация реестром (явного списка нет), образец тула, тест-раннер, наличие `staging-gate` в `.github/workflows/ci.yml`, hh-манифест, промпт-домены; вернуть ссылки файл:строка.
- `sandbox` notes: сначала красный unit-тест хендлера + тест регистрации (тул находится через реестр, имя и схема совпадают); нет тест-раннера — добавить минимальный `node --test`, не пропускать.
- `implement` notes: файл тула (шапка-комментарий, имя с префиксом домена, `inputSchema`, описание ≥20 символов, хендлер возвращает объект ошибки, не throw); конфликт имени — падение, не перезапись; условно: правило в промпт-домене (только если тул меняет поведение), для hh — обновить манифест; иначе явный `⏭ не нужно — почему`.
- `verify-local` notes: `npm test` + `npm run check` скила и core-проверки `check-skill-contract.js`, `check-mcp-conformance.js` (то же, что CI скила).
- `ci-green`: `validation: {"ci_and_staging_green": true}` + notes с обеими ветками: job `staging-gate` есть → ждём зелёный; job нет → шаг **блокируется** и вешает владельцу задачу «добавить staging-gate в CI скила» (пробел ведём в issue #9); молчаливый skip запрещён.
- `deployed` notes: мерж в скил ≠ прод; запускаем штатный `deploy-manual.yml` ядра, затем проверяем `ssh vm "git -C /home/vova/agent-releases/<repo> merge-base --is-ancestor <merge-sha> HEAD"`; запасной путь на случай снятия ssh-доступа (#1818) — вывод deploy-workflow и подтверждение владельца (без вечного ожидания).
- `verify-real` ×2: сначала «тул виден в НОВОЙ сессии» (текущие сессии его не видят — это норма), затем «живой вызов реальными аргументами» (креды отсутствуют → durable wait `awaiting_user`; внешний сервис лежит → повтор по таймеру, не «успех» по моку); тестовый мусор не оставляем.

**Почему не проще.** Без `sandbox` и `ci-green(ci_and_staging_green)` теряется «сначала красный тест» и правило владельца 2026-09-16. Отдельный новый тип шага «конвенции скила» не вводим: специфика выражается `notes` на существующем `explore-context` — ноль изменений в библиотеке и core. Два `verify-real` с разными `title` — минимальный способ развести «виден» и «вызван», не трогая список детерминированных валидаторов core.

## 3. Spec delta

- **ДОБАВЛЯЮТСЯ:** `docs/user-scenarios/playbooks/skill-tool.md` (+`.context.md`, +`.requirements.md`, + этот файл) — это первый пользовательский сценарий репо; на шаге `archive` он «архивируется» в живые сценарии `docs/user-scenarios/`.
- **МЕНЯЮТСЯ:** нет.
- **УДАЛЯЮТСЯ:** нет.

## 4. Срезы (tasks)

| # | Срез | Тест/проверка | Order |
|---|---|---|---|
| S1 | `playbooks-src/skill-tool.json` + `npm run build:playbooks` | `npm run check:playbooks` (свежесть сборки), затем `node --test tests/playbooks.test.js` после S2 | 1 |
| S2 | `tests/playbooks.test.js`: список `:66` → 4 id (гейты сценария не дублируем — они в песочнице `scripts/sandbox/skill-tool.mjs`) | `npm test` (весь пакет), 0 fail | 2 |
| S3 | `README.md`/`CLAUDE.md`: таблица + заголовки | grep-строка `skill-tool` в обоих | 3 |
| S4 | PR из workspace ветки, CI `ci` + `staging-gate` зелёные на актуальной версии | check-runs + staging-job | 4 |
| S5 | После мержа — деплой ядра (`deploy-manual`) для подтягивания sibling-чекаута | `playbook_get/playbook_list` резолвят `skill-tool` | 5 |
| S6 | Приёмка #53: пробный прогон `playbook_run("skill-tool", …)` на реальном маленьком read-only туле до живого вызова | план доходит до шага «реальный вызов» и зелёного | 6 |

S1–S3 — один PR (аддитивно, обратимо). S4 — гейт PR. S5 — гейт доставки. S6 — приёмка, отдельный план/финал.

## 5. План проверки (Шаг сценария → проверка, уровень S)

| Шаг сценария | Проверка | S |
|---|---|---|
| 1 запуск без `repo` → INPUT_REQUIRED | тест «repo input declared» (`tests/playbooks.test.js:90`) + смоук `playbook_run` без vars | S0 |
| 2 конвенции скила | итог `explore-context` со ссылками `файл:строка` (LLM-судья шага, `programmatic+llm`) | S3 |
| 3 заготовка файла тула | `check-skill-contract.js` + `check-mcp-conformance.js` (CI скила), grep по файлу | S3 |
| 4 исполняемый тест | песочница: `npm test` скила красный до, зелёный после | S3 |
| 5 правило в промпт-домене | условный шаг: ссылается на реальное имя тула и параметры (судья) | S3 |
| 6 PR CI+staging | детерминированный валидатор `ci_and_staging_green` | S4 |
| 7 релиз в проде | `command_exit_zero`: `ssh vm … merge-base --is-ancestor` (или запасной путь) | S4 |
| 8 тул виден в новой сессии | новая сессия агента: тул в списке MCP (судья/вручную) | S5 |
| 9 реальный вызов | живой вызов, ответ приложен к итогу (судья) | S5 |
| Приёмка плейбука | `npm test` (схема + инварианты) | S0 |
| Приёмка #53 | пробный прогон на реальном туле | S5 |

## 6. Риски и откат

- **Откат — чистый revert.** Изменение аддитивно: `git revert` коммита убирает источник и сборку; после деплоя ядра `skill-tool` перестаёт резолвиться. Активные планы запинены на `skill-tool@<version>` и от удаления файла не ломаются. Миграции данных нет, фича-флаг не нужен.
- **Скил без `staging-gate`** → риск зависшего `ci-green`. Снято явной веткой в notes: блок + задача в issue #9, молчаливый skip запрещён; поведение детерминировано.
- **Снятие ssh-доступа (#1818)** → гейт релиза может стать невыполнимым. Снято обязательным запасным путём в notes шага `deployed`; помечено как временное (привязка к #1818).
- **Деплой ядра перезапускает сессии.** Разрешён владельцем 2026-09-23, рестарт тихий, задачи поднимаются из pending — принято.
- **Пробный прогон в проде** → тестовый мусор. Снято: только read-only тул, запрет оставлять тестовые сущности, креды через `awaiting_user`.
- **Влияние на других** — нет: рантайм и библиотека не меняются; видимость тула в продукте ограничена целевым скилом и его секцией каталога.
