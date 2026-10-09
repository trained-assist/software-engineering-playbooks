# Requirements log

> **История, а не текущий статус.** Текущий статус требований живёт в GitHub issues
> (правило владельца 2026-09-28). Новые строки сюда не добавляются; файл сохраняется как
> снимок решений до 2026-10-02.

Living list of requirements/features and their status. Statuses: `реализовано`,
`отклонено (почему)`, `планируется`, `в работе`.

## Workspace accelerator (E1 / Track A, issue #3)

- [реализовано] `spawnWorkspace()` core: git worktree from exact committed revision via
  registered source checkout, outside the live checkout; no reset/stash/clean; dirty source not
  carried; unique branch/worktree without force; atomic metadata; verified HEAD → `code_ready`.
- [реализовано] Ownership/lease `(principal, repository, rootTaskId)` with lease generation;
  idempotency by operation key (repeat → same workspace / in-progress; incompatible args → conflict).
- [реализовано] `statusWorkspace()` and `releaseWorkspace()` via the same API.
- [реализовано] Crash recovery: reconcile provisioning intents with `git worktree list --porcelain`;
  orphans retained, never auto-deleted.
- [реализовано] Conservative release: dirty/untracked/unpushed/stash/unknown remote/delivery →
  retained/needs_review; squash-merge requires host delivery evidence; TTL is not `rm -rf`.
- [реализовано] Library-first boundary: no MCP dependency; binding is host-resolved; optional
  `allowedRoots` host policy; symlink/path escape rejected.
- [реализовано] CLI adapter (`workspace-spawn`/`workspace-status`/`workspace-release`/
  `workspace-reconcile`), tests, local proof script.
- [планируется] E2 `runtime_ready`: dependencies/cache, fixtures, ports, dev-server/health,
  supervision, cleanup.
- [отклонено (в этой задаче)] MCP runtime wiring, provider manifest/lockfile packaging,
  core handoff (cwd/env/resume) — Track B / A2, не нужны для библиотечных тестов и proof.

## Minimal self-service `engineering_spawn_workspace` (2026-09-26, revises PR #4's original design)

Requirements re-derived from the actual task (two agents under one profile silently corrupting
each other's shared git checkout/branch), not from the earlier multi-tenant/security-hardening plan
in trained-assist-agent#1353 that this originally inherited its shape from. See that issue's
2026-09-26 status block for the full reasoning; `spawnWorkspace()`'s crash-safe state machine
itself was judged genuinely earned complexity and is untouched.

- [реализовано] `layoutFor()` branch naming: `eng/<principal>-<rootTaskId>` (readable — a session
  or a human can tell whose task a branch/PR is by name) instead of an opaque `eng/ws-<hash>`.
  Uniqueness still comes from git's own `BRANCH_COLLISION` on the git-worktree layer, unchanged.
- [реализовано] `src/workspace/for-task.js`: `spawnWorkspaceForTask()` / `statusWorkspaceForTask()`
  / `releaseWorkspaceForTask()` — the actual session-facing surface. Takes only
  `{principal, repositoryUrl, rootTaskId}`; resolves `sourceCheckout` (clone-if-missing mirror,
  fetched on every call), `baseRevision` (default branch tip), `idempotencyKey` (= `rootTaskId`),
  `hostId` (= `os.hostname()`) automatically. `spawnWorkspace()`/`statusWorkspace()`/
  `releaseWorkspace()` remain available directly for callers that need the low-level fields.
- [отклонено] `rootTaskId` as a host-injected/hidden field — it's the session's own readable task
  label and a legitimate required argument, not something to hide (see #1353 thread).
- [отклонено] `allowedRoots` host-issued filesystem binding / "LLM must never set repo_path" as a
  hard requirement for this same-company, first-party repository — access is already gated by the
  calling profile's own git credentials. Deferred, not designed away: `allowedRoots` still exists
  and works in `spawnWorkspace()` if a less-trusted source ever needs it.

## MCP wrapper: `engineering_spawn_workspace` / `_status` / `_release` (issue #6)

- [реализовано] `src/mcp-skills/tools/20-workspace.js` exposes the three `for-task.js` functions as
  MCP tools, same shape as `engineering_prepare_task`. Inputs are only `repository_url` +
  `root_task_id` (spawn also `ref`; release adds `processes_stopped`/`force`/`delivery_evidence`).
  `principal` is never an argument — read from `process.env.USER_ID` inside the handler (matching
  trained-assist-agent's `mcpToolEnv`, so an argument can't override profile identity).
- [реализовано] Registered in `src/mcp-skills/registry.js`; `tests/mcp-workspace-tools.test.js`
  drives spawn→status→release through `registry.callTool()` against a bare-repo fixture, asserting
  env-wins and typed `INVALID_BINDING` errors for missing fields.
- [реализовано] Optional host override of workspace/mirror roots via
  `ENGINEERING_WORKSPACE_ROOT` / `ENGINEERING_MIRRORS_ROOT` (defaults to `~/agent-data/...`); needed
  so tests stay hermetic, and lets a host place workspaces outside the default home.
- [реализовано] Resume after the base branch moved (2026-09-27): a repeat
  `engineering_spawn_workspace` with the same `root_task_id` returns the existing `code_ready`
  workspace before refreshing the mirror. Before, the re-resolved `baseRevision` changed the
  operation fingerprint and a legitimate resume failed with `CONFLICT` ("idempotency key was
  already used with incompatible arguments") — seen on the VM, 1 of 11 real calls on 2026-09-27.
- [планируется] The operation key is the bare `root_task_id`, global across principals and
  repositories: the same label for a different repo/profile gets `CONFLICT` (safe, never another
  task's workspace, but blocks the call). Not hit on the VM so far.

## Engineering tools moved from trained-assist-agent core (trained-assist-agent#1631, 2026-09-27)

- [реализовано] `60-github` (github_*), `61-dev` (dev_workspace_setup / dev_new_repo /
  dev_supersede_pr), `63-ci-cd` (cicd_track_pr) served by this repo's `engineering-skills` MCP
  server; core deletes its copies. Tool names unchanged.
- [реализовано] `dev_workspace_setup` calls `spawnWorkspaceForTask` in-repo — core's
  `engineeringLibPath()` / `ENGINEERING_WORKSPACE_LIB` path into the sibling is gone.
- [реализовано] Core couplings cut: `token-value.js` mirrored; git hooks copied to
  `templates/githooks/`; `cicd_track_pr` only needs the `checklist.md` filename (the GTD
  controller in core scans it).
- [реализовано] Registry: auto-discovers `tools/*.js`, supports core-shaped modules
  (`isReady`/`setupTools`), `listAllTools()` for core's headless transport, `SKILLS_RESOLVED` filter.
- [реализовано] Prompt domains `engineering`, `github.setup` live in `src/prompt-domains/`.

## Repository indexer v1 + engineering_repo_context + QA logs (issue #11)

- [реализовано] Deterministic index v1: `buildIndex()` writes `.engineering/index/`
  (`revision.json` with schemaVersion/repo identity/indexed revision/generatedAt; `files.json`;
  `modules.json` + hotspots; `symbols.json`; `tests.json`). No LLM; git tree metadata +
  regex symbol scan + test mapping + git-history hotspots. `scripts/index-repo.js`
  (`--check` for the refresh/check helper); `npm run index:build` / `index:check`.
- [реализовано] `prepare_task` keeps `prefer_index` (default true) but now rejects/falls back
  from an index that is missing, corrupt, schema-incompatible, for another repo, or stale for
  the current HEAD. Indexing is never a correctness dependency; raw fallback is untouched.
- [реализовано] `engineering_repo_context({repo_path, keywords, max_results?, budget?})`:
  queries a fresh index, otherwise the deterministic raw keyword ranking; returns ranked
  `{ path, line, snippet, why }`. No network, no LLM. Registered in the MCP registry +
  provider manifest.
- [реализовано] QA logs library: per-profile JSON registry at
  `ENGINEERING_QA_LOGS_ROOT/<profile>.json` (default `~/agent-data/qa-logs`), tools
  `qa_log_register` / `qa_log_lookup` / `qa_log_list`, profile from `USER_ID` (env wins).
  Entries store location + how-to-read only; a credential-material guard rejects secrets.
  Contract: `contracts/qa-log.schema.json`.
- [реализовано] CI contract: `tests/contract.test.js` guards registry↔provider-manifest drift
  and the dual context-source contract; `npm run manifest:check` validates the manifest against
  the registry.
- [отклонено (non-goals)] Embedding/vector index, nightly scheduler infra, credential binding,
  workspace-lifecycle changes. Semantic module summaries stay optional/off by default.

## pr-autofix service slice 1 — registration store + status (issue #15)

Design: `docs/PR-AUTOFIX-SERVICE.md` §1/§6. Additive, zero credential writes, no external GitHub
writes.

- [реализовано] `src/pr-autofix/registry.js`: per-profile JSON store keyed by `(profileId, repo)`
  at `ENGINEERING_PR_AUTOFIX_ROOT/<profile>.json` (default `~/agent-data/pr-autofix`). Record fields:
  `repo, base_branch, features{fix,cleanup,batch}, autofix_ref, capabilities, status,
  created_at, updated_at`. State enum `registered → credentials_bound → workflow_installed →
  active → disabled|error`; slice 1 only produces `registered`/`disabled`.
- [реализовано] `registerAutofix` = idempotent upsert (one record per repo, `created_at` stable,
  `updated_at` monotonic bump); it never lets the caller set `status` (no auto-enable) and keeps a
  `disabled` registration disabled. `disableAutofix` = kill-switch to `disabled`, idempotent.
- [реализовано] MCP tools `engineering_pr_autofix_register` / `_status` / `_disable`
  (`src/mcp-skills/tools/50-pr-autofix.js`), registered in the MCP registry + `provider-manifest.json`.
  Profile identity from `USER_ID` (env wins); local state only — no workflow install, no secret push.
  Descriptions note a later external-write slice will require approval.
- [реализовано] Capability records only: `capabilities` is a name→description map; a
  credential-material guard rejects raw secrets (`CREDENTIAL_REJECTED`) and no secret field is ever
  persisted. Contract: `contracts/pr-autofix-registration.schema.json`.
- [реализовано] Tests: upsert idempotency + `updated_at` bump, no-auto-enable, per-profile
  isolation, disable transition + idempotency, secret rejection/persistence guard, MCP env-identity
  round-trip; contract guards tool/manifest sync + schema enum.
- [отклонено (non-goals slice 1)] Workflow install, credential/secret delivery, `credential_refs` /
  `installed_workflow` fields, run-event lifecycle, notifications, reimplementing the fixer —
  slices 2/3.

## pr-autofix service slice 2a — workflow install/update, no credential writes (issue #17)

Design: `docs/PR-AUTOFIX-SERVICE.md` §3. Additive; external write = a PR to the target repo, but
**no** credential/Actions-secret writes.

- [реализовано] `src/pr-autofix/constants.js` + `installer.js`: given a registration and an injected
  GitHub capability (`ghFetch`/`ghToken`, injectable so tests never hit the network), builds
  `.github/workflows/pr-autofix.yml` pinned to an immutable `autofix_ref`, plus
  `.github/workflows/ci-fix-cleanup.yml` when `features.cleanup`. Opens a PR (base = `base_branch`)
  or updates the open install PR on `pr-autofix/install`. Idempotent: identical pinned job present
  → no PR; ref bump → update PR; deterministic single install branch.
- [реализовано] Trigger shape: dedicated `on: workflow_run` of the target CI workflow
  (`types: [completed]`), matched by `ci_workflow_name` (default `"CI"`, `workflow_run.workflows`
  uses the workflow `name:`, not filename). Job guard: failed run + pull_request event + a PR +
  head branch not `fix/ci-*`. `autofix_ref` must be `vX.Y.Z` or a 40-hex SHA; floating refs
  (`v1`, `main`, `HEAD`) are rejected (`INVALID_AUTOFIX_REF`). Default pinned ref `v1.2.1`.
- [реализовано] Tool `engineering_pr_autofix_install` (`{ repo, base_branch?, autofix_ref?,
  ci_workflow_name? }`), registered in the MCP registry + `provider-manifest.json` with
  `requiresApproval: true` (external write). On success advances `status` to `workflow_installed`
  and stores `installed_workflow { path, pinned_ref, installed_at, pr_url }`; `status` reflects it.
- [реализовано] GitHub capability resolved lazily from host env
  (`ENGINEERING_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN`) or an injected factory; the token is never
  persisted, returned or logged. `assertNoCredentialMaterial` still guards every write.
- [реализовано] Tests with an in-memory fake GitHub: exactly one PR with the pinned callable job,
  second install no-op, ref bump updates the open PR, post-merge bump opens a new PR, identical job
  present → no PR, cleanup workflow, immutable-ref + disabled/unregistered errors, status
  reflection, no-secret invariant, MCP round-trip + `GITHUB_NOT_CONFIGURED`.
- [отклонено (non-goals slice 2b)] ZeroCreds credential binding and pushing `OPENROUTER_API_KEY` /
  `AUTOFIX_PAT` to repo Actions secrets, run-event lifecycle, notifications, `disable` removing the
  installed workflow.

## Engineering playbooks feature / debugging / new-software (2026-09-27)

- [реализовано] Три исполняемых плейбука: `feature` (самый частый), `debugging`, `new-software`
  (Playbook Zero) — Playbook v1 JSON в `playbooks/`, резолвятся агентом из этого sibling-репо.
- [реализовано] Типизированная библиотека шагов `library/step-types.json` (24 типа): контракт шага,
  типичные под-шаги, DoD, лестницы V/R/S, флаги сложности ⚪🟢🟡🔴⚫, соответствие OpenSpec.
  Правило: новый шаг — только на границе исполнителя / проверки / ожидания; остальное — под-шаги.
- [реализовано] Сборка `scripts/build-playbooks.js` (источники → Playbook v1 + читаемые доки),
  тест синхронизации, схемы (vendored `contracts/playbook.schema.json`) и инвариантов процесса
  (песочница/воспроизведение до реализации, PR → CI → merge, в конце archive, проверка в реальности).
- [реализовано] Дизайн-док: sandbox-driven development + сверка с OpenSpec / Spec Kit / Kiro-EARS /
  Shape Up / ADR / Confidence Meter / TRAFFIC / SRE postmortem / Temporal.
- [реализовано] Ожидания (CI, merge, деплой, креды, ответ пользователя, ошибка в логах, таймер) —
  через durable wait движка (`trained-assist-agent`, `docs/specs/durable-wait-until.md`).
- [реализовано] Prose-процедуры `implement-feature.md` / `fix-bug.md` заменены указателями на
  исполняемые плейбуки (слайс D #1573); `prepare-task.md` / `connect-github.md` остаются процедурами.
- [планируется] Сжатый индекс репозитория для мини-ресерча в `define-use-case`.
- [планируется] Hermes-авторинг (`playbook_draft`) не знает про `wait` / `step_type`.
- [планируется] Переименовать sibling-чекаут на VM под новое имя репозитория.

## Скилл расчёта сложности: сложность → цена (2026-09-28, issue #41)

- [реализовано] Детерминированный движок `src/complexity/index.js` (commonjs, 0 deps, без I/O):
  **база = стоимость одного рабочего дня** `baseDayRub`(15000) × `tierDays`{T0:0.5, T1:1.0} × K —
  все коэффициенты = увеличители этого дня; всегда три цены (демпинг ×1, коммерческая ×2,
  хорошая ×2,5); observability-ось первична (закрытый API и закрытая инфраструктура —
  независимые ×3, перемножаются), «вширь» маленькая (1.0 / 1.3 / 1.4), остальные K — как в v3;
  все числа только в объекте `CONFIG` (правка числа ≠ правка логики); warnings: K≥5 (правило
  остановки), неизвестные поля/тир. Директива 2 от 28.09.2026 19:28 МСК.
- [реализовано] MCP-тул `engineering_estimate_complexity` (`src/mcp-skills/tools/64-complexity.js`,
  авто-обнаружение реестра, без правок `registry.js`); пустой вход → рабочий результат (тир T0
  + warning); `node --check` добавлен в `scripts.check`.
- [реализовано] Тесты-спецификация `tests/complexity-engine.test.js` (18 фикс-кейсов; числа
  базы/тирей выводятся из `CONFIG`, литралы — в одном пин-тесте) + сквозной сценарий
  `tests/complexity-tool.test.js` (6 кейсов через `registry.callTool`).
- [реализовано] Док модели `docs/complexity-estimation.md`: формула «день × K», ось
  observability, правило K≥5, связка со SbDD (уровень S = время петли = цена/риск, §5), честные
  open questions v3 (нет фактора объёма; перелёт на пересечении — Renovatio 820k против 241k;
  «закрытые IP» → закрытые API; внешние системы выпали из «вширь»; «сумма, опирающаяся на
  юзера» — механика не задана, в модель не внесена), разводка с флагами ⚪🟢🟡🔴⚫ (это про
  состояния фичи, не про цену), точка интеграции со спецификацией.
- [реализовано (2026-10, иначе чем планировалось)] Подключение `trained-assist-freelance-skill`
  не понадобилось: генерация ТЗ целиком переехала в этот репозиторий (issue #43, PR #44,
  `65-spec-generation.js`); оценка сложности используется ею вторично («Стоимость и сроки»),
  движок не дублируется — точка интеграции в `src/spec-generation/rules.js` и
  `docs/spec-generation-migration.md`.
- [отклонено (non-goals)] Риск-скоринг GO/NO-GO и генерация ТЗ не трогаются; множители «без
  CTO» (нет данных ×1,2–1,3, регулируемые ×1,2) зарезервированы в доке, в движок не заведены;
  экспозиция в `provider-manifest.json` отложена (паритет с соседями-тулами).

## Прогон тестов в облаке: `ci-setup` + `ci-run` (2026-09-29, issue #51, план 3e40a139)

- [реализовано] Плейбук `ci-setup` (разовый, на репозиторий): стадии analyze → change → explain,
  стек и workflow репозитория разбираются сами, идемпотентность наблюдаема — настроенное репо
  отвечает «уже настроено» и PR не открывает; правка идёт PR-ом в целевой репо, штатными
  open-pr / ci-green / merged; последний шаг объясняет владельцу простыми словами, что появилось
  и что запуск ничего не сливает и не выкатывает.
- [реализовано] Плейбук `ci-run` (частый, на ветку): один MCP-тул `ci_run_branch` (без run_id —
  диспатч и поиск своего рана, с run_id — статус, упавшие джобы, хвост лога), ожидание только
  через `task_item_wait(until: {ci_run_green: …})` и `DURABLE: waiting`, ненастроенное репо →
  явный `configured:false` с предложением `ci-setup`.
- [реализовано] Типы шагов `ci-setup` и `ci-run` в `library/step-types.json` (24 → 25);
  общий `verify-local` переписан: локально — только быстрые проверки, полный набор — в облаке
  (`ci_run_branch` + durable-ожидание), с фолбэком на локальный прогон для ненастроенного репо.
- [реализовано] Шаблон `templates/ci.yml`: `workflow_dispatch` с input ref/suite, своя
  `concurrency`-группа только на ручные запуски, примеры команд для python/go в шапке; в нём
  нет `continue-on-error` и нет шагов сливания/выкатки (это проверяет песочница).
- [реализовано] В ядре `trained-assist-agent` (PR-A, отдельная ветка): детерминированный
  валидатор `ci_run_green` в `createDefaultRegistry` — `task_item_wait` принимает этот ключ
  условия; completed+success → pass, completed+не-success → fail с `evidence.final:true`
  (будит сразу), идёт/нет токена/ API недоступен → inconclusive; unit-тест рядом с `ci_green`.
- [реализовано] Песочница `npm run test:sandbox:ci` (S5, ~0.3 с): фейковый GitHub API,
  48 проверок по шагам сценария; откат — revert обоих PR (репозитории независимы).
- [отклонено (почему)] Диспатч в чужой `ci.yml` по умолчанию не добавляется — только отдельный
  `manual-tests.yml`; правка существующего workflow разрешена лишь когда все тяжёлые джобы и так
  привязаны к `push`/`pull_request`, иначе ручной запуск мог бы задеплоить (риск R1).
- [отклонено (почему)] Новых моделей доступа для GitHub нет: права берутся от существующего
  per-user токена, его нехватка — явная ошибка, а не обходной путь.
- [реализовано] Первое применение `ci-setup` — `trained-assist-agent`: у его `.github/workflows/ci.yml`
  добавлен `workflow_dispatch` с input `ref` (PR #1864), тяжёлые джобы (`merge`, `deploy-gcp`,
  `deploy-ru`) остаются на `pull_request`/push-main, поэтому ручной прогон их не запускает.
  Повторный `ci-setup` отвечает «уже настроено».
- [реализовано] Два дефекта живого тула, найденные на реальной проверке сценария, закрыты
  (issue #64 → PR #65): (1) `failed_jobs` теперь содержит только джобы с `conclusion=failure`
  (раньше попадали `success`/`skipped`); (2) «свой» ран ищется по снимку до диспатча, а не по
  окну «свежайший за 60 с» — два близких диспатча получают разные run id, не чужой результат.
- [планируется] Пачка `ci-setup` на остальные репозитории org `trained-assist` — issue #66
  (первый репозиторий настроен и проверен).

## Z01 — Inventory и общий development baseline (2026-09-30/10-01, pr-autofix#26, архитектура #37)

Карточка Z01 этапа I00. Движок и схема — в `trained-assist/pr-autofix`, коммит coverage-таблицы и
`coverage-drift` — в `trained-assist/trained-agent-architecture`. Решения и грабли:
`pr-autofix/docs/changes/2026-10-01-z01-inventory-dev-baseline.md`, живой сценарий:
`pr-autofix/docs/user-scenarios/onboarding/z01-inventory-dev-baseline.md`.

- [реализовано] Движок и CLI в `pr-autofix`: `validate`, `verify`, `context`, `inventory`,
  `check-docs`, `check-workflows`, `run-derived-check` (PR #27, merge `335e7601`).
- [реализовано] Схемы профиля и адаптера + пять профилей (`docs`/`node`/`python`/`mixed`/`minimal`);
  профиль выводится деривацией, `.devbaseline.json` необязателен и закрепляет недеривируемое.
- [реализовано] `inventory`: 18 колонок, 25 репозиториев, 0 unreadable; нечитаемый репозиторий —
  строка `unreadable` с причиной и код `0` по умолчанию, `--strict` даёт `4`; generation отказывается
  писать файл, если в строке есть значение credential (AC-40, AC-07).
- [реализовано] Log-контракт AC-44 расширен аддитивно: `violations[{rule_id, path, message}]`,
  `included/omitted paths`, фактический расход бюджета; `rule_id` (нарушенное правило) отделён от
  `reason_code` (почему движок остановился); молчащий check правило не выдумывает.
- [реализовано] Fixture `fixtures/onboarding-repo/` с намеренными дефектами; песочница
  `scripts/sandbox/z01-devbaseline.mjs` — 102 ok / 0 FAIL; controlled failure, no-change повтор и
  отказ по cap проверяются офлайн, без сети.
- [реализовано] Callable `devbaseline-callable.yml` (`ci` | `staging-gate`) и настоящий
  `ci-fix-cleanup.yml` с `on: workflow_call` (R26 закрыт, ловится `check-workflows`).
- [реализовано] Собственный `ci.yml` pr-autofix получил job `staging-gate`: merge в этом репозитории
  проверяет не только self-test, а репетицию боевого пути на fixture.
- [реализовано] Три дефекта, найденные на живой проверке сценария, закрыты кодом движка (PR #28,
  merge `7be6309`): единый источник скана вместо двух реализаций, staging по джобам в тексте
  workflow, а не по имени файла; плюс входная валидация идентификатора репозитория.
- [отклонено (почему)] Командный перенос таблицы покрытия в этот репозиторий: таблицей владеет
  `trained-agent-architecture`, второй экземпляр таблицы был бы источником расхождения.
- [планируется] Установка `ci`/`staging-gate`/AutoFix в чужие репозитории + процедура `setup`
  (владелец — playbooks, `src/pr-autofix/`). Требует тега pr-autofix, где cleanup callable: версия
  для потребителя = ref вызывающего workflow (`job.workflow_sha`), поэтому установщик обязан
  отвергать ref без callable-cleanup.
- [планируется] Коммит coverage-таблицы и джоб `coverage-drift` в `trained-agent-architecture`
  (владелец — архитектура); применение construction tasks — только с `--apply` после ревью списка.
- [планируется] Компрессия контекста (builder) — Z03; Z01 даёт контракт профиля и состояния
  манифеста (`fresh`/`stale`/`missing`), сам builder не строит.

## Детект дефектов слайдов 1–5 в генераторе колод (2026-10-02, documents-skill#8, план 77dff113)

Требование из задачи владельца: переполнение бокса/наложение текста (L1) ловится для ВСЕХ типов блоков,
плюс L2 (двойной маркер, бюджет выделений), L4 (интерлиньяж, выравнивание колонок), L5 (близость к футеру),
уровни 1–5 и скоринг по слайдам. Код и контракт — `trained-assist/documents-skill` (PR #11, main `b728207`),
живой сценарий: `docs/user-scenarios/playbooks/deck-defect-lint.md`,
решения и грабли: `docs/changes/2026-10-02-deck-defect-lint.md`.

- [реализовано] `src/deck/defects.js`: контракт дефекта, `pushWarning`/`pushDefect`, скоринг
  `100 − Σ{1:100, 2:25, 3:8, 4:3, 5:1}` с `verdict`, `DECKGEN_VERSION`; `warnings[]` остался `string[]` —
  его читают гейты плейбука, `--strict` и MCP, тип не меняется.
- [реализовано] L1 в единственной точке `txt()` (все 17 вызовов `sl.txt`), допуск 2pt → ни один тип блока
  не остаётся непроверенным; L1 дублируется в `warnings[]` и в `defects[]`, уровни 2–5 — только advisory.
- [реализовано] L2 двойной маркер с opt-in авто-чисткой `--autofix-markers` (off) и бюджет выделений ≤2;
  L4 интерлиньяж/иерархия/выравнивание колонок; L5 близость к футеру по колонкам раскладки (допуск 8pt).
- [реализовано] `src/deck/render-smoke.js`: наземная правда в Chromium + сверка с оценщиком, расхождение
  как `l1_estimator_false_positive/negative` (дефект инструмента, в `warnings` не идёт).
- [реализовано] Песочница `npm run sandbox:deck-lint` (12/12 GREEN), шаг Chromium в `ci.yml`, README,
  `deckgen-markdown-format.md`, описания MCP-тулов, `deckgen.version` в отчёте.
- [реализовано] Ценность подтверждена на живых колодах: B-en до правки давал `warnings: 0` при реальном
  переполнении заголовков на 38pt и наложении на 10pt; после правки текстом `warnings` пустеет.
- [планируется] `documents-skill`#9: убрать мёртвую копию `/home/vova/tools/deckgen`, которую зовёт
  `presentation-creation` вместо репозитория. Фиксы в репозитории до плейбука не доезжают; страховка —
  `deckgen.version` в отчёте.
- [планируется] Включить секцию `documents` в профиле владельца, чтобы `deck_check`/`deck_render`/
  `deck_markup_guide`/`doc_export` реально доходили до сессии (персонал-промпт их документирует).
- [отклонено (почему)] Правка текста плейбука `presentation-creation.json` под advisory-дефекты: гейтами
  они не проверяются, измеримой пользы нет. Возврат к вопросу — если L2 начнут переписывать вручную.
- [отклонено (почему)] Авто-правка текста по L5: нужен порядок блоков на слайде, а не замена строки.

## Плейбук `skill-tool`: новый MCP-инструмент в доменном скиле (2026-09-29/10-02, issue #53, план aa96d610)

Требование из задачи владельца: повторяющаяся цепочка «конвенции скила → файл и схема тула →
исполняемый тест → правило в промпт-домене → PR/CI/staging → релиз → живой вызов» собирается одним
запуском плейбука, а не вручную. Источник: бэклог #50 п.6. Сценарий:
`docs/user-scenarios/playbooks/skill-tool.md`, решения и грабли: `docs/changes/2026-10-02-skill-tool.md`.

- [реализовано] `playbooks-src/skill-tool.json` (v2, 6 стадий, 15 шагов, только существующие типы
  библиотеки; специфика скила — в `notes`) + сборка `playbooks/skill-tool.json`,
  `docs/playbooks/skill-tool.md`, `docs/playbooks/step-library.md`.
- [реализовано] Петля сценария `npm run test:sandbox:skill-tool` (`scripts/sandbox/skill-tool.mjs`):
  9 шагов «КОГДА→ТОГДА» через реальные блоки репо, S3, ≤10 с; до реализации красная.
- [реализовано] `tests/playbooks.test.js` принимает источник `skill-tool` (список плейбуков дальше
  вёл общий `ALL_PLAYBOOKS` — растёт автоматически).
- [реализовано] Пробный прогон на реальном туле — приёмка №2: `freelance_search` в
  `trained-assist-freelance-skill`, фоновый план 302d321a, 15/15 до реального вызова в живой
  сессии; гейт §9 уловил баг «`limit` есть в описании, нет в схеме» → фикс в коде скила
  (PR #36) + ужесточённый тест.
- [реализовано] Статус прод-проверки: релиз содержит мерж-коммит (#56 → `447a692`), резолв
  `PlaybookStore.resolve("skill-tool")` → `source: sibling`, тул виден и вызывается в живой сессии.
- [отклонено (почему)] Отдельный deploy-джоб для репо: это библиотека — «задеплоено» = sibling-чекаут
  на мерж-коммите (агент резолвит плейбуки profile → sibling → system).
- [планируется] staging-job в библиотечных репо (гейт staging живёт в плейбуке для целевых репо) —
  issue #9, отдельно от этого плейбука.
