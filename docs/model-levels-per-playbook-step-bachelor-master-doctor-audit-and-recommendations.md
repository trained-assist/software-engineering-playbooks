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

## 3. Рекомендации по уровням

### 3.1. Понизить до бесплатной лестницы (`free`)

| Шаг | Почему можно |
|---|---|
| `implement` | Самый дорогой шаг и главная экономия. После `sandbox` и `propose-change` сложные решения уже приняты, слайсы маленькие, песочница и тесты ловят ошибки. Это ровно тот класс задач, где одна модель чинит PR в ~97% случаев. Начинать с `free`, эскалация уже есть |
| `ci-green` (починка красного CI) | Тот же сценарий, что у pr-autofix |
| `verify-local`, `open-pr`, `plan-declaration`, `repo-bootstrap` | Механика: git, gh, запуск команд, шаблон текста |
| `explore-context`, `bug-context`, `infra-discovery` | Поиск делают инструменты (`engineering_repo_context`, `rg`, `gh`, логи), модель только суммирует. Нужен большой контекст, а не ум |
| `deployed`, `observe`, `confirm-fixed` | Решение по правилу, ожидание без модели |
| `archive` | Правка текстов по шаблону. Сжатие журнала — классическая задача для дешёвой модели |

### 3.2. Поднять до `doctor` (Claude)

| Шаг | Когда | Почему |
|---|---|---|
| `requirements-complexity` | если найден 🔴 или ⚫ | Самый дорогой класс ошибок: права доступа, роли, неоднозначности. Разметить флаги может дешёвая модель, челленджить 🔴/⚫ — сильная |
| `propose-change` | если флаги 🟡+ или затронуто несколько модулей | Ошибку дизайна тесты не поймают |
| `sandbox` | в `new-software` всегда | От песочницы зависит скорость всего проекта, и есть риск получить песочницу, которая ничего не проверяет |
| `root-cause` | если R < 5 (воспроизвести не удалось) | Там только рассуждения. При R5 с `git bisect` справится и дешёвая модель в цикле |
| `define-use-case` | в `new-software` | От него зависит весь план. Для `feature` достаточно `master` |
| **новый шаг `review`** | перед `open-pr` / merge | Сейчас независимого ревью диффа нет. Чтение диффа дешёвое по токенам, а сильная модель, отличная от автора, ловит то, мимо чего проходят тесты. Лучшее место для Claude |

### 3.3. Оставить `master`

`reproduce`, `go-live`, `verify-real`, `propose-change` для простых 🟢-изменений.

---

## 4. Что нужно сделать в коде, чтобы уровни заработали

1. **Развести профили.** Сейчас `bachelor` = `master`. Предложение:

   ```json
   PLAYBOOK_LEVEL_MAP={"bachelor":{"engine":"opencode","ocProfile":"free"},
                       "master":{"engine":"opencode","ocProfile":"deepseek"},
                       "doctor":{"engine":"claude","ocProfile":null}}
   ```

   Профиль `.opencode/profiles/free.json` уже есть. Это правка env или `DEFAULT_LEVEL_MAP`, не архитектуры. Заодно эскалация bachelor → master станет настоящей.

2. **Условный уровень.** Сейчас уровень статичен в шаблоне. Нужно, чтобы шаг мог поднять или опустить уровень **следующего** шага по своим выводам: нашёл 🔴 → `propose-change` становится `doctor`; достиг R5 → `root-cause` опускается до `bachelor`. Минимально: разрешить `task_item_update(item_id, minimum_model_level)`. Сейчас он меняет только `validation_mode`.

3. **Шаг `review`** в библиотеке: роль reviewer, уровень doctor, вход — дифф PR, сценарий и план проверки; выход — замечания или «ок». Вставить в `apply` перед `open-pr` во всех трёх плейбуках.

4. **Кросс-модельность ревью.** Модель ревью не должна совпадать с моделью автора. При карте выше это выполняется автоматически: автор на opencode, ревьюер на Claude.

---

## 5. Какие шаги вынести в MCP-методы (и сделать проще)

Всё, что выглядит как «git / gh / shell известной формы», делается детерминированно. Модель тогда пишет только текстовые поля или не нужна вовсе.

| Метод | Заменяет | Модель после выноса |
|---|---|---|
| `engineering_open_pr(workspace, issue)` | `open-pr`: проверка ветки, push, PR по шаблону, URL в итог, коммент в issue | `free` только для текста PR |
| `engineering_sync_issue(plan)` | `plan-declaration`: создать или обновить issue из разделов плана («бумаги учёного») | `free` или без модели |
| `engineering_verify(workspace)` | `verify-local`: один раз вычитать команды CI из `.github/workflows` (или взять из `.engineering/project.yml`) и прогнать их | только на красный — `free` с эскалацией |
| Проверка деплоя по конфигу репо | `deployed`: URL health-эндпоинта один раз записан в конфиг репо → чистое ожидание `http_ok` + commit | без модели |
| Программное ожидание CI | `ci-green`: ждать без агента, агента запускать только на красном CI | без модели, пока не красный |
| `engineering_bug_context(service, time)` | `bug-context`: логи за окно, `git log --since`, деплои, похожие issues одной выборкой | `free` — суммировать |
| Скаффолд репо (`dev_new_repo` + шаблон) | `repo-bootstrap`: README, симлинк CLAUDE.md, requirements-log, CI | без модели |
| Шаблоны `archive` | requirements-log, итоговый коммент и закрытие issue | `free` — только сжатие журнала |

---

## 6. Итоговая картина после изменений

| Где выполняется | Сейчас | После |
|---|---|---|
| Без модели (программно / MCP) | 1 шаг на плейбук (`merged`) | ~5–6 шагов на плейбук (merged, deployed, ожидание CI, verify, open-pr, bootstrap) |
| `free` (бесплатная лестница) | 0 | ~5–7: implement, починка CI, explore, bug-context, archive, observe, confirm-fixed |
| `deepseek` (Go-лестница) | почти всё | 2–4: define-use-case, reproduce, go-live, verify-real, простой propose |
| Claude (`doctor`) | 1 шаг на три плейбука | 3–4 по условию: флаги 🔴/⚫, сложный дизайн, песочница нового софта, root-cause без репро, **review** |

Ожидаемый эффект: дорогая модель тратится только на суждения, которые ничто потом не проверит, и на ревью. Остальная работа идёт бесплатно, и ошибки ловят тесты, песочница и эскалация.

---

## 7. Порядок работ

1. Карта уровней (`PLAYBOOK_LEVEL_MAP` / `DEFAULT_LEVEL_MAP`) и правка уровней в `library/step-types.json` по разделу 3. Маленький PR, эффект сразу.
2. Шаг `review` в библиотеке и во всех трёх плейбуках.
3. Условный уровень: `task_item_update(minimum_model_level)` плюс инструкции в `requirements-complexity` и `reproduce`.
4. MCP-методы из раздела 5, по одному PR, начиная с `engineering_open_pr` и `engineering_verify`: они встречаются во всех трёх плейбуках.
