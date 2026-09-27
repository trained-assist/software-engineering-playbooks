# Плейбуки разработки: обзор и сверка с черновиком владельца

Дата: 2026-09-28. Сгенерировано из `playbooks/*.json` и `library/step-types.json` (что
реально исполняется), плюс сверка с черновиком владельца «Software Engineering
Playbooks» (2026-09-27).

## Коротко

- **Три плейбука**, 44 шага: `feature` (15), `debugging` (13), `new-software` (16), на
  общей библиотеке из 24 типов шагов. У каждого типа есть роль, уровень модели, бюджет
  контекста, чек-лист под-шагов и критерий готовности.
- **Черновик реализован почти целиком**: сценарии, лестницы V, R и S, флаги сложности,
  песочница до кода, декларация плана в issue, ожидания без агента, archive. Что не
  доделано, перечислено ниже.
- **Модели.** Уровень **doctor встречается один раз** — `new-software` → «Варианты решения,
  ранжированные по песочнице». Все остальные «думающие» шаги (сценарий, флаги сложности,
  предложение изменения, корень бага) идут на уровне **master**, а это сейчас тот же Go
  deepseek-flash, что и у bachelor. **Разницы между bachelor и master сейчас нет.**

| Плейбук | Шагов | bachelor | master | doctor | код/ожидание |
|---|---|---|---|---|---|
| `feature` | 15 | 8 | 6 | 0 | 1 |
| `debugging` | 13 | 8 | 4 | 0 | 1 |
| `new-software` | 16 | 8 | 6 | 1 | 1 |

Уровни → движок сейчас (`trained-assist-agent/src/playbook-executor.js`,
`DEFAULT_LEVEL_MAP`): bachelor и master → opencode, профиль `deepseek` (OpenCode Go);
doctor → Claude, при недоступности → Codex → opencode deepseek.

## Шаги


### `feature` — Фича или изменение в существующем продукте (15 шагов)

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
| 14 | Доставка и проверка в реальности | Наблюдение после релиза (если нужно) | `observe` | проверяющий | bachelor → Go deepseek | small | 15 мин | `post_release_observation_done_or_not_needed` |  |
| 15 | Архивация | Архивация: обновить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `debugging` — Отладка: баг, регрессия, ошибка в логах (13 шагов)

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
| 13 | Архивация и разбор | Архивация: обновить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

### `new-software` — Новый софт или модуль с нуля (Playbook Zero) (16 шагов)

| # | Этап | Шаг | Тип | Кто | Уровень → модель сейчас | Контекст | Таймаут | Готово, когда | Ожидание / уведомление |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Рамка: сценарии, инфраструктура, аналоги, сложность | Сценарий пользователя: ценность и шаги | `define-use-case` | исследователь | master → Go deepseek | medium | 15 мин | `use_case_value_and_steps_written` |  |
| 2 | Рамка: сценарии, инфраструктура, аналоги, сложность | Разведка инфраструктуры и уровней доступа | `infra-discovery` | исследователь | bachelor → Go deepseek | medium | 15 мин | `infrastructure_and_access_inventoried` |  |
| 3 | Рамка: сценарии, инфраструктура, аналоги, сложность | Аналоги и готовые решения (build vs buy) | `explore-context` | исследователь | bachelor → Go deepseek | large | 20 мин | `context_explored_with_references` |  |
| 4 | Рамка: сценарии, инфраструктура, аналоги, сложность | Сложность требований: флаги и челлендж | `requirements-complexity` | ревьюер | master → Go deepseek | medium | 15 мин | `requirements_flagged_and_challenged` |  |
| 5 | Выбор подхода | Варианты решения, ранжированные по песочнице | `solution-options` | разработчик | **doctor → Claude** (→ Codex → Go deepseek) | medium | 20 мин | `options_ranked_and_decision_recorded` |  |
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
| 16 | Архивация и следующие шаги | Архивация: обновить живые доки и закрыть план | `archive` | ревьюер | bachelor → Go deepseek | medium | 20 мин | `living_docs_updated_and_plan_closed` |  |

## Черновик → что получилось

| Из черновика | Где в плейбуках | Статус |
|---|---|---|
| Сначала большие сценарии, потом стандартные блоки подробно | 3 плейбука + библиотека 24 типов шагов с чек-листами (`library/step-types.json`, `docs/playbooks/step-library.md`) | ✅ |
| Playbook Zero: новый софт/модуль, свобода в архитектуре | `new-software`: use case → infra-discovery → explore → сложность → варианты → план → песочница → bootstrap → … → go-live → archive | ✅ |
| Infrastructure / environment discovery: что есть (VM, маки, GCP, GPU, ключи), какой доступ даст юзер | `infra-discovery` + лестница **S** (автономность песочницы S0–S5) | ✅ |
| Генерация подходов по максимальному повторению в песочнице, ранжирование | `solution-options` («ранжированные по песочнице»), единственный шаг **doctor** | ✅ |
| Подход: не spec-driven, а environment/execution-driven | назван **Sandbox-Driven Development (SbDD)**, альтернатива «execution-loop driven» упомянута; сверка с OpenSpec, Spec Kit, Kiro/EARS, Shape Up и др. | ✅ |
| «В шаге всегда прототип следующего шага» | явного механизма нет; частично — песочница до кода и мини-ресерч перед вопросами | 🟡 |
| Feature: use case → explore → propose → plan-declaration → sandboxing → apply → archive | `feature`: все 7 есть; apply развёрнут в implement → verify-local → open-pr → ci-green → merged → deployed → verify-real → observe | ✅ |
| Plan-declaration: GitHub issue, «если учёный погибнет, соратники доведут» | `plan-declaration` + уведомление владельцу | ✅ |
| Archive: requirements log + issue + user stories + LLM-сжатие лога сессии бесплатными моделями | `archive`: живые сценарии, лог требований, закрытый issue, сжатая память о решениях | 🟡 пишет в `docs/requirements-log.md` — по правилу владельца от 2026-09-28 статус требований живёт **в issues**, лог — архив. Нужно поправить шаг |
| Debugging: контекст → повторение в песочнице → propose → apply → archive | `debugging`: bug-context → reproduce → root-cause → propose-change → … → confirm-fixed → archive | ✅ |
| Лестница воспроизведения бага L0–L5 | лестница **R** | ✅ |
| Ценность L0–L5, явно предупреждать о риске при низком уровне | лестница **V** (V0–V5), правило «при V ≤ 1 явно сказать пользователю» | ✅ |
| Steps с конкретными блоками UI/API/CLI, EARS | `define-use-case`: шаги в форме «КОГДА … ТОГДА …» | ✅ |
| Не мучить анкетой: сначала мини-ресерч в репо, сжатая версия репо | под-шаг 1 в `define-use-case`; **сжатый индекс репо — не сделан** (открыто) | 🟡 |
| Explore: внутри репо для фикса, снаружи для новой фичи | `explore-context` («как устроено сейчас и как делают другие») | ✅ |
| Флаги сложности требований: прозрачный / зелёный / жёлтый / красный (права доступа) / неоднозначность | флаги ⚪🟢🟡🔴⚫ + шаг `requirements-complexity` с челленджем | ✅ |
| Apply: ветки, имена, без конкуренции, git-менеджмент | `implement` в изолированном workspace (`engineering_spawn_workspace`) | ✅ |
| Главная боль: агент не должен ждать «деплой закончился» | durable wait движка: «PR смержен» — опрос каждые 5 мин до 24 ч без агента | ✅ (зависит от trained-assist-agent#1611) |
| Explore через Hermes-ноутбук | Hermes-авторинг (`playbook_draft`) пока не знает `wait`/`step_type` | 🟡 |

## Выводы и предложения по моделям

1. **Master ≠ bachelor.** Сейчас оба уровня — Go deepseek-flash. Шаги master (use case,
   сложность, propose-change, root-cause, verify-real, implement, sandbox) нужно развести:
   - «думающие» (use case, сложность, propose-change, root-cause) → сильная модель из Go
     (`qwen3.7-plus`), шаги маленькие по выходу, дорого не выйдет;
   - «делающие» (implement, sandbox) → план сильной, выполнение дешёвой: в opencode это
     профиль с разными моделями для агентов `plan` и `build`.
2. **Doctor без Claude и Codex** (один шаг `solution-options`): сейчас он проваливается сразу в
   Go deepseek. Нужна отдельная лестница `doctor` в LLM ladder (qwen3.8-max → qwen3.7-plus →
   glm → deepseek-v4-pro) вместо прыжка на самый слабый уровень.
3. **Сначала замер:** прогнать 10 прошлых шагов каждого «думающего» типа на deepseek-flash vs
   qwen3.7-plus vs Claude, сравнить вслепую; тогда карта уровней меняется по данным.
4. **Archive** перевести с `requirements-log.md` на issues.
5. Этот отчёт стоит генерировать `scripts/build-playbooks.js` вместе с `docs/playbooks/*.md`,
   чтобы он не устаревал.
