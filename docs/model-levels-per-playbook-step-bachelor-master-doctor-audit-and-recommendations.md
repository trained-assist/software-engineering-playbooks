# Уровни моделей по шагам плейбуков: как есть и что менять

Разбор трёх инженерных плейбуков (`feature`, `debugging`, `new-software`) по вопросу «какая модель делает какой шаг». Состояние на 2026-09-27: после мержа trained-assist-agent#1611 и software-engineering-playbooks#30.

---

## 1. Как устроено сейчас

### 1.1. В плейбуках разбивка есть

У каждого агентского шага в `library/step-types.json` задан контракт:
- `executor_role` — researcher / developer / reviewer / verifier;
- `minimum_model_level` — bachelor / master / doctor;
- `context_budget` — small / medium / large.

Плейбук никогда не называет конкретную модель, это делает рантайм.

### 1.2. В рантайме различаются только два уровня

`trained-assist-agent/src/playbook-executor.js`, `DEFAULT_LEVEL_MAP`:

| Уровень | Движок | Профиль |
|---|---|---|
| `bachelor` | opencode | `deepseek` |
| `master` | opencode | `deepseek` ← тот же |
| `doctor` | Claude | — |

`bachelor` и `master` сейчас одно и то же: оба идут в Go-лестницу `deepseek` (mimo-v2.6-flash → deepseek-v4.1-flash → платный OpenRouter последним). Решение владельца от 2026-09-27: профили `value` и `max` утекали в платный OpenRouter.

В конфигах репо переопределение `PLAYBOOK_LEVEL_MAP` не задано. Если его нет и в `secrets.env` на VM, в проде действует карта выше.

### 1.3. Эскалация на провале

`durable-recovery.js` на ошибках класса «модель» (MODEL_ERROR, QUOTA, CONTEXT) поднимает `current_model_level` шага на ступень: bachelor → master → doctor. При текущей карте первая ступень ничего не меняет, хотя тратит попытку. Реальная эскалация одна: master → doctor, то есть в Claude.

### 1.4. Раскладка шагов по уровням

| Плейбук | Шагов | doctor | master | bachelor | без модели |
|---|---|---|---|---|---|
| `feature` | 15 | 0 | 6 | 8 | 1 (`merged`) |
| `debugging` | 13 | 0 | 4 | 8 | 1 (`merged`) |
| `new-software` | 16 | 1 (`solution-options`) | 6 | 8 | 1 (`merged`) |

Фактически сегодня в Claude идёт один шаг на три плейбука, всё остальное — в одну opencode-лестницу.

Поуровнево:

| Шаг (тип) | Где | Роль | Уровень сейчас | Бюджет |
|---|---|---|---|---|
| `define-use-case` | feature, new-software | researcher | master | medium |
| `infra-discovery` | new-software | researcher | bachelor | medium |
| `explore-context` | все | researcher | bachelor | large |
| `bug-context` | debugging | researcher | bachelor | medium |
| `requirements-complexity` | feature, new-software | reviewer | master | medium |
| `solution-options` | new-software | developer | **doctor** | medium |
| `propose-change` | feature, debugging | developer | master | medium |
| `plan-declaration` | все | developer | bachelor | small |
| `sandbox` | feature, new-software | developer | master | large |
| `reproduce` | debugging | developer | master | large |
| `root-cause` | debugging | researcher | master | large |
| `repo-bootstrap` | new-software | developer | bachelor | medium |
| `implement` | все | developer | master | large |
| `verify-local` | все | verifier | bachelor | medium |
| `open-pr` | все | developer | bachelor | small |
| `ci-green` | все | developer | bachelor | medium |
| `merged` | все | — | программный (wait) | — |
| `deployed` | feature, debugging | verifier | bachelor | small |
| `go-live` | new-software | developer | master | medium |
| `verify-real` | feature, new-software | verifier | master | medium |
| `observe` | feature | verifier | bachelor | small |
| `confirm-fixed` | debugging | verifier | bachelor | small |
| `archive` | все | reviewer | bachelor | medium |

---

## 2. Принцип: где дешёвая модель, где сильная

Главный вопрос к шагу: **проверит ли его результат последующая жёсткая проверка** (тесты, CI, песочница «красный → зелёный», HTTP-проба, `merged`)?

- **Да →** дешёвая модель плюс эскалация. Ошибку поймают, шаг перезапустится уровнем выше.
- **Нет →** сильная модель. Это решения, которые молча уходят дальше: требования, флаги, архитектура, причина бага. Если ошибка в плане, тесты потом напишут под неверный план, и они будут зелёными.

Второй критерий — **цена ошибки**. Права доступа, неоднозначные сценарии и архитектура нового софта стоят дороже всего остального.

Данные бенча лестниц (trained-assist-free-models-benchmark, issue #3, 2026-09-27):
- `free`-лестница целиком проходит все задачи бенча: ping, json, tool, code-fix, code-gen, agent-plan.
- Отдельные бесплатные модели чаще всего проваливают `agent-plan`, то есть многошаговое планирование.
- На починке PR, по данным владельца, одна модель справляется примерно в 97% случаев.

Вывод: **исполнение хорошо заданной задачи → бесплатная лестница; планирование и суждения → сильнее.**

---

## 3. Решение владельца (2026-09-27): researcher → Hermes/Gemini, остальное master, иногда doctor

### 3.1. Роль `researcher` → Hermes на Gemini

Исследователь только собирает контекст и пишет отчёт. Он ни за что не отвечает: не коммитит, не открывает PR и не отмечает пункты чек-листа. Ошибка в его отчёте ловится следующим шагом, который отчёт читает. Поэтому такой шаг можно отдать дешёвой модели с большим контекстом. Gemini хорошо подходит для исследований (решение владельца, см. README trained-assist-llm-ladder: «research / presentation / vision остаются на Gemini»).

Под это правило попадают только шаги, которые **чистое исследование**:

| Шаг | Сейчас | Станет |
|---|---|---|
| `explore-context` | researcher / bachelor | researcher → Gemini |
| `bug-context` | researcher / bachelor | researcher → Gemini |
| `infra-discovery` | researcher / bachelor | researcher → Gemini |

У двух шагов роль `researcher`, но они **отвечают за результат**, на котором стоит весь план. Их надо перевести в другую роль, иначе они тоже уедут на Gemini:

| Шаг | Почему это не чистое исследование | Предложение |
|---|---|---|
| `define-use-case` | Пишет user story — вход для тестов и проверки; ведёт диалог с юзером | роль `reviewer`, уровень master (в `new-software` — doctor) |
| `root-cause` | Выносит диагноз, по которому делают фикс | роль `developer`, уровень master; doctor, если R < 5 |

**Что есть сейчас:**
- `hermes_run` — Gemini 2.5 Flash (`google/gemini-2.5-flash` через OpenRouter), но это один вызов LLM **без инструментов**: читать репо, `gh` и логи он не может.
- `hermes_research` ходит в интернет, но движок у него по умолчанию **Claude**.

Готового «Hermes на Gemini с инструментами» нет, это шаг 2 в разделе 4.

### 3.2. Всё остальное — `master` по умолчанию

`bachelor` фактически уходит: механические шаги (open-pr, verify-local, deployed, bootstrap, ожидание CI) выносятся в MCP-методы и программные ожидания (раздел 5), модель там не нужна или нужна на минимум. Оставшиеся агентские шаги работают на `master` (Go-лестница `deepseek`): implement, починка CI, propose для простых изменений, reproduce, go-live, verify-real, archive, observe, confirm-fixed, sandbox в `feature`.

### 3.3. `doctor` (Claude) — по условию

| Шаг | Когда | Почему |
|---|---|---|
| `requirements-complexity` | найден 🔴 или ⚫ | Самый дорогой класс ошибок: права доступа, роли, неоднозначности. Разметить флаги может master, челленджить 🔴/⚫ — doctor |
| `propose-change` | флаги 🟡+ или несколько модулей | Ошибку дизайна тесты не поймают |
| `solution-options` | в `new-software` (уже doctor) | Архитектура с нуля |
| `sandbox` | в `new-software` | От песочницы зависит скорость всего проекта |
| `define-use-case` | в `new-software` | От него зависит весь план |
| `root-cause` | R < 5 (воспроизвести не удалось) | Там только рассуждения |
| **новый шаг `review`** | перед `open-pr` / merge, всегда | Независимое ревью диффа моделью, отличной от автора. Чтение диффа дешёвое по токенам, а ловит то, мимо чего проходят тесты |

Итог: **почти везде master, иногда doctor, исследование — Gemini.**

---

### 3.4. Досье для доктора: дешёвая модель готовит вход, дорогая только думает

Claude в разы дороже master и Gemini, а большая часть его времени на шаге уходит не на решение, а на **сбор контекста**: найти файлы, прочитать логи, вспомнить сценарий, понять, что уже пробовали. Эту часть делает дешёвая модель **заранее**. Doctor получает готовое досье и тратит токены на суждение.

**Правило:** перед каждым doctor-шагом стоит шаг `prepare-brief` (researcher → Gemini или master). Он собирает досье в файл. Doctor начинает с досье, но **может смотреть что угодно ещё**: досье — минимум подготовки, а не клетка. Та же оговорка уже есть в контракте Task Packet: «guidance, not a cage».

**Формат досье** — расширение существующего Task Packet (`contracts/task-packet.schema.json`, строится `prepare_task`), а не новый формат:

| Раздел | Что внутри |
|---|---|
| **Вопрос** | Одна фраза: какое решение нужно от doctor («оставлять ли роль admin», «какой из 3 подходов», «одобрить ли дифф») |
| **Варианты** | Если выбор уже сузился — 2–4 варианта с плюсами и минусами, как их видит подготовщик |
| **Сценарий и ценность** | User story, V-уровень, шаги, Given/When/Then — дословно из журнала |
| **Ограничения** | Реальные ограничения других частей системы (с file:line) и флаги требований |
| **Доказательства** | Выдержки кода (file:line, только нужные функции), логи, дифф, результаты тестов и песочницы, R/S-уровни |
| **Что уже исключено** | Отвергнутые гипотезы и подходы — с причиной, чтобы doctor их не перепроверял |
| **Открытые вопросы** | Чего подготовщик не понял или не нашёл |
| **Куда смотреть дальше** | Список файлов и команд, если doctor захочет копнуть глубже |

**Какие досье для каких doctor-шагов:**

| Doctor-шаг | Досье готовит | Главное в досье |
|---|---|---|
| `requirements-complexity` (🔴/⚫) | тот же шаг на master: разметка флагов | таблица требований с флагами, для каждого 🔴/⚫ — во что обходится и дешёвая альтернатива |
| `propose-change` (сложный) | `prepare-brief` | карта затронутых модулей и контрактов, похожий код, ограничения |
| `solution-options` | `explore-context` + `infra-discovery` | готовые решения снаружи, инвентаризация среды, достижимый S для каждого кандидата |
| `sandbox` (new-software) | `prepare-brief` | выбранный подход, доступы, какие внешние зависимости нужно подделать |
| `root-cause` (R < 5) | `bug-context` + `reproduce` | таймлайн, логи, стек, что менялось, что уже исключено |
| `review` | `prepare-brief` (без модели + master) | дифф, сценарий, план проверки, результаты тестов и песочницы, зоны риска (что задевает 🟡/🔴) |

**Проверка шага `prepare-brief`** — детерминированная: файл досье существует и в нём есть все обязательные разделы. Без модели.

**Дополнительный выигрыш:** досье стабильно по структуре, поэтому его хорошо кэшировать (prompt caching). Если doctor-шаг перезапускается после провала, повторный вход стоит дешевле.

**Когда досье не нужно:** если doctor-шаг — прямое продолжение предыдущего и весь его вход уже лежит в журнале в нужном виде (как `solution-options` после `explore-context` + `infra-discovery`). Тогда `prepare-brief` не добавляем, а в инструкции предыдущих шагов пишем «оформи итог как досье для doctor».

## 4. Что нужно сделать в коде

1. **Карта уровней + роль.** Сейчас движок выбирается только по уровню. Нужно правило по роли поверх уровня: `researcher` → Gemini-профиль, остальные роли — по уровню (`master` → opencode `deepseek`, `doctor` → Claude). Место — `resolveStepExecution` в `src/playbook-executor.js`, конфиг — `PLAYBOOK_LEVEL_MAP` плюс новая `PLAYBOOK_ROLE_MAP`.
2. **Hermes на Gemini с инструментами.** Opencode-профиль `research` (`.opencode/profiles/research.json`) с моделью Gemini через OpenRouter (`google/gemini-2.5-flash`, при нехватке — `gemini-2.5-pro`). Opencode даёт инструменты (rg, gh, чтение файлов, MCP-скилы), Gemini — модель. Тот же профиль стоит отдать `hermes_research` вместо дефолтного Claude: веб-исследование станет дешевле.
3. **Роли в библиотеке шагов** (`library/step-types.json`): `define-use-case` → reviewer, `root-cause` → developer (раздел 3.1).
4. **Условный уровень.** Шаг может поднять уровень **следующего** шага по своим выводам: нашёл 🔴 → `propose-change` становится doctor; достиг R5 → `root-cause` остаётся master. Минимально — разрешить `task_item_update(item_id, minimum_model_level)`; сейчас он меняет только `validation_mode`.
5. **Шаг `review`** в библиотеке: роль reviewer, уровень doctor, вход — дифф PR, сценарий и план проверки. Вставить перед `open-pr` во всех трёх плейбуках.
6. **Шаг `prepare-brief`** в библиотеке (researcher → Gemini / master) + шаблон досье как расширение Task Packet + детерминированная проверка разделов. Вставить перед doctor-шагами по таблице из 3.4.
7. **Эскалация.** При master по умолчанию лестница `bachelor → master` исчезает, эскалация шага — сразу master → doctor. Для researcher на Gemini при провале — перезапуск на master.

## 5. Какие шаги вынести в MCP-методы (и сделать проще)

Всё, что выглядит как «git / gh / shell известной формы», делается детерминированно. Модель тогда пишет только текстовые поля или не нужна вовсе.

| Метод | Заменяет | Модель после выноса |
|---|---|---|
| `engineering_open_pr(workspace, issue)` | `open-pr`: проверка ветки, push, PR по шаблону, URL в итог, коммент в issue | master — только текст PR |
| `engineering_sync_issue(plan)` | `plan-declaration`: создать или обновить issue из разделов плана («бумаги учёного») | без модели или master для текста |
| `engineering_verify(workspace)` | `verify-local`: один раз вычитать команды CI из `.github/workflows` (или взять из `.engineering/project.yml`) и прогнать их | только на красный — master, эскалация в doctor |
| Проверка деплоя по конфигу репо | `deployed`: URL health-эндпоинта один раз записан в конфиг репо → чистое ожидание `http_ok` + commit | без модели |
| Программное ожидание CI | `ci-green`: ждать без агента, агента запускать только на красном CI | без модели, пока не красный |
| `engineering_bug_context(service, time)` | `bug-context`: логи за окно, `git log --since`, деплои, похожие issues одной выборкой | researcher → Gemini — суммировать |
| Скаффолд репо (`dev_new_repo` + шаблон) | `repo-bootstrap`: README, симлинк CLAUDE.md, requirements-log, CI | без модели |
| Шаблоны `archive` | requirements-log, итоговый коммент и закрытие issue | master — только сжатие журнала |

---

## 6. Итоговая картина после изменений

| Где выполняется | Сейчас | После |
|---|---|---|
| Без модели (программно / MCP) | 1 шаг на плейбук (`merged`) | ~5–6 шагов (merged, deployed, ожидание CI, verify, open-pr, bootstrap) |
| Gemini (researcher) | 0 | 1–2 шага на плейбук: explore-context, bug-context, infra-discovery |
| `master` (opencode `deepseek`) | почти всё | основная работа: implement, починка CI, reproduce, go-live, verify-real, archive, простой propose |
| Claude (`doctor`) | 1 шаг на три плейбука | 3–5 по условию: флаги 🔴/⚫, сложный дизайн, архитектура и песочница нового софта, root-cause без репро, **review** — каждый стартует с готового досье |

---

## 7. Порядок работ

1. Роли в `library/step-types.json` (define-use-case, root-cause) и уровни по разделу 3.
2. Правило «роль поверх уровня» в `playbook-executor.js` + opencode-профиль `research` на Gemini. Тот же профиль — для `hermes_research`.
3. Шаг `review` в библиотеке и во всех трёх плейбуках — сразу вместе с `prepare-brief` перед ним.
4. `prepare-brief` перед остальными doctor-шагами (3.4).
5. Условный уровень: `task_item_update(minimum_model_level)` плюс инструкции в `requirements-complexity` и `reproduce`.
6. MCP-методы из раздела 5, по одному PR, начиная с `engineering_open_pr` и `engineering_verify`.
