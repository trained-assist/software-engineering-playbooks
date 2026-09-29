# Дизайн: pr_status / issue_status (#52)

Шаг 4 плана a738d291. Вход: [scenario](pr-issue-status.md), [requirements](pr-issue-status-requirements.md), [context](../context/pr-issue-status-context.md).

## 1. Proposal

**Зачем.** Агент одним вызовом получает «где сейчас изменение» (открыт/смержен, чеки, сжатый хвост логов упавших джобов, доехал ли до прода, есть ли autofix-PR) без ручного токена и ~6 сырых вызовов GitHub API. Негативная ценность: нет ложного «в проде» по зелёному deploy-джобу, токен не утекает.

**Что меняется (код):**

| Файл | Что |
|---|---|
| `src/github/client.js` | новый: `getToken/hasToken/ghFetch/ghGraphql` — вынос из `60-github.js` |
| `src/github/compress-log.js` | новый: вендор `compressLog` из pr-autofix |
| `src/github/pr-status-core.js` | новый: ядро `prStatus()`, `issueStatus()`, verdict, autofix, prod |
| `src/mcp-skills/tools/62-pr-status.js` | новый: регистрация `pr_status`, `issue_status` |
| `src/mcp-skills/tools/60-github.js` | клиент → require; `github_pr_checks.handler` → делегирует ядру; описание |
| `src/mcp-skills/tools/63-ci-cd.js` | описание: ссылка на `pr_status` для разовой проверки |
| `package.json` (`check`), `tests/registry-core-modules.test.js`, `README.md` | новые файлы в check, новые имена в реестре, список тулов |

**Влияние.** Наружу — только новые тулы + `github_pr_checks` получает надмножество полей (`pr`, `ci`, `summary`, `check_runs` сохраняются). Реестр подхватывает модуль автоматически (новый файл в `tools/`). Данные не хранятся, миграции нет, других сервисов не затрагивает. `provider-manifest.json` не трогаем: GitHub-тулы в него не входят (`manifest:check` предупреждает, но не падает).

## 2. Design

### Структура

```
src/github/
  client.js           # getToken, hasToken, ghFetch, ghGraphql, GitHubApiError(status)
  compress-log.js     # вендор compressLog из pr-autofix@<sha>
  pr-status-core.js   # prStatus(), issueStatus() + чистые помощники
src/mcp-skills/tools/62-pr-status.js  # pr_status, issue_status (core-shaped)
```

Почему не проще: 60-github.js (482 строки) отвечает за CRUD `github_*` — расширять его двумя новыми чтениями с GraphQL и прода значит держать три ответственности в одном файле; `compressLog` импортировать из pr-autofix нельзя (ESM-скрипт исполняет верхнеуровневый код); `getToken` дублировать нельзя (две копии → рассинхрон прав).

### Клиент (client.js)

- `getToken()` — как сейчас: env → `~/agent-tokens/<USER_ID>/github` через `readTokenValue`. Ошибка не содержит значения токена.
- `hasToken()` — булев проверка, которой 60-github.js делится с новым модулем (иначе `isReady` продублируется).
- `ghFetch(path, opts)` — формат ошибки сохраняем (`GitHub API <status>: <msg>` — на него опирается существующий тест), но бросаем `GitHubApiError` со свойством `status` (число) и `path`.
- `ghGraphql(query, variables)` — POST `/graphql` тем же токеном; `errors[0].type` мапим в `status` (FORBIDDEN→403, NOT_FOUND→404, RATE_LIMITED→429) и бросим тот же `GitHubApiError`.
- `classify(err)` → код: 401→`GITHUB_AUTH`, 403/429→`RATE_LIMITED` (+`reset_at` из `x-ratelimit-reset`), 404→`NOT_FOUND`.

### Ядро `prStatus(repo, pr_number, {include_logs=true, head_sha?})`

Не бросает: возвращает либо `ok:true` + поля, либо `ok:false, error:{code, message, hint?}` (R12).

1. `GET /repos/{r}/pulls/{n}` → `state`, `head_sha`, `merged`, `merge_commit_sha`, `merged_at`, `html_url`.
2. 404 на pulls → `GET /repos/{r}/issues/{n}`: существует → `error NOT_A_PR` (hint: «используй issue_status»); нет → `NOT_FOUND`.
3. Чеки по `head_sha || pr.head.sha`: check-runs → пусто → commit-status фолбэк → `GET /actions/runs?head_sha=` (fine-grained PAT, R13). Три источника сводит **одна** функция `verdictOf(runs, commitStatus, actionsRuns)`.
4. В ответ: `ci.status` — legacy-значения `success|failure|pending|no-checks|neutral` (семантика как сейчас, включая skipped→no-evidence), `ci.verdict` — новая шкала `red|green|pending|none`, плюс `summary` и `check_runs` как в `github_pr_checks`.
5. Для проваленных джобов: `GET /actions/runs/{run}/jobs` (run_id из `check_run.details_url`/check_suite или `actions/runs?head_sha=`) → по каждому `conclusion ∈ {failure,action_required,timed_out,cancelled}` `GET /actions/jobs/{id}/logs` (fetch следует 302) → хвост 60k символов → `compressLog(бюджет ~400 токенов)` → `failed_jobs:[{name, url, log_tail, log_error?}]`, максимум 3 джоба. Лог недоступен (410/404) → `log_tail:null, log_error:"expired"`.
6. autofix: `GET /repos/{r}/pulls?state=all&per_page=50` → фильтр `head.ref` по `^fix/ci-<safe>-` (safe = ветка с заменой не `[a-zA-Z0-9-]` на `-`, обрезка до 40 — как в `autofix.mjs:1786`) → самый свежий → `autofix_pr:{number,url,state,checks_verdict}`. Ошибка шага глотается → `autofix_pr:null, autofix_error:"..."` (поиск autofix не должен валить основной ответ).
7. prod (только если merged):
   - `repo === 'trained-assist/trained-assist-agent'` → `GET ${AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io/agent'}/health` → `commit` → `GET /repos/{r}/compare/{merge_commit_sha}...{commit}` → `identical|ahead` → `prod:{verdict:'live', source:'health-compare'}`; `behind|diverged` → `'not_yet'`; таймаут/нет commit → `'unknown', evidence:'health-unreachable'`.
   - иначе → всегда `'unknown'`; `evidence:'deploy-green'` если `GET /actions/runs?head_sha={merge}` содержит успешный run с именем `/deploy/i`, иначе `'no-prod-endpoint'`; `source:'deploy-job'|'none'`.
   - `live` **только** из health-compare (решение по ⚫ R9); deploy-job и `merged_at` — в evidence/source, никогда в verdict.
8. Бюджет ответа (R11): `estTokens(JSON)`; больше ~1.5k → обрезать (`check_runs` ≤20, `failed_jobs` ≤2, в логах только хвост) с явными `truncated:true, truncated_omitted:{check_runs:N, failed_jobs:M}`.

### Ядро `issueStatus(repo, issue, {include_logs=false, max_prs=10})`

1. `GET /repos/{r}/issues/{n}` → `{state, title, html_url}` (PR-номер здесь не важно — принимаем и PR, оба состояния отдаём).
2. Связанные PR, в порядке приоритета:
   - GraphQL `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT, CONNECTED_EVENT])` → `source ... on PullRequest {number state merged headRefName repository{nameWithOwner}}` (проверено 29.09 на agent#1725: 4 PR в 2 репо);
   - REST-фолбэк при ошибке GraphQL: `GET /issues/{n}/timeline` (Accept: `application/vnd.github.mockingbird-preview+json`), события `cross-referenced`;
   - плюс ссылки из тела issue и комментариев: `#N`, `owner/repo#N`, URL `/pull/N`, `Closes/Fixes #N` — regex по тексту.
   - дедуп по `owner/repo#N`.
3. Первые `max_prs` (≤10) → по каждому `prStatus(..., {include_logs:false, enrich:false})` — компактно: `state/merged/verdict/checks` без логов, autofix и prod; параллелизм ≤3 (лимиты: graphql 5000/ч).
4. Cross-repo PR без доступа → `{ref, error:'no_access'}`, остальные отдаются.

Ответ: `{ok:true, issue:{state,title,url}, prs:[{repo,number,url,state,merged,verdict,checks:{...}}], prs_omitted:N}`.

### Регистрация и алиасы (R4, R5)

- `62-pr-status.js` — core-shaped `{isReady: hasToken, setupTools: [], tools:{pr_status, issue_status}}`; gated как `github_*` при отсутствии токена.
- `60-github.js.github_pr_checks` → хендлер вызывает ядро `prStatus(..., {enrich:true})` и возвращает тот же объект; при `ok:false` **бросает** `new Error(error.message)` (существующий тест ждёт throw с «404»). Описанию — «alias of pr_status; prefer pr_status».
- `63-ci-cd.js.cicd_track_pr` — описание += «для разовой проверки статуса вызывай pr_status» (сам тул не меняется: он регистрирует checklist.md для GTD, это не чтение статуса).

## 3. Spec delta

- **МЕНЯЕТСЯ:** `docs/user-scenarios/engineering/pr-issue-status.md`, п.5 — уточнить: алиас реализован как делегирование ядру с сохранением throw-поведения ошибок (`github_pr_checks` бросает, `pr_status` возвращает типизированный `ok:false,error`); решение фиксируется в PR (там же, как и записано в сценарии).
- **ДОБАВЛЯЕТСЯ:** этот файл (design). Живые сценарии не разрастаются.
- **УДАЛЯЕТСЯ:** ничего.

## 4. Срезы (tasks)

Строгий порядок: каждый срез закоммичен в ветку до следующего.

| # | Срез | Файлы | Тест в том же срезе |
|---|---|---|---|
| S1 | Вынести клиент + `ghGraphql` | `src/github/client.js`, правка `60-github.js` | существующие `tests/github-pr-checks.test.js` и `tests/registry-core-modules.test.js` зелёные **без правок** |
| S2 | Вендор `compressLog` | `src/github/compress-log.js` | новый `tests/compress-log.test.js`: паритет сжатия ошибок, бюджет, хвост |
| S3 | Ядро PR: state + чеки + verdict + failed_jobs | `src/github/pr-status-core.js` | новый `tests/pr-status.test.js`: green / red+лог / pending / none / 401 / 404 / 410-лог |
| S4 | autofix + prod + бюджет | тот же файл | расширение `tests/pr-status.test.js`: autofix найден/отсутствует; prod live/not_yet/unknown+deploy-green; `truncated` |
| S5 | `issue_status` | тот же файл | новый `tests/issue-status.test.js`: 2 PR в 2 репо, дедуп, `no_access`, пустой список, REST-фолбэк |
| S6 | Регистрация + алиасы | `62-pr-status.js`, `60`, `63`, реестр-тест, `package.json`, `README` | `tests/registry-core-modules.test.js` пополняется: `pr_status`, `issue_status` в списке, `github_pr_checks` остаётся |
| S7 | Живая приёмка | без файлов (вызов из сессии) | отчёт в issue #52 |

## 5. План проверки (шаг сценария → проверка → уровень S)

| Шаг сценария | Проверка | Уровень |
|---|---|---|
| 1 — красный PR + логи | `tests/pr-status.test.js`, фикстуры `/pulls/42`, `check-runs`, `runs/1/jobs`, `jobs/2/logs` | S3 |
| 2 — autofix-PR | фикстура `GET /pulls?state=all` с `fix/ci-…` | S3 |
| 3 — смержен + прод | фикстура health-compare `identical`/`behind` + deploy-run | S3 |
| 4 — issue с PR в разных репо | `tests/issue-status.test.js` (GraphQL фикстура) | S3 |
| 5 — алиасы | `tests/github-pr-checks.test.js` **без правок** + `tests/registry-core-modules.test.js` | S3 |
| 6 — бюджет ответа | ассерт `truncated:true` и `truncated_omitted` | S3 |
| крайние случаи | 401→`GITHUB_AUTH`, 429→`RATE_LIMITED`, 410→`log_error:'expired'`, `NOT_A_PR` | S3 |
| живые вызовы | `pr_status` на `trained-assist/trained-assist-agent#1843` (merged, ожидаем `live`), `#1832` (красный — перепроверить), `issue_status` на `agent#1725` (≥2 PR в 2 репо) | S4 |
| команда | `npm run check && npm test && npm run manifest:check` | S3 |

Граница человека (S4 — реальные зависимости, дальше автоматизировать нечего): владелец смотрит вывод живой приёмки в issue #52.

## 6. Риски и откат

| Риск | Цена / кто ломается | Откат |
|---|---|---|
| `github_pr_checks` получает надмножество полей и лишние запросы (autofix/prod) | тесты смотрят `ci.status/summary/check_runs` — они сохранены; сбои обогащения глотаются | revert одного PR |
| дрейф вендора `compressLog` от pr-autofix | две копии; ловится только при обновлении pr-autofix | функция изолирована, revert одного файла |
| GraphQL timeline изменится/недоступен | есть REST-фолбэк | ветка фолбэка, отдельно |
| rate limit при issue с N PR | ≤10 PR, параллелизм 3, только summary | параметры, не код |
| прод-compare даст `not_yet` из-за отставшего релиза | консервативный ответ безопасен (не `live`) | не нужен |
| вынос клиента ломает `github_*` | все существующие тесты зелёные до перехода к S3 | revert S1 |

Флаг не нужен: всё read-only, новых наружу состояний нет — ошибочный тул читает и отвечает ошибкой, не пишет. Флаг создал бы вторую ветку поведения, которую пришлось бы тестировать обе. Миграция данных — нет (кэша на диске нет, ответы stateless). Откат = revert PR в `main` → CI → автодеплой сиблингов при деплое агента, синхронизации не требуется.
