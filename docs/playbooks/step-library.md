# Библиотека типов шагов

> Сгенерировано из `library/step-types.json`. Правь источник, не этот файл.

Typed step library for the engineering playbooks. One step type = one reusable unit of the process: its contract (who executes it, how it is validated) and its typical sub-steps. Playbook sources in playbooks-src/ reference types by id; scripts/build-playbooks.js renders the sub-steps, ladders and flags into each step's instructions. Rule for what is a STEP vs a SUB-STEP: a new step only where the executor/model level changes, an evidence checkpoint is needed, or the process must wait for something external. Everything else is a sub-step inside one run.

| Тип | Название | OpenSpec / аналог | Исполнитель | Проверка | Где используется |
|---|---|---|---|---|---|
| `define-use-case` | Сценарий пользователя: ценность и шаги | explore (часть) / Spec Kit: specify + clarify | researcher · master | `use_case_value_and_steps_written` | feature, new-software, skill-tool |
| `explore-context` | Исследование: как устроено сейчас и как делают другие | explore | researcher · bachelor | `context_explored_with_references` | feature, new-software, skill-tool |
| `infra-discovery` | Разведка инфраструктуры и уровней доступа | — | researcher · bachelor | `infrastructure_and_access_inventoried` | new-software |
| `requirements-complexity` | Сложность требований: флаги и челлендж | explore (часть) / Shape Up: appetite, rabbit holes, no-gos | reviewer · master | `requirements_flagged_and_challenged` | feature, new-software, skill-tool |
| `solution-options` | Варианты решения, ранжированные по песочнице | explore → propose (выбор) / ADR | developer · doctor | `options_ranked_and_decision_recorded` | new-software |
| `propose-change` | Предложение изменения: дизайн, срезы, проверка, откат | propose (proposal.md + design.md + tasks.md + spec delta) | developer · master | `change_proposed_with_tests_and_rollback` | debugging, feature, skill-tool |
| `plan-declaration` | Декларация плана: GitHub issue | propose (публикация) / Spec Kit: tasks | developer · bachelor | `issue_created_with_plan` | debugging, feature, new-software, skill-tool |
| `sandbox` | Песочница: замкнутый цикл, который повторяет сценарий | — (наш слой между propose и apply) | developer · master | `sandbox_loop_runs_and_fails_for_the_right_reason` | feature, new-software, skill-tool |
| `bug-context` | Сбор контекста бага | explore | researcher · bachelor | `bug_facts_collected_with_r_level` | debugging |
| `reproduce` | Воспроизведение: поднять R до песочницы | — (наш слой sandbox) | developer · master | `bug_reproduced_or_r_level_raised` | debugging |
| `root-cause` | Корневая причина | explore → propose | researcher · master | `root_cause_identified_with_evidence` | debugging |
| `implement` | Реализация в изолированном workspace | apply | developer · master | `implementation_complete_and_sandbox_green` | debugging, feature, new-software, skill-tool |
| `verify-local` | Полная локальная проверка | apply (verify) | verifier · bachelor | `local_checks_and_tests_green` | debugging, feature, new-software, skill-tool |
| `ci-setup` | Настроить ручной прогон тестов в репозитории | setup (ci) | developer · master | `ci_workflow_configured` | ci-setup |
| `ci-run` | Прогнать тесты ветки в облаке и вернуть результат | apply (verify) | developer · bachelor | `cloud_test_result_reported` | ci-run |
| `open-pr` | Открыть PR | apply (submit) | developer · bachelor | `pr_opened` | ci-setup, debugging, feature, new-software, skill-tool |
| `ci-green` | CI зелёный (ждём; чиним, если красный) | apply (verify) | developer · bachelor | `ci_green` | ci-setup, debugging, feature, new-software, skill-tool |
| `merged` | PR смержен | apply (deliver) | программно | `merged` | ci-setup, debugging, feature, new-software, skill-tool |
| `deployed` | Деплой прошёл и живой | apply (deliver) | verifier · bachelor | `deployed_version_is_live` | debugging, feature, skill-tool |
| `verify-real` | Проверка сценария в реальном окружении | apply (verify) | verifier · master | `user_scenario_verified_in_real_environment` | ci-setup, feature, new-software, skill-tool |
| `observe` | Наблюдение после релиза (если нужно) | — | verifier · bachelor | `post_release_observation_done_or_not_needed` | feature |
| `confirm-fixed` | Подтвердить, что ошибка ушла в проде | — | verifier · bachelor | `error_gone_in_production` | debugging |
| `repo-bootstrap` | Каркас репозитория | — (Spec Kit: constitution) | developer · bachelor | `repo_bootstrapped_with_ci_and_docs` | new-software |
| `go-live` | Из песочницы в реальное окружение | apply (deliver) | developer · master | `running_in_real_environment` | new-software |
| `archive` | Архивация: обновить живые доки и закрыть план | archive (слить spec delta в живые спеки) | reviewer · bachelor | `living_docs_updated_and_plan_closed` | debugging, epic-delivery, feature, new-software, skill-tool |
| `epic-preflight` | Предполётная проверка эпика и журнал итераций | — (мета-цикл над планом: подготовка) | developer · doctor | `epic_preflight_passed_and_ledger_written` | epic-delivery |
| `next-card` | Следующая карточка плана | — (мета-цикл: выбор среза) | developer · doctor | `next_card_chosen_or_all_closed_recorded` | epic-delivery |
| `child-plan` | Дочерний инженерный план карточки | — (мета-цикл: делегирование apply) | developer · master | `child_plan_ran_to_end_and_outcome_recorded` | epic-delivery |
| `cross-review` | Независимое кросс-ревью (другая семья моделей) | — (независимое ревью / verify) | reviewer · doctor | `independent_review_verdict_published` | epic-delivery |
| `architecture-update` | Обновление плана архитектуры по итогам ревью | archive (для плана архитектуры) | developer · doctor | `plan_updated_from_review, pr_merged` | epic-delivery |
| `loop-or-finish` | Цикл или финиш | — (мета-цикл: повтор) | developer · master | `next_iteration_added_or_loop_finished` | epic-delivery |
| `final-acceptance` | Финальная приёмка по чек-листу | verify (приёмка эпика) | verifier · doctor | `acceptance_checklist_run_and_report_published` | epic-delivery |

## Лестницы

```text
Лестница доказанности ценности (V) — насколько мы уверены, что это кому-то нужно:
  • V5 — есть явная ссылка, где ценность получают сейчас (платят / уже пользуются обходным путём)
  • V4 — много пользователей просят, есть документ custdev или поисковый спрос
  • V3 — есть отзывы / фича-реквесты от реальных пользователей
  • V2 — экспертная оценка сейлза/маркетолога, говорящего с клиентами (норм для средней фичи)
  • V1 — экспертная оценка инженера (норм для мелкой фичи)
  • V0 — не указано (норм только для нестрогой работы)
  Правило: Уровень не блокирует работу. Но если для нетривиальной фичи V ≤ 1 — ЯВНО скажи пользователю: «ценность не подтверждена, риск сделать не то» и предложи, что добавить, чтобы стало лучше.
```

```text
Лестница воспроизведения (R) — насколько надёжно мы видим проблему:
  • R5 — воспроизведено автоматически в песочнице/стейджинге одной командой (тест или скрипт)
  • R4 — наблюдается в логах (сгенерировать ошибку сами не можем)
  • R3 — есть чёткие шаги воспроизведения от пользователя
  • R2 — есть конкретный (не дефолтный) текст ошибки / exception
  • R1 — есть факт ошибки, привязанный ко времени и модулю, без деталей
  • R0 — записано со слов
  Правило: Цель — поднять R максимально до фикса. Фикс при R < 3 помечается как «спекулятивный» и обязательно получает шаг подтверждения в проде (наблюдение за логами).
```

```text
Лестница автономности песочницы (S) — может ли агент сам замкнуть цикл «изменил → увидел результат»:
  • S5 — полный замкнутый цикл: агент сам поднимает окружение и прогоняет сценарий end-to-end за минуты (локально / эфемерно, внешние зависимости — фейки или песочницы провайдеров)
  • S4 — стейджинг с реальными зависимостями, куда агент сам деплоит и где сам наблюдает результат
  • S3 — автотесты с моками внешних зависимостей (unit/integration), без полного e2e
  • S2 — код запускается частично; внешние эффекты (прод-креды, железо, платежи) проверяет человек
  • S1 — только статический анализ/компиляция; поведение проверяет человек
  • S0 — нет исполнения вообще (код пишется вслепую)
  Правило: Скорость агента ≈ 1 / время замкнутого цикла без человека. Всегда целься в максимально достижимый S и явно называй его и время цикла. S4–S5 = «проект выглядит несложно, пилим».
```

## Флаги сложности требований

```text
Флаги сложности требований — чем выше флаг, тем больше требование плодит состояний, веток и тестов по всей системе:
  • ⚪ прозрачный — не меняет поведение/модель (текст, цвет, копирайт)
  • 🟢 зелёный — аддитивно и локально, один сценарий, без новых контрактов
  • 🟡 жёлтый — задевает общие контракты/схему данных/интеграцию/вторую платформу/производительность
  • 🔴 красный — модель доступа и прав, границы безопасности/аутентификации, биллинг, необратимая миграция данных, мульти-тенантность
  • ⚫ чёрный — неоднозначность: пересекающиеся сценарии с разным поведением, противоречия, неопределённые состояния
  Правило: 🔴 и ⚫ челленджим ВСЕГДА — и для себя, и для пользователя: во что обойдётся (сколько новых состояний × сценариев тестировать, какие баги типичны), какая дешёвая альтернатива даёт ту же ценность. Требование существует, только если идёт из задачи или из реального ограничения ДРУГОЙ части системы — «так уже написано» не источник требований. ⚫ разрешается до дизайна.
```

