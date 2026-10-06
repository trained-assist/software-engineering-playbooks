# Плейбуки разработки: обзор и сверка с черновиком владельца

> Сгенерировано `scripts/build-playbooks.js` из `playbooks-src/*.json` и `library/step-types.json`.
> Прави источники и генератор, не этот файл: `npm run build:playbooks`, свежесть держит `npm run check:playbooks` (гейт CI).
> Сверка с черновиком владельца «Software Engineering Playbooks» (2026-09-27). Версии источников: ci-run v1 · ci-setup v2 · debugging v4 · epic-delivery v4 · feature v4 · new-software v4 · skill-tool v4.

## Коротко

- **7 плейбуков**, 77 шагов: `ci-run` (1), `ci-setup` (5), `debugging` (14), `epic-delivery` (8), `feature` (16), `new-software` (17), `skill-tool` (16) — на библиотеке из 33 типов шагов. У каждого типа есть роль, уровень модели, бюджет контекста, чек-лист под-шагов и критерий готовности.
- Распределение: bachelor 35, master 31, doctor 6, программных шагов 5.
- Уровни → движок (`trained-assist-agent/src/playbook-executor.js`, `DEFAULT_LEVEL_MAP`): bachelor и master → opencode, профиль `deepseek` (фолбэк — free-лестница, без Claude/Codex); doctor → Claude, при недоступности Codex → opencode `doctor`.

## Сводка по плейбукам

| Плейбук | Заголовок | Шагов | bachelor | master | doctor | программных |
|---|---|---|---|---|---|---|
| `ci-run` | Прогон тестов ветки в облаке | 1 | 1 | 0 | 0 | 0 |
| `ci-setup` | Настройка ручного прогона тестов в репозитории | 5 | 2 | 2 | 0 | 1 |
| `debugging` | Отладка: баг, регрессия, ошибка в логах | 14 | 8 | 5 | 0 | 1 |
| `epic-delivery` | Довести эпик/план архитектуры до конца (мета-цикл) | 8 | 1 | 2 | 5 | 0 |
| `feature` | Фича или изменение в существующем продукте | 16 | 8 | 7 | 0 | 1 |
| `new-software` | Новый софт или модуль с нуля (Playbook Zero) | 17 | 8 | 7 | 1 | 1 |
| `skill-tool` | Новый MCP-инструмент в доменном скиле | 16 | 7 | 8 | 0 | 1 |

## Шаги

### `ci-run` — Прогон тестов ветки в облаке (1 шаг)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Диспатч, ожидание, результат | Прогнать тесты ветки в облаке и вернуть результат | `ci-run` | разработчик | bachelor → Go deepseek | small | 10 мин | `cloud_test_result_reported` |  |

### `ci-setup` — Настройка ручного прогона тестов в репозитории (5 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Разбор репозитория и настройка workflow | Настроить ручной прогон тестов в репозитории | `ci-setup` | разработчик | master → Go deepseek | medium | 20 мин | `ci_workflow_configured` |  |
| 2 | PR: открыть, довести до зелёного, слить | Открыть PR | `open-pr` | разработчик | bachelor → Go deepseek | small | 10 мин | `pr_opened` |  |
| 3 | PR: открыть, довести до зелёного, слить | CI зелёный (ждём; чиним, если красный) | `ci-green` | разработчик | bachelor → Go deepseek | medium | 20 мин | `ci_green` |  |
| 4 | PR: открыть, довести до зелёного, слить | PR смержен | `merged` | код (без LLM) | — | — | — | `merged` | опрос каждые 5 мин, до 24 ч |
| 5 | Проверка и объяснение простыми словами | Проверка сценария в реальном окружении | `verify-real` | проверяющий | master → Go deepseek | medium | 20 мин | `user_scenario_verified_in_real_environment` |  |

### `debugging` — Отладка: баг, регрессия, ошибка в логах (14 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Сбор контекста | Сбор контекста бага | `bug-context` | исследователь | bachelor → Go deepseek | medium | 15 мин | `bug_facts_collected_with_r_level` |  |
| 2 | Воспроизведение (песочница бага) | Воспроизведение: поднять R до песочницы | `reproduce` | разработчик | master → Go deepseek | large | 30 мин | `bug_reproduced_or_r_level_raised` |  |
| 3 | Причина и план фикса | Корневая причина | `root-cause` | исследователь | master → Go deepseek | large | 25 мин | `root_cause_identified_with_evidence` |  |
| 4 | Причина и план фикса | План фикса: наименьшее изменение + регрессия | `propose-change` | разработчик | master → Go deepseek | medium | 20 мин | `change_proposed_with_tests_and_rollback` |  |
| 5 | Причина и план фикса | Декларация плана: GitHub issue | `plan-declaration` | разработчик | bachelor → Go deepseek | small | 10 мин | `issue_created_with_plan` |  |
| 6 | Фикс | Реализация в изолированном workspace | `implement` | разработчик | master → Go deepseek | large | 40 мин | `implementation_complete_and_sandbox_green` |  |
| 7 | Фикс | Полная локальная проверка | `verify-local` | проверяющий | bachelor → Go deepseek | medium | 20 мин | `local_checks_and_tests_green` |  |
| 8 | Фикс | Открыть PR | `open-pr` | разработчик | bachelor → Go deepseek | small | 10 мин | `pr_opened` | уведомить владельца |
| 9 | Доставка и подтверждение | CI зелёный (ждём; чиним, если красный) | `ci-green` | разработчик | bachelor → Go deepseek | medium | 20 мин | `ci_green` |  |
| 10 | Доставка и подтверждение | PR смержен | `merged` | код (без LLM) | — | — | — | `merged` | опрос каждые 5 мин, до 24 ч |
| 11 | Доставка и подтверждение | Деплой прошёл и живой | `deployed` | проверяющий | bachelor → Go deepseek | small | 15 мин | `deployed_version_is_live` |  |
| 12 | Доставка и подтверждение | Подтвердить, что ошибка ушла в проде | `confirm-fixed` | проверяющий | bachelor → Go deepseek | small | 15 мин | `error_gone_in_production` |  |
| 13 | Доставка и подтверждение | Приёмка по принятым требованиям (независимый судья) | `verify-requirements` | проверяющий | master → Go deepseek | medium | 20 мин | `requirements_verified_by_independent_judge` |  |
| 14 | Архивация и разбор | Архивация: доставить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `epic-delivery` — Довести эпик/план архитектуры до конца (мета-цикл) (8 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Подготовка эпика | Предполётная проверка эпика и журнал итераций | `epic-preflight` | разработчик | doctor → Claude → Codex → opencode doctor | large | 25 мин | `epic_preflight_passed_and_ledger_written` |  |
| 2 | Итерация: карточка → песочница → кросс-ревью → план | Следующая карточка плана | `next-card` | разработчик | doctor → Claude → Codex → opencode doctor | medium | 15 мин | `iteration_card_recorded_once_with_marker` |  |
| 3 | Итерация: карточка → песочница → кросс-ревью → план | Дочерний инженерный план карточки | `child-plan` | разработчик | master → Go deepseek | medium | 20 мин | `child_plan_of_this_iteration_terminal_or_deadline_and_outcome_recorded` |  |
| 4 | Итерация: карточка → песочница → кросс-ревью → план | Независимое кросс-ревью (другая семья моделей) | `cross-review` | ревьюер | doctor → Claude → Codex → opencode doctor | large | 40 мин | `verdict_for_this_iteration_child_published_or_continuation_added` |  |
| 5 | Итерация: карточка → песочница → кросс-ревью → план | Обновление плана архитектуры по итогам ревью | `architecture-update` | разработчик | doctor → Claude → Codex → opencode doctor | large | 30 мин | `plan_updated_from_this_iteration_child_verdict`, `pr_merged` |  |
| 6 | Итерация: карточка → песочница → кросс-ревью → план | Цикл или финиш | `loop-or-finish` | разработчик | master → Go deepseek | medium | 15 мин | `next_iteration_complete_in_order_or_loop_finished` |  |
| 7 | Финальная приёмка | Финальная приёмка по чек-листу | `final-acceptance` | проверяющий | doctor → Claude → Codex → opencode doctor | large | 40 мин | `acceptance_checklist_run_and_report_published_or_continuation_added` | уведомить владельца |
| 8 | Архивация | Архивация: доставить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `feature` — Фича или изменение в существующем продукте (16 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Рамка: сценарий, контекст, сложность | Сценарий пользователя: ценность и шаги | `define-use-case` | исследователь | master → Go deepseek | medium | 15 мин | `use_case_value_and_steps_written` |  |
| 2 | Рамка: сценарий, контекст, сложность | Исследование: как устроено сейчас и как делают другие | `explore-context` | исследователь | bachelor → Go deepseek | large | 20 мин | `context_explored_with_references` |  |
| 3 | Рамка: сценарий, контекст, сложность | Сложность требований: флаги и челлендж | `requirements-complexity` | ревьюер | master → Go deepseek | medium | 15 мин | `requirements_flagged_and_challenged` |  |
| 4 | Предложение и декларация плана | Предложение изменения: дизайн, срезы, проверка, откат | `propose-change` | разработчик | master → Go deepseek | medium | 20 мин | `change_proposed_with_tests_and_rollback` |  |
| 5 | Предложение и декларация плана | Декларация плана: GitHub issue | `plan-declaration` | разработчик | bachelor → Go deepseek | small | 10 мин | `issue_created_with_plan` | уведомить владельца |
| 6 | Песочница: сначала цикл, потом код | Песочница: замкнутый цикл, который повторяет сценарий | `sandbox` | разработчик | master → Go deepseek | large | 30 мин | `sandbox_loop_runs_and_fails_for_the_right_reason` |  |
| 7 | Реализация | Реализация в изолированном workspace | `implement` | разработчик | master → Go deepseek | large | 40 мин | `implementation_complete_and_sandbox_green` |  |
| 8 | Реализация | Полная локальная проверка | `verify-local` | проверяющий | bachelor → Go deepseek | medium | 20 мин | `local_checks_and_tests_green` |  |
| 9 | Реализация | Открыть PR | `open-pr` | разработчик | bachelor → Go deepseek | small | 10 мин | `pr_opened` | уведомить владельца |
| 10 | Доставка и проверка в реальности | CI зелёный (ждём; чиним, если красный) | `ci-green` | разработчик | bachelor → Go deepseek | medium | 20 мин | `ci_green` |  |
| 11 | Доставка и проверка в реальности | PR смержен | `merged` | код (без LLM) | — | — | — | `merged` | опрос каждые 5 мин, до 24 ч |
| 12 | Доставка и проверка в реальности | Деплой прошёл и живой | `deployed` | проверяющий | bachelor → Go deepseek | small | 15 мин | `deployed_version_is_live` |  |
| 13 | Доставка и проверка в реальности | Проверка сценария в реальном окружении | `verify-real` | проверяющий | master → Go deepseek | medium | 20 мин | `user_scenario_verified_in_real_environment` |  |
| 14 | Доставка и проверка в реальности | Приёмка по принятым требованиям (независимый судья) | `verify-requirements` | проверяющий | master → Go deepseek | medium | 20 мин | `requirements_verified_by_independent_judge` |  |
| 15 | Доставка и проверка в реальности | Наблюдение после релиза (если нужно) | `observe` | проверяющий | bachelor → Go deepseek | small | 15 мин | `post_release_observation_done_or_not_needed` |  |
| 16 | Архивация | Архивация: доставить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `new-software` — Новый софт или модуль с нуля (Playbook Zero) (17 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Рамка: сценарии, инфраструктура, аналоги, сложность | Сценарий пользователя: ценность и шаги | `define-use-case` | исследователь | master → Go deepseek | medium | 15 мин | `use_case_value_and_steps_written` |  |
| 2 | Рамка: сценарии, инфраструктура, аналоги, сложность | Разведка инфраструктуры и уровней доступа | `infra-discovery` | исследователь | bachelor → Go deepseek | medium | 15 мин | `infrastructure_and_access_inventoried` |  |
| 3 | Рамка: сценарии, инфраструктура, аналоги, сложность | Аналоги и готовые решения (build vs buy) | `explore-context` | исследователь | bachelor → Go deepseek | large | 20 мин | `context_explored_with_references` |  |
| 4 | Рамка: сценарии, инфраструктура, аналоги, сложность | Сложность требований: флаги и челлендж | `requirements-complexity` | ревьюер | master → Go deepseek | medium | 15 мин | `requirements_flagged_and_challenged` |  |
| 5 | Выбор подхода | Варианты решения, ранжированные по песочнице | `solution-options` | разработчик | doctor → Claude → Codex → opencode doctor | medium | 20 мин | `options_ranked_and_decision_recorded` |  |
| 6 | Выбор подхода | Декларация плана: GitHub issue | `plan-declaration` | разработчик | bachelor → Go deepseek | small | 10 мин | `issue_created_with_plan` | уведомить владельца |
| 7 | Песочница и каркас | Песочница: замкнутый цикл, который повторяет сценарий | `sandbox` | разработчик | master → Go deepseek | large | 30 мин | `sandbox_loop_runs_and_fails_for_the_right_reason` |  |
| 8 | Песочница и каркас | Каркас репозитория | `repo-bootstrap` | разработчик | bachelor → Go deepseek | medium | 25 мин | `repo_bootstrapped_with_ci_and_docs` |  |
| 9 | Ходячий скелет | Ходячий скелет: ключевой сценарий end-to-end | `implement` | разработчик | master → Go deepseek | large | 40 мин | `implementation_complete_and_sandbox_green` |  |
| 10 | Ходячий скелет | Полная локальная проверка | `verify-local` | проверяющий | bachelor → Go deepseek | medium | 20 мин | `local_checks_and_tests_green` |  |
| 11 | Ходячий скелет | Открыть PR | `open-pr` | разработчик | bachelor → Go deepseek | small | 10 мин | `pr_opened` |  |
| 12 | В реальное окружение | CI зелёный (ждём; чиним, если красный) | `ci-green` | разработчик | bachelor → Go deepseek | medium | 20 мин | `ci_green` |  |
| 13 | В реальное окружение | PR смержен | `merged` | код (без LLM) | — | — | — | `merged` | опрос каждые 5 мин, до 24 ч |
| 14 | В реальное окружение | Из песочницы в реальное окружение | `go-live` | разработчик | master → Go deepseek | medium | 30 мин | `running_in_real_environment` |  |
| 15 | В реальное окружение | Проверка сценария в реальном окружении | `verify-real` | проверяющий | master → Go deepseek | medium | 20 мин | `user_scenario_verified_in_real_environment` |  |
| 16 | В реальное окружение | Приёмка по принятым требованиям (независимый судья) | `verify-requirements` | проверяющий | master → Go deepseek | medium | 20 мин | `requirements_verified_by_independent_judge` |  |
| 17 | Архивация и следующие шаги | Архивация: доставить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `skill-tool` — Новый MCP-инструмент в доменном скиле (16 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Рамка: сценарий, контекст, сложность | Сценарий пользователя: ценность и шаги | `define-use-case` | исследователь | master → Go deepseek | medium | 15 мин | `use_case_value_and_steps_written` |  |
| 2 | Рамка: сценарий, контекст, сложность | Скил-репо и конвенции тулов | `explore-context` | исследователь | bachelor → Go deepseek | large | 20 мин | `context_explored_with_references` |  |
| 3 | Рамка: сценарий, контекст, сложность | Сложность требований: флаги и челлендж | `requirements-complexity` | ревьюер | master → Go deepseek | medium | 15 мин | `requirements_flagged_and_challenged` |  |
| 4 | Предложение и декларация плана | Предложение изменения: дизайн, срезы, проверка, откат | `propose-change` | разработчик | master → Go deepseek | medium | 20 мин | `change_proposed_with_tests_and_rollback` |  |
| 5 | Предложение и декларация плана | Декларация плана: GitHub issue | `plan-declaration` | разработчик | bachelor → Go deepseek | small | 10 мин | `issue_created_with_plan` | уведомить владельца |
| 6 | Песочница: сначала красный тест, потом код | Песочница: замкнутый цикл, который повторяет сценарий | `sandbox` | разработчик | master → Go deepseek | large | 30 мин | `sandbox_loop_runs_and_fails_for_the_right_reason` |  |
| 7 | Реализация | Реализация в изолированном workspace | `implement` | разработчик | master → Go deepseek | large | 40 мин | `implementation_complete_and_sandbox_green` |  |
| 8 | Реализация | Полная локальная проверка | `verify-local` | проверяющий | bachelor → Go deepseek | medium | 20 мин | `local_checks_and_tests_green` |  |
| 9 | Реализация | Открыть PR | `open-pr` | разработчик | bachelor → Go deepseek | small | 10 мин | `pr_opened` | уведомить владельца |
| 10 | Доставка и проверка в реальности | CI зелёный (ждём; чиним, если красный) | `ci-green` | разработчик | bachelor → Go deepseek | medium | 20 мин | `ci_and_staging_green` |  |
| 11 | Доставка и проверка в реальности | PR смержен | `merged` | код (без LLM) | — | — | — | `merged` | опрос каждые 5 мин, до 24 ч |
| 12 | Доставка и проверка в реальности | Деплой прошёл и живой | `deployed` | проверяющий | bachelor → Go deepseek | small | 1 ч | `deployed_version_is_live` |  |
| 13 | Доставка и проверка в реальности | Тул виден в новой сессии | `verify-real` | проверяющий | master → Go deepseek | medium | 20 мин | `user_scenario_verified_in_real_environment` |  |
| 14 | Доставка и проверка в реальности | Реальный вызов в живой сессии | `verify-real` | проверяющий | master → Go deepseek | medium | 20 мин | `user_scenario_verified_in_real_environment` |  |
| 15 | Доставка и проверка в реальности | Приёмка по принятым требованиям (независимый судья) | `verify-requirements` | проверяющий | master → Go deepseek | medium | 20 мин | `requirements_verified_by_independent_judge` |  |
| 16 | Архивация | Архивация: доставить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

## Сверка с черновиком владельца

| Что просили | Где живёт сейчас | Статус |
|---|---|---|
| Сначала большие сценарии, потом стандартные блоки подробно | 7 плейбуков + библиотека 32 типов шагов с чек-листами (`library/step-types.json`, `docs/playbooks/step-library.md`) | ✅ |
| Playbook Zero: новый софт/модуль, свобода в архитектуре | `new-software`: use case → infra-discovery → explore → сложность → варианты → план → песочница → bootstrap → … → go-live → archive | ✅ |
| Infrastructure / environment discovery: что есть (VM, маки, GCP, GPU, ключи), какой доступ даст юзер | `infra-discovery` + лестница **S** (автономность песочницы S0–S5) | ✅ |
| Генерация подходов по максимальному повторению в песочнице, ранжирование | `solution-options` («ранжированные по песочнице»); уровень doctor держат 6 шагов: `solution-options` в `new-software` и 5 в `epic-delivery` | ✅ |
| Подход: не spec-driven, а environment/execution-driven | назван **Sandbox-Driven Development (SbDD)**; сверка с OpenSpec, Spec Kit, Kiro/EARS, Shape Up и др. | ✅ |
| «В шаге всегда прототип следующего шага» | явного механизма нет; частично — песочница до кода и мини-ресерч перед вопросами | 🟡 |
| Feature: use case → explore → propose → plan-declaration → sandboxing → apply → archive | `feature`: все 7 есть; apply развёрнут в implement → verify-local → open-pr → ci-green → merged → deployed → verify-real → observe | ✅ |
| Plan-declaration: GitHub issue, «если учёный погибнет, соратники доведут» | `plan-declaration` + уведомление владельцу | ✅ |
| Archive: requirements log + issue + user stories + LLM-сжатие лога сессии бесплатными моделями | `archive`: статус требований — в issues (правило владельца 2026-09-28), закрытый issue, сжатая память о решениях; упоминаний `docs/requirements-log.md` в `playbooks-src` нет | ✅ |
| Debugging: контекст → повторение в песочнице → propose → apply → archive | `debugging`: bug-context → reproduce → root-cause → propose-change → … → confirm-fixed → archive | ✅ |
| Лестница воспроизведения бага L0–L5 | лестница **R** | ✅ |
| Ценность L0–L5, явно предупреждать о риске при низком уровне | лестница **V** (V0–V5), правило «при V ≤ 1 явно сказать пользователю» | ✅ |
| Steps с конкретными блоками UI/API/CLI, EARS | `define-use-case`: шаги в форме «КОГДА … ТОГДА …» | ✅ |
| Не мучить анкетой: сначала мини-ресерч в репо, сжатая версия репо | под-шаг 1 в `define-use-case`; **сжатый индекс репо — не сделан** (открыто) | 🟡 |
| Explore: внутри репо для фикса, снаружи для новой фичи | `explore-context` («как устроено сейчас и как делают другие»), правило repo_map-first закреплено тестом в CI | ✅ |
| Флаги сложности требований: прозрачный / зелёный / жёлтый / красный (права доступа) / неоднозначность | флаги ⚪🟢🟡🔴⚫ + шаг `requirements-complexity` с челленджем | ✅ |
| Apply: ветки, имена, без конкуренции, git-менеджмент | `implement` в изолированном workspace (`engineering_spawn_workspace`) | ✅ |
| Главная боль: агент не должен ждать «деплой закончился» | durable wait движка: «PR смержен» — опрос каждые 5 мин до 24 ч без агента (смержено: trained-assist-agent#1611, 2026-09-27) | ✅ |
| Explore через Hermes-ноутбук | авторинг плейбуков есть (`playbook_draft` / `playbook_edit`); полнота контракта для `wait`/`step_type` не подтверждена | 🟡 |

## Выводы и предложения по моделям

1. **Master ≠ bachelor пока не выполняются.** Оба уровня идут на один и тот же профиль opencode `deepseek` (фолбэк — free-лестница; Claude/Codex для них запрещены — владелец 2026-09-29, #1899). «Думающие» шаги (use case, сложность, propose-change, root-cause) стоит развести с «делающими» (implement, sandbox): план — сильной моделью, выполнение — дешёвой (в opencode это профиль с разными моделями для агентов `plan` и `build`).
2. **Doctor устроен иначе, чем предлагалось в первом обзоре:** с 2026-09-28 (#1689) он идёт Claude → Codex → opencode `doctor`; отдельная лестница внутри opencode живёт в llm-ladder (#1687). Второй по частоте уровень после master — 6 шагов.
3. **Исследовательские шаги с 2026-10-01 идут через llm-ladder**, а не напрямую через Go-профиль (инцидент: недельный кап Go-подписки убил все research-шаги плана) — учитывать при разведении master/bachelor.
4. **Сначала замер:** прогнать 10 прошлых шагов каждого «думающего» типа на deepseek-flash vs более сильной модели vs Claude, сравнить вслепую; только потом менять карту уровней.
5. **Этот документ генерируется** `scripts/build-playbooks.js` вместе с `docs/playbooks/*.md`; `npm run check:playbooks` в CI не даёт ему устареть.
