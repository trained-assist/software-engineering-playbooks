# Epic: доставка GitHub-событий и событийное ожидание CI

Статус: relay и локальный MCP wait подключены; GitHub App/Cloudflare setup, новые selector-ы и сквозной deployment ещё не выполнены.
Подробное решение: [архитектура и интеграционные контракты](ci-event-wait-architecture.md).
Связанные документы: [локальный waiter](../../checklist-preparation.md), [CI cloud run](../../ci-cloud-run.md).

## Ценность

Текущий `engineering_ci_wait` читает GitHub сразу, затем опрашивает его с интервалом от трёх минут. События позволят быстрее обнаруживать завершение и первую ошибку CI, сократить пустые API-запросы и продолжать агентскую задачу только тогда, когда требуется действие.

Пользователь выбирает PR, issue, run, SHA или активные проверки репозитория. MCP wait method связывает события с активными ожиданиями, проверяет условие и возвращает результат в host task lifecycle. В локальном OpenCode сценарии результат возвращается из инструмента и продолжает agent; Control Panel не участвует. Другой task runtime может использовать только узкий signal по своему существующему lifecycle.

## Принятое разделение ответственности

```text
GitHub App → один CF webhook endpoint → Queue → per-repo DO fan-out → SSE → MCP wait method → tool result → OpenCode agent resumes
```

- **CF relay:** проверить подпись, нормализовать событие, доставить сообщение, повторить при сбое и показать ошибку доставки.
- **MCP wait method/host:** selector, активные ожидания, target set, CI-вердикт, deadlines, отмена, reconciliation и выдача результата task runtime. Сам wait — активный вызов MCP; relay конфигурируется через `GITHUB_EVENT_RELAY_URL/TOKEN`.
- **Control Panel / Runner API:** не участвуют в локальном MCP CI wait. Отдельная parked-task интеграция может передавать через них только узкий task lifecycle signal.

Один webhook GitHub App обслуживает установленные репозитории. MCP host проверяет права пользователя и сопоставляет события с активными waits. В relay нет task/user subscription API или менеджера агентов. Control Panel не принимает GitHub events и не управляет CI waits. DO используется только для fan-out живых WebSocket соединений по репозиторию; Hibernation сокращает оплату простоя, task state там нет.

## Сценарии и границы

Сохранить параметры MCP `repo` и ровно один selector:

- `pr_number`: текущая голова PR; при смене SHA обновить generation;
- `issue_number`: связанные открытые PR данного репозитория, найденные при старте;
- `run_id`: выбранный workflow run/attempt;
- `sha`: checks конкретного commit;
- `scope: active_repository_checks`: активный набор при старте, с явным указанием полноты обнаружения сторонних checks.

Ожидание возвращает первую ошибку выбранной попытки либо завершение всего выбранного набора. Skipped/neutral, отсутствие checks, timeout и отмена различаются с success. Неполное покрытие нельзя называть глобальным успехом репозитория. Длительное наблюдение за будущими новыми runs после завершения текущего набора — отдельное расширение.

## Требования

1. Relay принимает один общий GitHub App webhook; новые задачи не создают hooks.
2. Подпись проверяется по raw body. Сервисная авторизация защищает доставку в фиксированный MCP SSE client; произвольный callback URL из задачи не принимается.
3. Envelope содержит стабильный `event_id`, App/installation/repository IDs и типизированный subject события. Task/user IDs остаются внутри вызова MCP и не передаются в relay.
4. GitHub получает 2xx после записи сообщения в очередь. Queue consumer сохраняет событие в DO event log, а SSE доставляет его активным MCP waits; повторы безопасны. Доставка повторяема, дубликаты не создают повторного эффекта.
5. MCP wait method разрешает selector через GitHub API, сопоставляет события с активным ожиданием и выполняет reconciliation после snapshot. GitHub API подтверждает актуальный CI-вердикт.
6. MCP возвращает terminal result в активный вызов; повторное событие может вызвать дополнительное чтение GitHub, но не повторный запуск агента.
7. MCP host владеет wait timeout, отменой, поколениями SHA и periodic reconciliation. Relay не будит и не менеджерит агентов.
8. При отсутствии App/event route MCP wait method сохраняет polling fallback.
9. Существующие GitHub credentials переиспользуются в credential layer; пользовательские PAT и Runner API credentials relay не нужны.
10. Queue outage, исчерпанные retries и DLQ наблюдаемы; retention ограничен, потерянные события требуют сверки через API.

## Этапы

1. ✅ Согласовать event envelope и relay token; общий Control Panel inbox/wait manager не нужен.
2. Выделить общую логику разрешения selector и CI-вердикта, добавить issue/repository scope с coverage.
3. ✅ Локально реализован `services/github-event-relay/`: webhook verification, allowlist normalization, queue producer/consumer, per-repo DO fan-out, authenticated SSE stream и MCP event wake. Worker ещё не развёрнут; queue, DO namespace и runtime secrets не настроены.
4. Возвращать terminal result через существующий MCP tool call; не создавать общий inbox или wait manager в Control Panel.
5. Проверить реальную сквозную доставку в изолированном окружении.
6. Включить на выбранных репозиториях; откат переключает ожидания на polling.

## Критерии готовности

- Первая ошибка job обнаруживается до завершения остальных jobs; success подтверждён для полного выбранного набора.
- Одно событие репозитория может разбудить несколько активных MCP вызовов; каждый отдельно проверяет selector и GitHub доступ.
- Дубликат webhook вызывает только повторную GitHub сверку и не запускает дополнительный агент.
- Переподключение MCP с `Last-Event-ID`, смена SHA и отзыв GitHub-доступа имеют определённый результат; Control Panel не хранит GitHub events или CI waits.
- Relay не хранит ожидания задач, не имеет Runner API credential и не запускает LLM.
- Сравнены задержка реакции и API-расход с текущим polling; реальный маршрут GitHub → CF → Queue → DO → SSE → MCP wait подтверждён отдельно от локальных тестов.

## Параметры перед развёртыванием

Выбрать CF account/hostname, GitHub App, очередь/retention/DLQ и relay token. Control Panel и Runner API не входят в локальный сценарий. Подключить GitHub App после проверки изолированного маршрута и прав на выбранные репозитории.
