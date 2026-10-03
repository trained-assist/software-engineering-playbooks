# MCP integration sandbox (P15, этап I04)

Карточка [#54](https://github.com/trained-assist/trained-agent-architecture/issues/54), эпик [#21](https://github.com/trained-assist/trained-agent-architecture/issues/21), приёмка **AC-117**.
Документ описывает долговременную архитектуру песочницы интеграции; статус и чек-лист приёмки — в issue.

Контракт не новый: он взят из P13 ([ai-agent-runner `src/mcp/capabilities.ts`, PR #46](https://github.com/trained-assist/ai-agent-runner/pull/46)) и P14 (`src/playbook-artifacts/`). Второго словаря capability/исходов песочница не заводит.

## Топология

```
                    ┌──── фасад A: MCP stdio (per-run дочерний процесс)
                    │      JSON-RPC 2.0, protocolVersion 2025-06-18
                    │      initialize → tools/list → tools/call
задача ────────────┤
                    └──── фасад B: внутренний API HTTP
                           GET  /healthz
                           GET  /v1/capabilities
                           POST /v1/capabilities/invoke        (токен хоста)
                           POST /v1/callbacks                   (токен внешнего сервиса)
                                    │
                                    ▼
                     capability host (один handler домена)
                     version → args → trusted caller → binding scope → binding value
                                    │
                                    ▼
                     эмулятор внешнего доменного сервиса (диск, callbacks)
                                    │
                                    ▼
                     inbox обратных вызовов: ровно один эффект и одно сообщение
```

Ключевое свойство, ради которого карточка и существует: **фасады разные, обработчик один**. Ответ домена не содержит ни одного транспортного поля, поэтому «одинаковый outcome по всем фасадам» — это побайтовое сравнение, а не сравнение похожих описаний.

## Что лежит в репозитории

| Модуль | Роль |
|---|---|
| `src/mcp-sandbox/provider-fixture.js` | эмулятор внешнего доменного сервиса: пять сценариев сбоя, внешний эффект на диске, happens-once по `operationId`, поздняя квитанция, HTTP-обратные вызовы, блок `fidelity` |
| `src/mcp-sandbox/capabilities.js` | два доменных действия на контракте P13: `sandbox.recruiting.search_status` (read), `sandbox.recruiting.decide_application` (write) |
| `src/mcp-sandbox/callback-inbox.js` | приём обратных вызовов: дедупликация по `callbackId` **и** по `operationId`, одно статус-сообщение на операцию |
| `src/mcp-sandbox/transports/stdio-server.js` | MCP-сервер по stdio (дочерний процесс хоста) |
| `src/mcp-sandbox/transports/http-server.js` | внутренний API + inbox обратных вызовов |
| `src/mcp-sandbox/transports/trusted-env.js` | чтение host-owned окружения; значения binding'ов здесь не читаются |
| `src/mcp-sandbox/transports/tool-surface.js` | контракт инструмента и вызов общей capability-логики |
| `src/mcp-sandbox/client.js` | клиенты обоих транспортов + канонический `outcomeFingerprint` для паритета |
| `scripts/sandbox/mcp-integration-sandbox.mjs` | сценарий этапа: одна команда, PASS/FAIL, sanitized transcript |
| `tests/mcp-integration-sandbox.test.js` | 23 проверки контракта, паритета и сбоев |

Запуск:

```bash
npm run test:sandbox:mcp-integration                                  # сценарий этапа
node scripts/sandbox/mcp-integration-sandbox.mjs --out docs/evidence/p15-mcp-integration-sandbox
npm test                                                              # включая приёмку P15
```

Песочница живёт в `.sandbox/p15-<pid>/` (в `.gitignore`), наружу не ходит: только loopback и настоящий дочерний процесс.

## Пять сценариев внешнего сервиса

| Сценарий | Что делает эмулятор | Ожидаемый исход | Почему это важно |
|---|---|---|---|
| `success` | применяет эффект, выдаёт квитанцию, один обратный вызов | `completed` + `effectReceipt`, доставка `applied=1` | базовая линия внешнего действия |
| `error` | отвечает ошибкой сервиса, эффекта нет | `technical_error PROVIDER_ERROR`, счётчик эффектов `0` | «ок» не должно рождаться без эффекта |
| `delay` | применяет эффект, **не** выдаёт квитанцию вовремя (900 мс), квитанция приходит позже | клиент фиксирует таймаут → `EFFECT_STATE_UNKNOWN`; reconcile по `operationId` возвращает ту же квитанцию, второй эффект не создаётся | AC-118 / ловушка PR-04: неизвестный исход не лечится слепым повтором |
| `auth_expiry` | отвергает выдачу: «expired» | `blocked PROVIDER_AUTH_EXPIRED` человеческим текстом | истёкшая выдача — это «подключите/обновите», а не машинный шум |
| `duplicate_callback` | доставляет обратный вызов трижды: два с тем же `callbackId`, один с новым | `applied=1`, `duplicatesIgnored=2`, одно статус-сообщение | «одно статус-сообщение на операцию» даже при ретраях вебхука |
| `unreachable` | сервис не отвечает | `technical_error PROVIDER_UNREACHABLE` | таймаут и недоступность различаются |

Два слоя истечения выдачи проверяются отдельно: у внешнего сервиса — `blocked` (см. выше), у хоста — **сервер не стартует** с `MCP_BINDING_EXPIRED` (-32003, как в P13: движок при отказе MCP не запускается вовсе).

## Что песочница доказывает и что не доказывает

Проверяется по-настоящему:

- два настоящих транспорта (дочерний процесс и HTTP-сервер) и побайтово одинаковый outcome одного действия;
- внешний эффект на диске изолированного root и его сверка с квитанцией;
- `profileId` / `userTaskId` / `runId` / `operationId` / `replyContext` / event ids не теряются ни в ответе, ни в логе, ни в статус-сообщении обратного вызова;
- ровно один эффект и одно статус-сообщение при повторе по `operationId` и при дубликатах обратных вызовов;
- границы доверия: значения binding'ов не попадают в окружение процесса, аргументы, ответ, лог и evidence; чужой scope и подмена envelope отклоняются хостом.

Не проверяется (нужен живой провайдер):

- настоящая авторизация внешнего сервиса, его срок жизни токена и refresh;
- реальные квоты и rate limits;
- реальная доставка webhook вместо эмуляторного inbox;
- реальные данные воронки вместо очищенного сэмпла.

Это зафиксировано в `fidelity` каждого ответа (`mode: emulator`, `liveSandbox: unsupported`, `liveSmoke.performed: false`) и не даёт зелёному прогону эмулятора выдать себя за живой тест.

### Живой test-account read

У внешнего сервиса нет provider sandbox, поэтому read-операция эмулируется, а production-тестирование **не ожидается**. Заявка на живой smoke оформлена явно:

```
requestLiveSmoke({ bindingNames: [] })
  → { attempted: true, performed: false, blockedBy: 'NO_TEST_ACCOUNT_BINDING',
      missingBindings: ['EXTERNAL_TEST_ACCOUNT_TOKEN', 'EXTERNAL_TEST_ACCOUNT_ID'] }
```

Значения живых учётных данных в репозитории нет и не будет — только имена переменных. Их размещение (SANDBOX.md, «Credentials и bindings»): GCP Secret Manager проекта прод-агента либо GitHub Actions secrets; прод-токены и прод-профили в песочницу не переносятся. Живой клиент появится вместе с решением владельца о первом реальном домене (эпик #21).

## Границы, которые песочница НЕ заявляет

- **OS-изоляция не доказана.** Per-run процессы MCP стартуют под тем же service UID, что и хост: `isolation=same_service_uid_not_os_isolated` в логе готовности и `mcp.osIsolation: not_proven_service_uid_only` в `GET /v1/capabilities`. Границей приёмки остаются host-side scoped bindings.
- **Токены песочницы — синтетические фикстуры.** Это доказательство канала доставки, а не секреты.
- **Ни одна capability не запускает план, агента или GTD.** `execution.planStarted=false`, `advisory.requiresGtdId=false`, `createsGtdId=false` — как в P14.
- **Эмулятор внешнего домена — не первый реальный домен.** Выбор домена остаётся за владельцем (эпик #21); песочница даёт контракт и инфраструктуру, а не продуктовое решение.
- **Карточки #124/#125 (имена/каталог MCP, Communication MCP) не трогаются.** Инструменты песочницы живут вне `src/mcp-skills/tools/` и не попадают в общий каталог провайдера: песочная фикстура не должна становиться продуктовым интерфейсом.

## Операционный контур

| Класс | Имя | Где живёт значение | Владелец | Как получить | Ротация |
|---|---|---|---|---|---|
| sandbox host token (внутренний API) | `SANDBOX_HOST_TOKEN` | память процесса-фасада | владелец песочницы | генерируется на каждый прогон | вместе с прогоном |
| внешний сервис → inbox | `SANDBOX_CALLBACK_TOKEN` | память процесса-фасада + переменная окружения дочернего процесса | владелец песочницы | генерируется на каждый прогон | вместе с прогоном |
| credential binding'и домена | `sbx/recruiting#read`, `sbx/recruiting#write` | `${dataRoot}/bindings/<sha256(ref)>.value`, 0600 | владелец песочницы | синтетическая фикстура, пишет хост | вместе с прогоном |
| живой test account | `EXTERNAL_TEST_ACCOUNT_TOKEN`, `EXTERNAL_TEST_ACCOUNT_ID` | GCP Secret Manager или GitHub Actions secrets | владелец | **не выданы**, живой smoke заблокирован | не задана (binding не создан) |

Значения binding'ов не попадают в окружение дочернего процесса и в текст отказа: их резолвит host-owned резолвер домена. Это проверяется тестом на потоке отказа.

## Проверка

```bash
npm run check          # синтаксис всех модулей песочницы
npm test               # 346 проверок, включая 23 приёмки P15
npm run manifest:check # песочные инструменты не попадают в provider-manifest.json
npm run test:sandbox:mcp-integration
```

Evidence: `docs/evidence/p15-mcp-integration-sandbox/transcript.json` + `transcript.sha256` (sanitized: без значений binding'ов, токенов и личных путей).
