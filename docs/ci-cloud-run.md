# Прогон тестов в облаке: `ci-setup` + `ci-run` — предложение изменения

Статус: implemented (план 3e40a139, 2026-09-29).
Сценарий: `docs/user-scenarios/ci/cloud-test-run.md` (V5).
Носители: **software-engineering-playbooks** (плейбуки, типы шагов, шаблон, MCP-тул,
тесты) и **trained-assist-agent** (один валидатор durable-wait в ядре).

### Как запускается и как проверяется

- **Песочница (S5, ~0.3 с, замкнутый цикл):** `npm run test:sandbox:ci` — гоняет шаги
  сценария через реальный код (`templates/ci.yml`, типы шагов, оба плейбука, MCP-тул
  `ci_run_branch` против фейкового GitHub API) с `npm run check:playbooks` в середине.
  Секция про ядро (`ci_run_green`) читает чекаут trained-assist-agent: по умолчанию
  `/home/vova/trained-assist-agent`, иначе задай `AGENT_REPO=<путь к чекауту>`:
  `AGENT_REPO=/path/to/trained-assist-agent npm run test:sandbox:ci`.
  Пока в чекауте нет `src/playbook-validators.js` с `ci_run_green`, эта секция красная —
  это и есть сигнал, что PR-A (ядро) ещё не дошёл.
- **Обычные проверки:** `npm run check` (syntax) · `npm test` (юнит, `node --test`) ·
  `npm run manifest:check` · `npm run check:playbooks` (каталог не устарел).
- **В проде:** `playbook_run(playbook_id: "ci-setup" | "ci-run", goal: …, vars: {repo: …})`
  — оба видны в `playbook_list` после того, как чекаут `/home/vova/trained-assist-engineering`
  обновился до main (см. §5).

## 1. Proposal — зачем, что меняется, влияние

**Зачем.** Логи 25–29.09: 492 локальных прогона тестов в 82 сессиях (~3,5 ч), 31 прогон
дольше 2 мин (до 13 мин, таймауты), ~2,3 ч ручного опроса CI. Причина — у репозиториев нет
ручного запуска полного набора тестов для ветки (`workflow_dispatch`). Нужна одна команда
«прогони тесты ветки в облаке» и разовая настройка репозитория, объяснимая не-разработчику.

**Что меняется.**

- Новые системные плейбуки `ci-setup` (разовый, на репозиторий; идемпотентный) и `ci-run`
  (частый, на ветку).
- Новые типы шагов `ci-setup`, `ci-run`; правка общего типа `verify-local` (локально — только
  быстрые проверки, полный набор — в облаке).
- Шаблон `templates/ci.yml` (workflow с `workflow_dispatch`, без мержа и деплоя).
- MCP-тул `ci_run_branch(repo, ref, suite?, run_id?)` в `src/mcp-skills/tools/63-ci-cd.js`.
- В ядре (trained-assist-agent) — детерминированный валидатор `ci_run_green` в реестре
  durable-wait (без него `task_item_wait` отвергает неизвестный ключ условия).

**Влияние (модули, контракты, данные, другие сервисы).**

- Каталог плейбуков: +2 системных плейбука, видны всем профилям в `playbook_list`.
- Реестр MCP-тулов `engineering-skills`: +`ci_run_branch` (в `provider-manifest.json` не
  добавляем — как `cicd_track_pr`; `manifest:check` только предупредит).
- Реестр валидаторов durable-wait в ядре: +`ci_run_green` (доступен любому плейбуку).
- Общий тип `verify-local` → меняет instructions всех трёх change-плейбуков (feature,
  debugging, new-software) — правка идёт в том же PR, пересборкой.
- Целевые репозитории: получают `workflow_dispatch` по PR; прогон только читает/проверяет,
  не мержит и не деплоит. БД/данных/внешних сервисов не затрагиваем — миграций нет.
- Прод-путь (для приёмки): прод читает `playbooks/` и MCP-тулы из чекаута
  `/home/vova/trained-assist-engineering` (symlink в `agent-releases/`), который обновляет
  `deploy.sh` агента (`fetch` + `reset --hard origin/main`) — см. §5.
- Цена обслуживания: шаблон поддерживать при новых стеках; +1 ключ валидатора в ядре;
  +2 плейбука в каталоге. Всё названо явно.

## 2. Design — наименьшее изменение

### 2.1 Плейбук `ci-setup` (разовый, на репозиторий)

Стадии: `analyze` → `change` → `explain`. Это не change-flow (нет песочницы/verify-real/
архивации) — поэтому инварианты change-плейбуков на него не распространяются (см. §4, срез 5).

- Шаг `ci-setup` (agent/developer): определить стек (package.json / pyproject.toml /
  requirements.txt / go.mod) и перечислить `.github/workflows/*`.
- **Идемпотентность (наблюдаемо):** есть активный workflow с `workflow_dispatch`, чей job
  гоняет полный набор тестов и не деплоит → ответ «уже настроено», PR **не** открывается.
- Иначе выбрать минимальную правку:
  (а) есть `ci.yml` без dispatch → добавить блок `workflow_dispatch` **только** если все
  deploy/merge-джобы загейжены от событий, недоступных при dispatch (`push`, `pull_request`);
  (б) иначе — отдельный `.github/workflows/manual-tests.yml` из `templates/ci.yml`
  (по умолчанию всегда так — не трогает PR-пайплайн);
  (в) CI нет вовсе — создать `manual-tests.yml` из шаблона.
- Шаги `open-pr` → `ci-green` → `merged` (штатные типы): PR в целевой репо (ветка `eng/…`,
  база `origin/main`), тело — сценарий, что появилось, «ничего не мержит и не деплоит».
- Шаг `explain` (agent/verifier): простыми словами владельцу — что появилось, как запустить,
  что запуск ничего не мержит/не деплоит.
- Хуки `task_done` / `task_failed` → notify owner.

### 2.2 Плейбук `ci-run` (частый, на ветку)

Одна стадия, один agent-шаг типа `ci-run`:

1. `ci_run_branch(repo, ref, suite?)`. `configured:false` → сообщить и **предложить** `ci-setup`
   (не запускать молча, не угадывать).
2. Настроено → тул делает dispatch и возвращает `run_id`.
3. `task_item_wait(until: {ci_run_green: {repo, run_id}}, poll_every_sec: 120,
   timeout_sec: 3600, reason: "ждём прогон")` → `DURABLE: waiting`. Никакого длинного зависания.
4. Проснулся → `ci_run_branch(run_id=<id>)` (status-режим):
   `success` → «зелёный», набор, ветка, длительность;
   `failure` → «красный» + упавшие джобы + хвост лога (последние ~50 строк упавшей джобы);
   `cancelled/skipped/timed_out` → явная ошибка с причиной (никогда не «зелёный»).
5. Повторный ран шага **не** диспатчит заново: `run_id` берётся из evidence прошлого рана.

### 2.3 MCP-тул `ci_run_branch` (`src/mcp-skills/tools/63-ci-cd.js`)

Сосед `cicd_track_pr`. GitHub-доступ: экспортировать приватные `getToken`/`ghFetch` из
`60-github.js` (реестр читает только `.tools` — лишние ключи в exports безопасны).

Контракт:

```
ci_run_branch(repo, ref, suite?, run_id?)
  dispatch-режим (run_id не задан):
    1. GET /repos/{repo}/actions/workflows → выбрать активный workflow, чей файл содержит
       workflow_dispatch (список не сообщает триггер → прочитать .github/workflows/*.yml
       дефолтной ветки через contents API). Приоритет: ci.yml, manual-tests.yml, имя с manual|test.
    2. нет такого → {ok:false, configured:false, hint:"запусти плейбук ci-setup"}.
    3. POST /repos/{repo}/actions/workflows/{id}/dispatches
         {ref: <дефолтная ветка>, inputs: {ref: <ветка под тестом>, suite?}}
       ref диспатча = дефолтная ветка (иначе ветка без workflow-файла не диспатчится),
       тестируемая ветка передаётся input'ом и подставляется в checkout.
    4. найти свой run: GET .../workflows/{id}/runs?event=workflow_dispatch, новейший после
       dispatch; короткий in-process опрос 3×5с; не нашли → {ok:true, run_id:null, hint}.
       → {ok:true, run_id, url, workflow, ref}
  status-режим (run_id задан):
    GET /repos/{repo}/actions/runs/{run_id} → {ok, status, conclusion, duration, url}
    failure → GET .../runs/{run_id}/jobs?filter=latest&status=failure → failed_jobs[{name,url}]
              + GET /actions/jobs/{job_id}/logs → log_tail (последние ~50 строк)
    cancelled/skipped/timed_out → {ok:false, error:"run <conclusion>", ...}
```

Без GH-токена → `{ok:false, error:"no-github-token"}` (явно, не молча). Тул только
диспатчит и читает — не мержит, не деплоит.

### 2.4 Валидатор `ci_run_green` (ядро trained-assist-agent)

`src/playbook-validators.js`, по образцу `makeCiValidator`. Значение — `{repo, run_id}`.
`GET /repos/{repo}/actions/runs/{run_id}`:

- `completed` + `success` → **pass**;
- `completed` + `failure|timed_out|cancelled|startup_failure|action_required` →
  `{status:'fail', evidence:{final:true}}` (durable-wait будит шаг: тянуть дальше нельзя);
- `queued|in_progress` → **inconclusive** (ждём дальше);
- нет `repo/run_id`, нет токена, API недоступен → **inconclusive** (никогда не «зелёный» молча).

Регистрация в `createDefaultRegistry` → ключ попадает в `registryKeys`, которые
`normalizeAgentWait` проверяет для `until` (неизвестный ключ отвергается сразу). Unit-тест
рядом с существующими в `tests/unit/playbook-validators.test.js`.

### 2.5 Шаблон `templates/ci.yml`

`workflow_dispatch` с inputs: `ref` (string, default main), `suite`
(choice: unit|scenario|staging|all, default all); `concurrency: group: manual-tests-${{ inputs.ref }}`,
`cancel-in-progress: true` (только ручные запуски — PR-CI не задевает); job `test`:
`actions/checkout` с `ref: ${{ inputs.ref }}`, setup-node, `npm ci`, `npm test`; **нет** шагов
мержа/деплоя, **нет** `continue-on-error`. В шапке шаблона — готовые блоки-примеры для
типовых стеков (python: setup-python + `pip install -r requirements.txt` + `pytest`; go:
setup-go + `go test ./...`), что подставить. Шаблон — рабочая заготовка для node и замена
команд для остальных стеков.

### 2.6 Правка `verify-local` (`library/step-types.json`)

Новые substeps: (1) локально — быстрые проверки (syntax/lint/быстрые unit); (2) запушь ветку
(`git push -u origin <ветка>`) и запусти полный набор в облаке — `ci_run_branch(repo, <ветка>)`
+ `task_item_wait` (durable); репо не настроено (`configured:false`) → полный локальный прогон
как раньше + предложи `ci-setup`; (3) упало — почини и повтори; (4) итог — команды, run URL,
результат. `done_when`: полный набор зелёный (в облаке, либо локально на ненастроенном репо).

### Почему не проще

- **Только тул, без плейбуков** — «настроить один раз» для чужого юзера требует гейтов, PR и
  идемпотентности; тул этого не умеет.
- **Только плейбуки, без тула** — каждый ран агент писал бы запросы к Actions API заново;
  нет контракта и автотеста.
- **`gh` CLI через `command_exit_zero`** — нет гарантии авторизации на сервере, auth-ошибка
  неотличима от красного теста, не переиспользуемо для чужих юзеров.
- **Новый файл тула** — `63-ci-cd.js` и есть дом CI/CD; отдельный файл был бы пустым соседом.
- **Расширять `cicd_track_pr`** — другой концерн (жизненный цикл PR vs прогон ветки).
- **Править существующий `ci.yml` вместо отдельного workflow** — по умолчанию отдельный
  `manual-tests.yml`; правка допускается только по проверенному правилу (2.1а).

## 3. Spec delta (`docs/user-scenarios`)

- **ADDED:** `docs/user-scenarios/ci/cloud-test-run.md` (2 сценария, 7+7 шагов) — сделано на
  шаге 1, коммит `687b96f`.
- **CHANGED:** там же, сценарий 2 — добавляется шаг про `verify-local` (локально только быстрые
  unit; полный набор — `ci_run_branch` на ветку до открытия PR). Правка в этом шаге.
- **REMOVED:** нет.

## 4. Срезы (tasks) и порядок

1. **Ядро (PR-A, trained-assist-agent):** валидатор `ci_run_green` + unit-тест. **Первым** —
   иначе `until` с неизвестным ключом отвергается на старте. Тест:
   `tests/unit/playbook-validators.test.js`.
2. **Шаблон (PR-B, этот репо):** `templates/ci.yml` (+ примеры стеков). Тест:
   `tests/ci-template.test.js` (есть `workflow_dispatch` и `inputs.ref`; есть `concurrency`;
   нет `deploy`/`merge`/`continue-on-error`).
3. **Тул (PR-B):** экспорт gh-хелперов + `ci_run_branch`. Тест: `tests/ci-run-branch.test.js`
   (hermetic fetch stub: не настроено; dispatch+поиск run; success; failure→`failed_jobs`+
   `log_tail`; cancelled→явная ошибка).
4. **Типы шагов (PR-B):** `ci-setup`, `ci-run`, правка `verify-local`.
5. **Плейбуки (PR-B):** `playbooks-src/ci-setup.json`, `playbooks-src/ci-run.json` →
   `npm run build:playbooks` (обновить `playbooks/*.json` и `docs/playbooks/*.md`). Тест
   `tests/playbooks.test.js`: две группы — change-flow инварианты **только** для
   debugging/feature/new-software; валидность по схеме и типизованность шагов — для всех,
   включая ci-setup/ci-run. Требование «ровно 3 плейбука» меняется осознанно (владелец добавил
   два): замена в том же PR с явным списком.
6. **Docs (PR-B):** сценарий (§3), README (список тулов/плейбуков), `requirements-log`.
7. **Гейт и доставка:** `npm run check` + `npm test` + `npm run manifest:check` → PR → CI
   (+ staging где есть) → merge; затем синхронизировать прод-чекаут плейбуков (§5).
8. **Приёмка на реальных репо** (§5, последний блок).

## 5. План проверки (шаг сценария → проверка → уровень S)

| Шаг сценария | Как проверяем | S |
|---|---|---|
| С1.1 `playbook_run(ci-setup)` | компоновка плана + запуск на trained-assist-agent | S4 |
| С1.2 стек и существующие workflows | смоук-ран `ci-setup` (лог шага) | S3 |
| С1.3 «уже настроено», PR не открыт | повторный `ci-setup` на настроенном репо | S3 |
| С1.4 создание/дополнение workflow | `tests/ci-template.test.js` (S5) + смоук на репо без CI (S4) | S4 |
| С1.5 PR в целевом репо | смоук: PR в trained-assist-agent смержен, ci+staging зелёные | S3 |
| С1.6 объяснение простыми словами | проверка текста финального шага (смоук) | S2 |
| С2.1 тул `ci_run_branch` | `tests/ci-run-branch.test.js` | S5 |
| С2.2 «не настроено» + предложение ci-setup | автотест тула | S5 |
| С2.3 dispatch + поиск своего run | автотест тула | S5 |
| С2.4 durable-ожидание (≤2 мин/опрос) | unit ядра (pass / fail-final / inconclusive) + смоук реального run | S5 / S4 |
| С2.5 зелёный ответ | смоук `ci_run_branch` на тестовой ветке agent | S4 |
| С2.6 красный + упавший тест + хвост лога | смоук: намеренно сломанный тест на ветке → имя теста в ответе | S4 |
| С2.7 отмена/пропуск → явная ошибка | автотест тула | S5 |
| «не деплоит» | автотест шаблона + смоук: при dispatch deploy-джобы agent не стартуют | S5 / S4 |
| оба плейбука видны на проде | `playbook_list` после синка чекаута | S2 |

**Прод-путь (нужен для последней строки).** Прод читает `playbooks/` и MCP-тулы из чекаута
`/home/vova/trained-assist-engineering` (symlink `agent-releases/trained-assist-engineering`),
который обновляет `deploy.sh` агента (`fetch origin main` + `reset --hard origin/main`).
После merge PR в этом репо: `ssh vm "git -C /home/vova/trained-assist-engineering fetch origin
main && git -C /home/vova/trained-assist-engineering reset --hard origin/main"` (то же сделает
ближайший деплой агента) → новая сессия → `playbook_list`.

**Приёмка (из цели плана):** `ci-setup` на `trained-assist-agent` открыл PR и смержен;
`ci-run` на тестовой ветке agent даёт зелёный и красный (сломанный тест виден в ответе);
прогон не деплоит; повторный `ci-setup` = «уже настроено»; `ci-setup` на репо без CI создаёт
рабочий workflow; оба плейбука видны в `playbook_list` на проде. Затем — пачкой по остальным
репозиториям орг.

## 6. Риски и откат

- **R1. Dispatch в чужой `ci.yml` может включить деплой-джобы.** Правило 2.1а: правим
  существующий workflow только если все deploy/merge-джобы загейжены от `push`/`pull_request`;
  иначе — отдельный `manual-tests.yml`. Откат: revert PR в целевом репо (workflow_dispatch
  уходит, PR-пайплайн не затронут).
- **R2. Неизвестный ключ валидатора до деплоя ядра** → `task_item_wait` отвергает `until`.
  Митигация: PR-A (ядро) первым. Откат: revert.
- **R3. Тест «ровно 3 плейбука» упадёт.** Митигация: правка в том же PR, требование изменилось
  (владелец добавил два плейбука) — явная замена, не skip.
- **R4. `verify-local` общий → меняет все change-плейбуки** (агенты начнут пушить ветку в
  verify-local). Митигация: fallback на локальный полный прогон для ненастроенных репо.
  Откат: revert правки библиотеки + `npm run build:playbooks`.
- **R5. Concurrency.** Группа только `manual-tests-<ref>`, `cancel-in-progress: true` — ручной
  запуск не может отменить PR-CI (у него своя группа). Существующий `concurrency` в чужом
  workflow не трогаем.
- **R6. Прав GH-токена** (нет `workflow`/`actions`) → явная ошибка `no-github-token`/отказ API;
  обходов (новых моделей доступа) не заводим.
- **R7. Прод-чекаут обновляется деплоем агента** — без синка (§5) плейбуков и тула на проде
  нет. Шаг синка в плане явно.
- **R8. Миграций данных нет.** Полный откат: revert PR-A и PR-B (репозитории независимы);
  шаблон и тул уходят вместе с PR; ранее добавленный `workflow_dispatch` в целевом репо
  убирается отдельным revert-PR.
