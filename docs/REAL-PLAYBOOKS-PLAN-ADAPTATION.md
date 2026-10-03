# Реальные playbooks и адаптация плана

Статус: реализовано для P24 (эпик E5 #21, этап I07, карточка #63, приёмка AC-143).
Опора: P14 (пинованный артефакт как данные, `src/playbook-artifacts/`) и P23
(GTD Manager в `trained-assist-control-plane`, PR #22). Термины не заведены заново —
взят словарь [PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES](https://github.com/trained-assist/trained-agent-architecture/blob/main/PLAYBOOKS-VS-GETTING-THINGS-DONE-BOUNDARIES.md)
и требования [REVIEW-WITH-REAL-PLAYBOOKS](https://github.com/trained-assist/trained-agent-architecture/blob/main/REVIEW-WITH-REAL-PLAYBOOKS.md).

Документ хранит долговечную архитектуру: контракт, инварианты, разделение слоёв,
таксономию отказов и форму логов. Статус, чек-лист и блокеры ведутся в #63 и в
[Project «Trained Assist — Migration»](https://github.com/orgs/trained-assist/projects/1).

## 1. Что это

Слой между «плейбук как данные» (P14) и исполнением шагов:

```
playbooks/<id>.json  ──P14 resolvePinnedPlaybook──►  definition + sha256 (данные)
                                                     │
                                          P24 compilePlan
                                                     ▼
                              Execution Plan: planId, compiledPlanRevision,
                              stepId/stepKey, гейты, ожидания, внешние операции
                                                     │
                                        runtime: prepare → execute →
                                        report-outcome → park (форма P23)
                                                     ▼
                              checklist (view) · GTD ACK (P23) · Output-исход
```

Модуль `src/execution-plans/`:

| файл | зона |
|---|---|
| `compiler.js` | pinned definition → Execution Plan; отказ вместо догадки |
| `step-identity.js` | `stepKey` / `stepId` / пин / «правка не меняет running step IDs» |
| `adaptation.js` | feature/integration split + migration dependency |
| `gates.js` | обязательные гейты, `inconclusive` ≠ `failed`, приёмка по свежему evidence |
| `executor.js` | фейковый исполнитель: 5 типов исходов, неизменные U/G ID |
| `providers/cloud-ci.js` | синтетический облачный CI (dispatch один раз) |
| `gtd-port.js` | граница с GTD Manager (P23) |
| `schedule.js` | простое расписание без GTD |
| `runtime.js` | состояние шагов на диске, ожидания, отчёт GTD, логи |
| `checklist.js` | checklist как view над `planId` |

Контракт — `contracts/execution-plan.schema.json`. Ответы компилятора и
адаптированные планы проверяются им в тестах, а не только глазами.

## 2. Три идентификатора шага, которые нельзя путать

| понятие | что это | меняется ли от правки шаблона |
|---|---|---|
| `stepKey` | семантический ключ шага внутри definition'а: `stageId#<порядковый номер в стадии>` (legacy-артефакты) или `stageId:<step.id>` | да — это и есть видимое переименование в `diffPlans` |
| `stepId` | идентификатор шага **в плане**: `stp_<sha256(playbookId@artifactHash#stepKey)>` | нет: присвоен один раз, сохраняется между попытками и ревизиями плана |
| pinned bytes | копия definition'а, из которой собраны шаги, + её sha256 | нет: проверяется пересчётом хеша, а не доверием к памяти |

Почему `stepId` включает хеш артефакта: тот же `stepKey` в другой ревизии —
потенциально другой шаг (изменились инструкции и гейты). Общий `stepId` сделал бы
историю плана неоднозначной. Сопоставление версий — работа `stepKey` и
`diffPlans()`, который явно показывает `sameStepId: false` и `retitled: true`.

Legacy-ключ `stageId#ordinal` стабилен при добавлении шага в **конец** стадии и
сдвигается при вставке в середину. Это видимое свойство, а не баг: вставка в
середину стадии действительно переименовывает последующие шаги этой стадии, и
`diffPlans` показывает это как `added` + `removed`, а не как «тот же шаг». Когда в
артефакты начнут добавлять `step.id` (Playbook v2), ключ станет явным.

## 3. Правка definition'а не трогает запущенный план

Проверяется двумя независимыми способами:

1. **Байты.** Рантайм сохраняет копию pinned- definition'а рядом с планом и сверяет
   её sha256 с `plan.definitionBytesHash` при каждой загрузке. Правка файла в
   checkout'е этого не меняет: `assertPinnedDefinition` → `matchesPlan: true`.
2. **Идентичность.** `assertRunningStepsUnchanged` сравнивает канонический отпечаток
   (`stepFingerprint`) всех шагов в состояниях `running/passed/failed/awaiting_*`.
   Переименование, смена гейта или исчезновение шага — `RUNNING_STEP_IDS_CHANGED`.

Перекомпиляция правленого артефакта даёт **новый** `planId` и новые `stepId`; её
связь со старым планом видна через `derivedFrom`/`diffPlans`, а не через молчаливую
подмену.

## 4. Feature/integration split и migration dependency

Широкий план «фича» смешивает доставку изменения и интеграцию в реальное
окружение. `adaptFeatureIntegrationSplit` делит план по границе `merged`:

| план | шаги | зависимость |
|---|---|---|
| `feature` | … → `merged` | — |
| `integration` | `deployed` → [`migration`] → `verify-real` → `observe` → `archive` | `planDependencies: [{ kind: 'requires_plan_step', planId, stepId, when: 'passed' }]` |

С `migration: { migrationId }` появляется синтетический узел миграции:
`adapter.synthetic = 'migration_node'`, `externalOperation.kind = 'schema_migration'`,
`dependsOn: [deployed]`, а `verify-real` начинает зависеть от него. Узел не
притворяется скомпилированным из артефакта, и его отсутствие (`{ migrationId }` без
имени, или план без шага `deployed`) — `MIGRATION_DEPENDENCY_INVALID`.

Инварианты адаптации: перенесённые шаги сохраняют `stepId` один в один; оба плана
держат одну `userTaskId`/`gtdId`/`continuationOwner` (расщепление не плодит вторую
запись контроля); `compiledPlanRevision` растёт у обоих; каждое изменение записано
в `adaptation.changes` с причиной. Пока upstream-шаг не `passed`, `readyStep` для
интеграции возвращает `null`, а лог пишет `plan.dependency.waiting` с
`reasonCode: UPSTREAM_STEP_NOT_PASSED`.

## 5. Гейты: четыре исхода, а не два

| исход гейта | когда | что значит |
|---|---|---|
| `passed` | все обязательные validators дали pass **со ссылкой на evidence** | шаг выполнен |
| `failed` | validator дал fail (например `conclusion=red`) | шаг не выполнен, попытка засчитана |
| `inconclusive` | validator не разрешён или evidence нет | **никогда** не превращается в pass |
| `not_evaluated` | шаг припаркован в ожидании или внешний эффект неизвестен | ждём события, а не «вердикта» |

- Обязательный гейт выключить нельзя: `setGatePolicy(..., required: false)` и
  `gatePolicy` на уровне стадии дают `GATE_NOT_DISABLEABLE`.
- «Инструмент сказал ок» не перебивает провайдера: для `ci-green` вывод синтетического
  CI авторитетен, и расхождение видно как `gate.signal.overridden`
  (`PROVIDER_CONCLUSION_WINS_OVER_UNVERIFIED_CLAIM`).
- «Отчёт о красных тестах не удался» и «тесты красные» — разные исходы: отчёт-шаг
  даёт структурный `report.conclusion=red` с внешним ref'ом, а required gate плана
  при этом `failed` с `reasonCode: CI_RED_REQUIRED_GATE`.
- `already_done` закрывает шаг **без единого модельного рана**
  (`ALREADY_DONE_PRECHECK_NO_MODEL_RUN`).
- Приёмка плана требует свежее доказательство по каждому обязательному шагу:
  evidence, собранное до открытия приёмки, даёт `ACCEPTANCE_STALE_EVIDENCE` (PR-20).

## 6. Внешние операции и CI

| понятие | значение |
|---|---|
| `externalOperation` | что шаг обязан зафиксировать внешним ref'ом до ожидания |
| `externalOperationRef` | `{ provider, kind, id }` — идентификатор **внешнего** сервиса |
| платформенный `runId` | `run_<jobId|attempt>`; `run_id` GitHub Actions им не подменяется |

Правила синтетического CI:

| ситуация | результат | внешний эффект |
|---|---|---|
| первый `dispatch` | run создан, шаг уходит в `awaiting_condition` | 1 |
| `poll` пока pending | шаг остаётся припаркованным, тик ничего не меняет | 1 |
| повторная попытка незавершённого run | читает тот же run, `external.dispatch.skipped` | 1 (не 2) |
| run завершён зелёным | результат перечитывается, новый dispatch не нужен | 1 |
| run завершён красным → следующая попытка | новая работа = новый run | N (по попыткам) |
| потерянный ACK dispatch'а | `EFFECT_STATE_UNKNOWN` + reconcile по `operationId` | 1, повтор вслепую запрещён |
| reconcile | находит существующий run, второй dispatch не делает | 1 |
| `poll` без записанного ref'а | `EXTERNAL_OPERATION_NOT_DISPATCHED` | 0 |

## 7. Граница с GTD (P23) и правило opt-in

`gtd-port.js` — граница, а не второй GTD Manager: порт считает вызовы и проверяет
запреты, отвечает подключённый transport (боевой клиент control plane или
in-process транспорт песочницы).

- `gtdId` появляется **только** через `registerControl` с полным набором полей
  (`reason`, `completionCriteria`, `nextTrigger`, `deadlineAt`, `maxAttempts`);
  неполная регистрация — `INCOMPLETE_CONTROL_RECORD` и ноль записей.
- Одна запись на `userTaskId` (`already_registered`): обойти исчерпанные caps
  «новой записью управления» нельзя; self-GTD — `SELF_SUPERVISION_FORBIDDEN`.
- Исход шага уходит в durable inbox с дедупом по `eventId` и даёт **одно**
  решение (`resume` / `retry` / `wait` / `stop` / `reconcile`), выведенное из
  структурированного исхода, а не из текста.
- Неизвестный `gtdId` у managed-исхода — `quarantined` +
  `reconciliationRequired`, а не тихий переход в output-owned recovery; поздний исход
  закрытой записи — `late`, работа не воскрешается.
- У плана без `gtdId` порт **не вызывается вообще** (`gtd.calls.outcomes === 0`),
  а лог пишет `gtd.skipped` с `NO_CONTROL_RECORD_OPT_IN_ONLY`. Это и есть «HH simple
  schedule по-прежнему без GTD»: расписание создаёт новую `userTaskId` на
  срабатывание, occurrence дедуплицируется, `disable()` не трогает принятые задачи, а
  в терминальном результате unmanaged-задачи ключа `gtdId` просто нет.

## 8. Ожидания: разные виды, разные дедлайны

`run deadline` (попытка), `wait deadline` (ожидание) и `task deadline` (контроль) —
разные поля: суточный `wait` не превращает run в timeout'ый всей цели.

| вид | маркер в артефакте | что требует рантайм |
|---|---|---|
| `user_input` | `awaiting_user: true` в инструкции | durable `awaitingInputId`, чекпоинт, ответ возобновляет ровно один раз |
| `condition` | `wait: { poll_every_sec, timeout_sec }` | `conditionRef` + внешний ref; слот освобождён, тик виртуальных часов |
| `timer` | `delay_after_sec` | таймер контроля, не живой процесс |

Во время ожидания живой процесс припаркован (`engineAttached: false` по построению:
попытка завершена, следующая создаётся по событию) — токены не жгутся. Дубликат или
поздний ответ даёт `awaiting.answer.replayed` и не создаёт второе возобновление.

## 9. Логи (строка I07 в SANDBOX)

Формат логов тот же, что в P14 (`createEventLog` из
`src/playbook-artifacts/events.js`): плоский JSON, `at` + `event` +
`profileId`/`userTaskId`/`runId`/`operationId` + `from`/`to`/`reasonCode`.
Отсутствие данных — `null`, а не «не передали».

Ключи событий: `plan.compiled` · `plan.dependency.waiting` · `plan.dependency.missing` ·
`plan.tick` · `plan.stopped` · `plan.cancelled` · `acceptance.opened` ·
`acceptance.decided` · `step.settled` · `step.refused` · `step.already_done` ·
`external.dispatch.confirmed` · `external.dispatch.skipped` ·
`external.dispatch.unknown` · `external.poll` · `external.reconcile.found` ·
`gate.signal.overridden` · `awaiting.answer.accepted` · `awaiting.answer.replayed` ·
`gtd.outcome.reported` · `gtd.skipped`.

Чего в логах нет: текста задачи (только `goalDigest`), значений binding'ов (только
`name`/`ref`/`scope`), домашних путей (заменяются на `~`), содержимого внешних
payload'ов. Это проверяется тестом и песочницей, а не обещанием.

## 10. Что компилятор отказывается угадывать

| ситуация | код | почему так |
|---|---|---|
| обязательный input не передан | `COMPILE_INPUT_MISSING` | план никогда не создаётся с литералом `{name}` в тексте шага |
| плейсхолдер без объявленного input'а и без значения | `COMPILE_UNRESOLVED_PLACEHOLDER` | то же; переданное значение фиксируется как `vars_undeclared` |
| дрейф версии/хеша артефакта | `ARTIFACT_VERSION_MISMATCH` / `ARTIFACT_HASH_MISMATCH` | «последняя известная версия» вместо пина — тихая подмена |
| agent-шаг без `instructions` | `UNSUPPORTED_STEP_CONTRACT` | shared semantics надо подтвердить resolver'ом, а не дописывать догадками |
| `programmatic`-шаг без известного handler'а | `PROGRAMMATIC_HANDLER_UNRESOLVED` | validator проверяет результат, а не исполняет работу |
| попытка выключить required-гейт | `GATE_NOT_DISABLEABLE` | исключение — actor/reason/evidence, а не флаг |
| шаг в durable-ожидании, попытка его «перезапустить» | `STEP_NOT_READY` | ожидание снимается событием, а не новой попыткой |
| cap исчерпан | план `stopped`, `blocker.reason = ATTEMPT_CAP_EXHAUSTED` | прогресс останавливается, новая запись контроля не создаётся |

## 11. Границы этого среза

- Модуль не запускает агентов, не ходит в сеть и не знает про MCP: это
  планирование и исполнение шагов по контракту Playbook v1. Транспортные фасады
  capability'й (P14/P15) к планам не подключены намеренно — MCP discovery (#124/#125)
  вне карточки.
- GTD Manager живёт в `trained-assist-control-plane` (P23). Здесь только порт и
  in-process транспорт песочницы; правила (одна запись на `userTaskId`, карантин,
  поздний исход) переиспользованы, а не переизобретены.
- Облачный CI — синтетическая фикстура на диске. Свойства живого GitHub Actions она
  не доказывает; доказывает она инварианты рантайма (один dispatch, happens-once,
  reconcile без повтора).
- Reviewed-scope артефактов (5 доменных playbook'ов из REVIEW-WITH-REAL-PLAYBOOKS)
  компилируется только при наличии `gh` и сети; без них раздел песочницы честно
  помечается `SKIPPED`. На проверенных ревизиях компилируется `presentation-creation`,
  а четыре остальных отклоняются до диспатча с явным кодом — это исполняемое
  подтверждение находок §4/§5/§7/§9 review (см. §12).

## 12. Где нужен выбор владельца

Из 11 артефактов review компилируются «как есть» 8 (7 engineering + `presentation-creation`).
Остальные четыре отклоняются до диспатча:

| артефакт | код | что нужно решить |
|---|---|---|
| `exhibition-catalog-to-sales-site` | `PROGRAMMATIC_HANDLER_UNRESOLVED` | какие operation handler'ы у programmatic-шагов (снимок/авторы, проверка API заметок) |
| `customer-development-collect` | `PROGRAMMATIC_HANDLER_UNRESOLVED` | handler для «проверить, что снимок непустой и список авторов собран» |
| `recruiting-vacancy-launch` | `PROGRAMMATIC_HANDLER_UNRESOLVED` | handler для проверки вводных HH/черновика вакансии |
| `freelance-project-spec` | `UNSUPPORTED_STEP_CONTRACT` | у agent-шага «Критика решения» нет `instructions`: это shared semantics или недописанный артефакт |

Варианты для владельца: (а) описать handler'ы и `instructions` в доменных
артефактах (правка в чужих репозиториях, зона E5 не наша), или (б) расширить
`PROGRAMMATIC_HANDLERS` явным реестром handler'ов этого репозитория. До решения
компилятор отказывает до диспатча — это безопасное поведение, но полный чек-лист
«compile всех 11 artifacts» закрыть без решения нельзя.

## 13. Как проверить

```bash
npm run check                              # синтаксис всех новых модулей
npm test                                   # включая tests/execution-plans.test.js
npm run test:sandbox:real-playbooks        # сценарий I07 + sanitized transcript
npm run test:sandbox:real-playbooks -- --out docs/evidence/p24-real-playbooks-and-plan-adaptation
```

Песочница изолирована: `.sandbox/p24-<pid>/` внутри репозитория (в `.gitignore`),
виртуальные часы, синтетический CI и внешние артефакты только на чтение. Прод-данные,
сеть и реальные провайдеры не используются. Transcript последнего прогона:
[`docs/evidence/p24-real-playbooks-and-plan-adaptation/transcript.json`](evidence/p24-real-playbooks-and-plan-adaptation/transcript.json).