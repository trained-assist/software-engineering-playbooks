# Доменные capability и извлечение pinned playbook-артефактов

Статус: реализовано для P14 (эпик E5 #21, этап I04, карточка #53). Первый реальный домен
для P14 ещё не выбран, поэтому внешний провайдер — честная файловая фикстура, а не
боевой сервис.

Документ хранит долговечную архитектуру: контракт, инварианты, разделение слоёв,
таксономию отказов и форму логов. Статус, чек-лист и блокеры ведутся в #53 и в
[Project «Trained Assist — Migration»](https://github.com/orgs/trained-assist/projects/1).

## 1. Что это

Три доменные capability этого репозитория:

| capabilityId | effect | requiredScopes | обязательные аргументы | что делает |
|---|---|---|---|---|
| `engineering.playbook.list` | read | `playbooks:read` | — | каталог pinned-артефактов: id, версия, title, scope, путь + sha256 |
| `engineering.playbook.get` | read | `playbooks:read` | `playbook_id` | сам pinned-артефакт как resource: descriptor (+ тело definition при `detail=full`) |
| `engineering.playbook.record_selection` | write | `playbooks:write` | `playbook_id`, `reason` | запись выбора плейбука во внешнем провайдере с проверяемой receipt |

Плюс два транспортных фасада над одним и тем же handler'ом:

```
engineering.playbook.get  ──┬── mcp:engineering_playbook_get        (агент/MCP-клиент)
                             └── internal-api: POST /v1/capabilities/invoke   (control plane)
```

Доменная логика живёт один раз в `src/playbook-artifacts/`. Фасады только переводят
транспорт в/из вызова (TASK-ROUTER-AND-MCP §5: «Один domain handler имеет contract и
разные transport facades»).

## 2. Контракт — P13, а не второй словарь

Capability-контракт взят из P13 (ai-agent-runner `src/mcp/capabilities.ts`, PR #46) и
не переименовывается: `capabilityId`, `capabilityVersion`, `requiredScopes`,
`requiredArguments`, `effect`, и outcome-kinds `completed | missing_input | blocked |
needs_agent | technical_error`. Effect receipt — тоже P13-овский: `receiptId`,
`capabilityId`, `capabilityVersion`, `operationId`, `bindingRef`, `at`, `externalRef`.

Коды отказов P13 (`CAPABILITY_NOT_FOUND`, `CAPABILITY_VERSION_UNKNOWN`,
`BINDING_SCOPE_MISSING`, `BINDING_REQUIRED`) используются как есть; домен добавил свои
кодыartifact'а и эффекта, а не заменил чужие:

| Группа | Коды |
|---|---|
| Артефакт | `PLAYBOOK_NOT_FOUND`, `ARTIFACT_VERSION_MISMATCH`, `ARTIFACT_HASH_MISMATCH`, `ARTIFACT_SCHEMA_INVALID` |
| Эффект | `EFFECT_RECEIPT_MISSING`, `EFFECT_STATE_UNKNOWN`, `PROVIDER_RECEIPT_MISSING`, `PROVIDER_TIMEOUT`, `PROVIDER_UNREACHABLE`, `REPLAY_CONFLICT` |

Контракты: `contracts/playbook-capability.schema.json` (дескриптор) и
`contracts/playbook-artifact.schema.json` (результат). Дескриптор и результат — не
декорация: ответ capability'а проверяется этими схемами в тестах.

## 3. Templates ≠ MCP

- **Definitions (templates)** — `playbooks/*.json` (Playbook v1) и их читаемые сборки
  `docs/playbooks/*.md`. Это единственный источник правды о процессе.
- **Interface (MCP)** — `src/mcp-skills/tools/70-playbook-artifacts.js`: имя, описание,
  `inputSchema`, вызов handler'а. Содержимого definition'ов в нём нет и быть не должно:
  иначе определение и интерфейс молча разойдутся.

Инвариант защищен тестом: ни один файл в `src/mcp-skills/**` не содержит `step_type`,
`goal_template`, `when_to_use:` или `"stages":`; хеш в ответе совпадает с файлом на
диске. Шаблон ответа — обработчик ответа (P19), а не четвёртый тип Job и не копия
плейбука.

## 4. Pinned artifact

`resolvePinnedPlaybook({ root, playbookId, playbookVersion, expectedHash, detail })`:

1. definition читается из конкретного checkout'а — `playbooks/<id>.json`;
2. в ответе — путь артефакта и его `sha256:` (артефакт, изменившийся после пина, тихо
   не подменяется: `expectedHash` → `ARTIFACT_HASH_MISMATCH`);
3. запрошенная версия обязана совпасть, иначе `ARTIFACT_VERSION_MISMATCH`, а не
   «ближайшая доступная»;
4. артефакт проверяется по vendored-контракту Playbook v1
   (`contracts/playbook.schema.json`, тот же draft-07-поднабор, что в тестах сборки) —
   битый JSON не становится инструкцией;
5. `detail=full` отдаёт тело definition **как данные**.

## 5. Чтение не запускает план

Три независимые проверки одного инварианта:

1. **В ответе** — блок `execution: { kind: 'retrieval_only' | 'catalog_read',
   planStarted: false, planId: null, reason: 'READ_ONLY_NO_PLAN' }`. В контракте
   `planStarted` — `const false`, `planId` — `type: null`: снять флаг нельзя, не меняя
   контракт.
2. **На диске** — read не создаёт ничего, кроме append-only лога (тест сверяет
   содержимое dataRoot до/после).
3. **В графе импортов** — в `src/playbook-artifacts/**` нет ни workspace, ни run, ни
   queue, ни plan-модулей.

Даже write-capability (`record_selection`) не запускает план: она фиксирует решение и
возвращает `execution.reason = 'SELECTION_RECORDED_NOT_EXECUTED'`. Исполнение плана
остаётся за планировщиком/Control Plane, а не за чтением определения.

## 6. Advisory — возможен без gtdId

`advisory: { requiresGtdId: false, createsGtdId: false, gtdId: <caller.gtdId ?? null> }`.
Ни чтение, ни запись выбора не требуют gtdId и не создают его: в envelope он может
отсутствовать, в ответе и в логе фиксируется `advisory.settled` с причиной
`ADVISORY_NO_GTD`. Это ровно правило P14 и правило GTD opt-in из
TASK-ROUTER-AND-MCP: fast/advice-путь не заводит скрытый GTD.

## 7. Внешний эффект: receipt, happens-once, reconcile

Фейковый провайдер (`src/playbook-artifacts/provider.js`) — состояние на диске под
изолированным root, а не заглушка: он пишет запись, отдаёт квитанцию и умеет
подтвердить её обратным `lookup(operationId)`.

| Ситуация | Исход | Внешний эффект |
|---|---|---|
| запись применена | `completed` + `effectReceipt` | 1 |
| тот же `operationId`, тот же payload | `completed`, `replayed: true`, та же квитанция | 1 (не 2) |
| тот же `operationId`, другой payload | `technical_error: REPLAY_CONFLICT` | 1, перезаписи нет |
| провайдер принял запись, квитанции нет (таймаут) | `technical_error: EFFECT_STATE_UNKNOWN`, `effectStateUnknown: true`, `reconcile.operationId` | 1, повтор вслепую запрещён |
| провайдер ответил «ок» без квитанции | `technical_error: PROVIDER_RECEIPT_MISSING` | как у провайдера |
| провайдер недоступен | `technical_error: PROVIDER_UNREACHABLE` | 0 |
| credential истёк / scope не тот | `blocked` (человеческим текстом, без сырой ошибки провайдера) | 0 |

Инвариант, который проверяется таблицей в тестах: `completed` у write-capability
возможен **только** вместе с непустой `effectReceipt`.

## 8. Permissions, bindings и trusted envelope

- До вызова публикуется дескриптор: версия, `requiredScopes`, `permissions`
  (`effect`, `requiresApproval`, `retrySafety`, `allowedTriggers`), `advisory`,
  транспорты. То же самое дублируется в `provider-manifest.json` — поэтому версия и
  permissions видны и в MCP-каталоге, и в манифесте провайдера.
- Значение credential binding'а резолвит **хост** (`bindingResolver` хоста или
  `ctx.resolveBinding` фасада). Из аргументов модели binding взять нельзя: в `args`
  таких полей нет, а фасад подставляет binding из `ctx.bindings` (trusted envelope).
- Scope проверяется до handler'а: чужой scope → `BINDING_SCOPE_MISSING`, артефакт при
  этом не читается (в логе нет `artifact.resolved`).
- Нет binding'а / хост не смог его разрешить → `blocked` с указанием, что подключить.
- Отсутствие профиля в trusted envelope → `blocked`: capability не вызывается от
  имени неопознанного principal'а.
- `requiredScopes` непустые и для read: чтение локального артефакта — тоже разрешение,
  иначе «permissions» ничего не значат.

## 9. Логи (строка I04 в SANDBOX)

Append-only JSONL (`<dataRoot>/playbook-artifacts/events.jsonl`, режим 0600). Каждая
строка: `at`, `event`, `profileId`, `userTaskId`, `runId`, `operationId`, `from`, `to`,
`reasonCode` + поля конкретного события. Отсутствие данных — `null`, а не «не
передали»: headless-вызов обязан отличаться от рана.

Ключи событий: `capability.received` · `capability.validated` · `capability.rejected` ·
`capability.refused` · `capability.failed` · `artifact.listed` · `artifact.resolved` ·
`provider.mutation.confirmed` · `provider.replay.confirmed` · `effect.unknown` ·
`advisory.settled`.

Значения binding'ов не логируются: пишутся `bindingRef`/`bindingScope`, а поля с
подозрительными именами (`token`, `secret`, `authorization`, `apiKey`, …)
вычищаются в `[redacted]`. Время берётся из host clock, поэтому песочница не зависит от
стенного времени.

## 10. Границы этого среза

- Первый реальный домен для P14 не выбран (решение владельца, эпик #21) — внешний
  провайдер здесь файловая фикстура. Свойства живого провайдера она не доказывает.
- Ни одна из этих capability не запускает план, агента или GTD: это чтение и запись
  решения, а не исполнение.
- Значения binding'ов в этом репозитории нет и не появится: песочница оперирует
  синтетической фикстурой `sandbox-fixture-binding-value`, боевой хост подставляет
  своё значение из Credential Broker (#30).
- MCP-процесс/stdio-жизненный цикл, handshake и cleanup — зона P13
  (ai-agent-runner #46); P14 опирается на этот контракт и не дублирует термины.

## 11. Как проверить

```bash
npm run check                              # синтаксис всех новых модулей
npm test                                   # включая tests/playbook-artifacts*.test.js
npm run manifest:check                     # три действия в provider-manifest.json
npm run test:sandbox:playbook-artifacts    # сценарий I04 + sanitized transcript
```

Песочница изолирована: `.sandbox/p14-<pid>/` внутри репозитория (в `.gitignore`),
без сети и без движка; фейковый провайдер пишет туда же.
