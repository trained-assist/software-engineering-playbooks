# Карта контекста: pr_status / issue_status (#52)

Шаг 2 плана a738d291. Сценарий: [docs/user-scenarios/engineering/pr-issue-status.md](../user-scenarios/engineering/pr-issue-status.md).

## Точки входа и что есть сейчас

| Что | Где | Вывод |
|---|---|---|
| Регистрация MCP-тулов | `src/mcp-skills/registry.js:28-50` | Модуль core-формы `{isReady, setupTools, tools}`; механизма алиасов нет — алиас = второй ключ в `tools` с тем же handler. |
| Токен GitHub | `src/mcp-skills/tools/60-github.js:17-29` (`getToken`), `:31-52` (`ghFetch`) | Штатный путь: `GH_TOKEN`/`GITHUB_TOKEN` → `~/agent-tokens/<USER_ID>/github`. Живой вызов `github_status` 29.09 — токен рабочий (classic, `repo`+`workflow`: логи джобов читаются). Переиспользуем как есть. |
| `github_pr_checks` | `60-github.js:296-383` | PR → head sha → check-runs, фолбэк на commit status. Нет: логов падений, мерж-коммита, прода, autofix-PR, фолбэка на actions/runs. → поглощаем: становится алиасом `pr_status` (ответ-надмножество: поля `pr`, `ci`, `summary`, `check_runs` сохраняем). |
| Тест `github_pr_checks` | `tests/github-pr-checks.test.js` (стаб `globalThis.fetch` по префиксам URL) | Шаблон фикстурного юнита для нового тула; существующие ассерты должны пройти через алиас без правок. |
| `cicd_track_pr` | `src/mcp-skills/tools/63-ci-cd.js:27-77` | Пишет `checklist.md` для GTD — это регистрация, не чтение статуса. НЕ дубль, не трогаем (кроме ссылки на `pr_status` в описании). |
| Тест реестра | `tests/registry-core-modules.test.js:35` | Проверяет наличие `cicd_track_pr`; добавить проверку `pr_status`/`issue_status`/алиаса. |
| `npm run check` | `package.json:12` | Новый модуль (если отдельный файл) надо дописать в список `node --check`. |

## Переиспользуем

1. **Сжатие логов** — `compressLog` в `trained-assist/pr-autofix` `scripts/autofix.mjs:535-580` (+ `LOG_ERROR_RE`, `LOG_TOKEN_BUDGET=2500`, `estTokens`). Скрипт исполняет верхнеуровневый код при импорте (`:1341` и далее) — импортировать нельзя. Решение: вендорить чистую функцию в `src/github/compress-log.js` с шапкой «копия из pr-autofix@<sha>, держать в синхроне» + свой юнит. Бюджет для pr_status меньше (≈400 токенов на джоб), чтобы уложиться в ~1.5k на PR.
2. **Сбор лога джоба** — как в autofix `:1320-1330`: `GET /repos/{r}/actions/runs/{run}/jobs` → для `conclusion=failure` `GET /actions/jobs/{id}/logs` (302 → fetch следует), хвост 60k символов → compressLog. run_id берём из `check_run.details_url`/`check_suite`, либо `actions/runs?head_sha=`.
3. **Правило «зелёный»** — `trained-assist-agent src/playbook-validators.js:108-121` (`GREEN_CONCLUSIONS = success|skipped|neutral`, `checkRunsGreen`: null если ничего не прогналось). Импортировать из агента нельзя (другой репо), поэтому повторяем ту же семантику и фиксируем фикстурой «все skipped → no-evidence, не success». Фолбэк на `actions/runs?head_sha=` (`:144-152`) для fine-grained PAT — тоже берём.
4. **Имя autofix-ветки** — `autofix.mjs:1786-1788`: `fix/ci-${branch.replace(/[^a-zA-Z0-9-]/g,'-').slice(0,40)}-${ts}`. Поиск: `GET /repos/{r}/pulls?state=all&per_page=50` + фильтр по префиксу head.ref (так же autofix закрывает старые, `:1850-1858`).
5. **Связанные PR у issue** — GraphQL `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT, CONNECTED_EVENT])` → `source ... on PullRequest {number state merged repository{nameWithOwner}}` + `closedByPullRequestsReferences(includeClosedPrs:true)`. Проверено 29.09 на agent#1725: timeline дал 4 PR в 2 репо (agent#1838/#1842/#1843, software-engineering-playbooks#48), а `closedByPullRequestsReferences` — пусто. Значит основной источник — timeline; REST-фолбэк `GET /issues/{n}/timeline` (event=cross-referenced). `ghFetch` сейчас только REST — нужен `ghGraphql` рядом.

## Реальные ограничения (контракты)

- **Прод агента** = `commit` в `https://136-65-7-197.sslip.io/agent/health` (`server.js:593-595`, короткий sha, доступен из слота без ssh; `localhost:8080` из слота закрыт). «В проде» = merge_commit_sha начинается с health.commit ИЛИ является его предком (`GET /repos/{r}/compare/{merge}...{health}` → `status` ∈ identical|ahead). Зелёный `deploy-gcp` — не доказательство (правило владельца).
- **Доменные скилы и этот репо** своего деплоя не имеют: `trained-assist-agent scripts/deploy.sh:131-154` (`ensure_sibling`) подтягивает main сиблингов только при деплое агента; `/health` их sha не отдаёт. Честный ответ для них: `prod: unverified` + эвристика «деплой агента после merged_at» с явной пометкой. Точный ответ требует в агенте отдать sha сиблингов в `/health` (отдельный PR в trained-assist-agent — открытый вопрос).
- **tg-bot / web** (Cloudflare) деплоит их CI; health-эндпоинта с sha нет → `prod` определяем по job `deploy*` в workflow-runs на merge_commit_sha, помечая `source: deploy-job` (слабее, чем health).
- **Имена чеков различаются**: agent — `ci`, `staging-gate`, `merge`, `deploy-gcp`, `deploy-ru`, `autofix` (ci.yml агента); playbooks — `test`; tg-bot/web — свои. Тул не хардкодит `ci+staging-gate`, а показывает все, выделяя `ci`/`staging-gate` если есть.
- **Check-runs vs commit status**: CI пишет check-runs, combined `/status` вечно `pending` (agent-notes 2026-09-13) — status использовать только как фолбэк при пустых check-runs.
- **Лимиты**: GitHub core 5000/ч, graphql 5000/ч; issue с N PR = ~N×4 запросов → ограничить параллелизм и N (по умолчанию ≤10 PR, без логов по вложенным PR — только сводка).
- **«Так уже написано», можно менять**: формат ответа `github_pr_checks` (кроме полей, на которые смотрят тесты), отсутствие алиасов в реестре, отсутствие GraphQL-клиента.

## История

- agent#1570 — добавлен `github_pr_checks`; playbooks#35 / agent#1651 — github_*/dev_*/cicd_track_pr переехали в этот репо (#1631). Попыток сделать pr_status/issue_status не было, отклонённых решений нет.
- Бэклог #50 п.2 → #52 (одобрено 29.09).

## Снаружи

⏭ Не нужно: возможность строится из GitHub REST/GraphQL, уже используемых в продукте; аналоги (`gh pr checks`, `gh pr view --json statusCheckRollup`) требуют бинарь gh и токен в сессии — ровно то, от чего уходим.

## Кандидаты для живой приёмки

- issue ≥2 PR в разных репо: `trained-assist/trained-assist-agent#1725`.
- смерженный PR: `trained-assist/trained-assist-agent#1843` (в проде должен быть: health.commit `0e4be3b` 29.09).
- красный PR: `trained-assist/trained-assist-agent#1832` (open, FAILURE на 29.09) — перепроверить на шаге приёмки.

## Открытые вопросы (не блокируют)

1. Отдавать sha сиблингов в `/health` агента (точный «в проде» для скилов) — отдельный PR в agent, после этого PR.
2. Где жить коду: новый модуль `src/mcp-skills/tools/62-pr-status.js` + чистые функции в `src/github/` (рекомендация) vs расширение 60-github.js (уже 482 строки).
