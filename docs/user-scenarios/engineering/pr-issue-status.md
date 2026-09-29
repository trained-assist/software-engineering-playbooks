# Сценарий: «что с PR / что с issue» одним вызовом

Issue: trained-assist/software-engineering-playbooks#52 (бэклог #50, п.2). Одобрено владельцем 29.09.2026.

## Ценность

Агент в инженерной сессии (и владелец через него) одним MCP-вызовом получил ответ
«где сейчас это изменение»: PR открыт/смержен, зелёные ли ci и staging-gate, почему
упало (сжатый хвост лога), доехал ли мерж до прода, есть ли autofix-PR — без ручного
токена, без ~6 сырых вызовов GitHub API и без чтения 100k-символьных логов.

Негативная ценность: агент НЕ получил ложное «доехало до прода» по зелёному deploy-джобу
и НЕ увидел токен в ответе/логах.

## Доказанность: V5

Источник — разбор ~13 000 команд за 10 дней (issue #50): ~130 ручных доставаний токена
из `git remote get-url` и ~260 прямых обращений к GitHub API за статусом PR, прогонами и
логами упавших джобов. Ценность получают сейчас обходным путём (curl+jq+python в каждой
сессии), плюс agent-notes фиксируют класс ошибки «смержено ≠ в проде» (шлюз, 11.09).

## Актор и предусловия

- Актор: агент в сессии профиля (Claude/Codex через MCP `engineering-skills`).
- Токен: берётся внутри тула тем же путём, что у `ghFetch` в `60-github.js`
  (ENGINEERING_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN / gh auth). Ручных шагов нет.
- Прод-проверка: для `trained-assist/trained-assist-agent` — commit в
  `GET localhost:8080/health` (через доступный сессии путь); для прочих репо — итог
  последнего deploy-workflow на `main` c SHA мерж-коммита либо «unknown».

## Шаги

1. `pr_status(repo, pr)` — открытый PR с упавшим CI.
   КОГДА агент вызывает `pr_status({repo:"trained-assist/X", pr:N})` на открытом PR
   ТОГДА система возвращает `state:"open"`, head SHA, сводку чеков по head
   (`ci`, `staging-gate` — по имени, остальные агрегатом) с итогом `red|green|pending|none`,
   и для каждого упавшего джоба — `failed_jobs[]: {name, url, log_tail}`, где `log_tail`
   сжат `compressLog` из pr-autofix (бюджет ~600 токенов на джоб, ≤3 джоба).
2. Тот же вызов — есть autofix-PR.
   КОГДА у PR существует открытый/смерженный PR с head `fix/ci-<safeBranch>-*`
   ТОГДА в ответе `autofix_pr: {number, url, state, checks_verdict}`; нет — `autofix_pr:null`.
3. `pr_status` на смерженном PR.
   КОГДА PR смержен ТОГДА `state:"merged"`, `merge_commit_sha`, `merged_at`, чеки по
   мерж-коммиту на main, и `prod: {verdict: "live"|"not_yet"|"unknown", evidence}`:
   `live` только если прод-коммит равен мерж-коммиту или является его потомком;
   зелёный deploy-джоб без health — `unknown`/`deploy_green`, не `live`.
4. `issue_status(repo, issue)`.
   КОГДА агент вызывает `issue_status({repo, issue})`
   ТОГДА система собирает связанные PR из timeline (cross-referenced / connected),
   тела и комментариев (`#N`, `owner/repo#N`, URL PR, `Closes/Fixes #N`), включая
   PR в других репозиториях, и возвращает `issue:{state,title}` + `prs[]` с тем же
   компактным статусом по каждому (без логов, если не `include_logs:true`).
5. Алиасы. КОГДА вызывается `github_pr_checks(repo, pr_number)` ТОГДА он отдаёт тот же
   результат через ядро `pr_status` (обратная совместимость полей total/summary/runs).
   `cicd_track_pr` — НЕ дубль (пишет checklist.md для GTD, это регистрация, а не чтение
   статуса); остаётся отдельным, в описании ссылается на `pr_status` для разовой проверки.
   Решение фиксируется в PR.
6. Бюджет ответа. КОГДА вызывается любой режим ТОГДА ответ ≤ ~1.5k токенов на PR;
   обрезка явная (`truncated:true`, счётчик опущенного), не молчаливая.

## Не-цели

- Не мержит, не перезапускает джобы, не создаёт autofix — только чтение.
- Не ставит на отслеживание (это `cicd_track_pr` / GTD).
- Не заменяет плейбук «Проверка в проде» (бэклог #50 п.3): даёт факт, не откат.
- Не GitHub MCP и не вебхуки (решение 29.09).

## Крайние случаи

- Нет прогонов на head (workflow не запускался) → `checks_verdict:"none"`, не `green`.
- Прогон ещё идёт → `pending`, логи не тянем.
- Лог джоба недоступен (410 expired / 404) → `log_tail:null, log_error:"expired"`.
- Нет токена / 401 → явная ошибка `GITHUB_AUTH` с подсказкой, без утечки значения токена.
- Rate limit 403/429 → ошибка `RATE_LIMITED` с reset-временем.
- PR/issue не существует → `NOT_FOUND`.
- Номер — issue, а не PR (в `pr_status`) → `NOT_A_PR` с подсказкой `issue_status`.
- Issue без связанных PR → `prs:[]`.
- Повторные ссылки на один PR в issue → дедуп.
- Cross-repo PR в репо без доступа → запись `{ref, error:"no_access"}`, остальные отдаются.
- Прод недоступен (health таймаут) → `prod.verdict:"unknown"` с причиной.

## Приёмка (вход для тестов)

- Юнит на фикстурах GitHub API: merged / red (с логом) / green / no-runs / autofix-PR /
  issue с 2 PR в разных репо / 410 лог / 401.
- Живой вызов из сессии: реальный смерженный PR, реальный красный PR, issue с ≥2 PR
  в разных репо.

## Открытые вопросы / риски

- `compressLog` живёт в pr-autofix `scripts/autofix.mjs` (ESM-скрипт, не пакет).
  Рекомендация: портировать функцию в engineering-skills с тестом-паритетом и ссылкой
  на источник; общий пакет — отдельная задача. Риск: дрейф двух копий.
- Прод-проверка агента из слота: порт 8080 закрыт в слотах, нужен путь через публичный
  health (`AGENT_PUBLIC_URL/health`) — проверить на шаге песочницы.
