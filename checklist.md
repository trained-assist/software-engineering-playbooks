# Checklist — pr-autofix service slice 2a: workflow install/update (issue #17)

Design: `docs/PR-AUTOFIX-SERVICE.md` §3 (workflow install/update), §3.1 (workflow_run shape).
Additive; one external write (a PR to the target repo); **no** credential/Actions-secret writes.

## Goal

Let the service install/update the pr-autofix workflow in a target repository cleanly and
idempotently, replacing per-repo hand-wiring — without touching credentials (that is slice 2b).

## Definition of done

- [x] CI green on https://github.com/trained-assist/trained-assist-engineering/pull/18
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Slices

- [x] Installer core (`src/pr-autofix/installer.js` + `constants.js`): build the pinned
      `.github/workflows/pr-autofix.yml` (+ `ci-fix-cleanup.yml` when `features.cleanup`) and open /
      update a PR through an injected `ghFetch`/`ghToken` capability (tests use a fake, no network).
      Idempotent: identical pinned job → no PR; ref bump → update PR; one deterministic install
      branch.
- [x] Trigger choice: dedicated `workflow_run` of the target CI workflow (`types: [completed]`,
      matched by `ci_workflow_name`, default `"CI"`), guarded on failed + pull_request + non-`fix/ci-*`.
- [x] Immutable pinning: `autofix_ref` must be `vX.Y.Z` or a 40-hex SHA; floating refs rejected;
      default `v1.2.1`.
- [x] Tool `engineering_pr_autofix_install` + provider manifest (`requiresApproval: true`),
      `status → workflow_installed`, `installed_workflow { path, pinned_ref, installed_at, pr_url }`.
- [x] `engineering_pr_autofix_status` reflects `installed_workflow`; `disable` unchanged.
- [x] Tests: one PR with pinned callable job, second install no-op, open-PR ref bump, post-merge ref
      bump opens new PR, identical job present → no PR, cleanup workflow, configurable CI name,
      immutability/disabled/unregistered errors, no-secret invariant (incl. token rejected in
      `installed_workflow`), MCP round-trip + `GITHUB_NOT_CONFIGURED`.
- [x] `npm run check`, `npm test`, `npm run manifest:check`

## Non-goals (slice 2b, separate + approval-gated)

ZeroCreds credential binding and pushing `OPENROUTER_API_KEY` / `AUTOFIX_PAT` to repo Actions
secrets; run-event lifecycle/notifications; `disable` removing the installed workflow.

## Goal (plan-26741514): complexity → price estimation skill

Deterministic complexity→price engine (tier × multipliers) + MCP tool + docs + tests.

### Definition of done

- [ ] CI green on this PR
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Checklist — spec-generation move into the engineering repo (issue #43, plan-b86456ed)

Design: `docs/spec-generation-migration.md` (proposal, slices S1–S5, запуск/проверка).
Директивы 2.В и 3 (голос 28.09.2026). Additive for this repo; вынос из freelance-скила — отдельным PR.

## Goal

Генерация ТЗ живёт здесь: инженерная конкретика + sandbox-блок в содержании (long/short),
переключаемый стиль (новый ЧБ — дефолт), 6 тулов `engineering_*`, смоук-образцы и e2e/песочница S5.

## Definition of done

- [ ] CI green on https://github.com/trained-assist/software-engineering-playbooks/pull/44
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Slices

- [x] S1 `src/spec-generation/rules.js`: voice дословно + конкретика + sandbox-блок + стиль
      (дефолт `oldschool`, неизвестный style → throw) + `tests/spec-generation-rules.test.js`.
- [x] S2 `src/mcp-skills/tools/65-spec-generation.js`: 6 тулов `engineering_*` (реестр автосканом,
      `64` занят PR #42), read-compat `spec/` + legacy `tz.md` + `tests/spec-generation-tool.test.js`.
- [x] S3 prompt-domain `spec-generation.md`; S4 смоук-образцы `docs/examples/spec-{long,short}-classic.md`.
- [x] S5 `e2e/spec-generation.e2e.mjs` + `test:e2e` (SKIP без окружения) + `test:sandbox` (`--fast`).
- [x] Проверки до PR: check/manifest:check exit 0; песочница полная PASS S5 (судья PASS);
      1 красный в `npm test` — преждествующий `tests/workspace.test.js`, падает и на base.

## Non-goals (следующие шаги, помечено в docs)

- Этап 2: «спецификация глубже в инженерную тему» + ideation глубже — отдельным изменением.
- Сейлз-форма «любой документ → более сейлзовый вид» — отдельная операция, не в генераторе.
- Вынос спецификационной части из `trained-assist-freelance-skill` — отдельный PR после мержа этого.

## Checklist — ci-setup / ci-run playbooks (issue #51, plan-3e40a139)

Два переиспользуемых системных плейбука «прогон тестов в облаке»: разовый `ci-setup` (workflow_dispatch на целевой репо) и частый `ci-run` (dispatch → durable-ожидание → статус). Дизайн: `docs/ci-cloud-run.md`; сценарий: `docs/user-scenarios/ci/cloud-test-run.md`.

## Definition of done

- [x] CI green on https://github.com/trained-assist/software-engineering-playbooks/pull/54
- [x] Merged to main (9c0552f; + фикс #65 aea7f83)
- [x] Deployed to prod — verified live (оба плейбука в `playbook_list`, живой прогон зелёный+красный,
      прогон не деплоит; первый репозиторий `trained-assist-agent` настроен, PR #1864)

## Checklist — skill-tool: новый MCP-инструмент в скиле (issue #53, plan-aa96d610)

Сценарий: `docs/user-scenarios/playbooks/skill-tool.md` · контекст/требования/дизайн: `skill-tool.{context,requirements,proposal}.md`.
Путь нового инструмента в доменном скиле закреплён как воспроизводимый плейбук:
конвенции тулов → заготовка → исполняемый тест → правило промпт-домена → PR (CI+staging) →
релиз → два разных гейта «виден в новой сессии» / живой вызов.

## Goal

Воспроизводимый процесс «новый MCP-инструмент в скиле»: плейбук проходит валидацию схемы
в тестах репо; «мерж ≠ прод» разведён на два гейта (виден / вызван); при отсутствии
staging-джобы в целевом репо — блок и задача, а не молчаливый skip.

## Definition of done

- [ ] CI green on https://github.com/trained-assist/software-engineering-playbooks/pull/55
- [ ] Merged to main
- [ ] Deployed to prod — verified live (плейбук виден в новой сессии; пробный прогон на реальном инструменте)

## Slices

- [x] S1 `playbooks-src/skill-tool.json` (15 шагов, 6 стадий) + сборка `playbooks/skill-tool.json`,
      `docs/playbooks/skill-tool.md`, `docs/playbooks/step-library.md`.
- [x] S2 `tests/playbooks.test.js` — список id → 4 (debugging, feature, new-software, skill-tool).
- [x] S3 `README.md` — заголовок, строка таблицы, строка дерева.
- [x] Песочница `scripts/sandbox/skill-tool.mjs` + `npm run test:sandbox:skill-tool` (S3, 0,3 с,
      9 шагов сценария; пропуск шага не считается успехом).
- [x] Попутный фикс `src/workspace/workspace.js`: guard удержания не зависит от формата
      stash-сообщения (git 2.34 обрезает `eng/...`) — `workspace.test.js` 25/25.
- [x] Проверки до PR: check / manifest:check / `npm test` 144/144 / check:playbooks зелёные;
      песочница PASS 15/15.

## Non-goals

- Пробный прогон на реальном маленьком инструменте и первая живая сессия — после мержа + деплоя ядра.
- staging-гейт для целевых репозиториев без staging-job — задача в issue #9 (в самом плейбуке), не здесь.

## Checklist — pr_status / issue_status (issue #52, plan-a738d291)

## Goal

Один инструмент «что с PR / что с issue» в engineering-skills: `pr_status` (открыт/смержен, чеки
`ci` + `staging-gate`, сжатый хвост логов упавших джобов через `compressLog` из pr-autofix, доехал
ли мерж-коммит до прода, autofix-PR) и `issue_status` (все связанные PR, включая cross-repo).
`github_pr_checks` поглощён бросающим алиасом; `cicd_track_pr` оставлен (ставит PR на отслеживание,
а не читает статус).

## Definition of done

- [ ] CI green on https://github.com/trained-assist/software-engineering-playbooks/pull/61
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Slices

- [x] S1 `src/github/client.js` — общий `getToken`/`ghFetch`/`ghGraphql`, вынесен из `60-github.js`.
- [x] S2 `src/github/compress-log.js` — вендоренный `compressLog` из pr-autofix`@0e36f2e` + parity-тест.
- [x] S3+S4 `src/github/pr-status-core.js` — `prStatus` (чеки/вердикт/логи/autofix/прод/бюджет) + `issueStatus`.
- [x] S5 `scripts/sandbox/pr-status.mjs` + `tests/fixtures/github/pr-status.js` — замкнутый цикл.
- [x] S6 `src/mcp-skills/tools/62-pr-status.js` + алиас `github_pr_checks`, реестр, `package.json`, README.
- [x] До PR: `check`/`manifest:check` exit 0; юниты 23/23; песочница `test:sandbox:pr` PASS (до: FAIL по правильной причине).

## Checklist — repo maps L0/L1 (эпик #49, plan-61ac1e86)

Сжатые карты репозитория: L1 «скелет» (детерминированный парсер, без LLM) + L0 «карта» (≤ 2k токенов,
однострочные описания дешёвой моделью, кеш по commit sha). Тул `repo_map(repo, level, focus)`,
сборка при `engineering_spawn_workspace` + ленивая достройка нового sha, правило «сначала repo_map».
Сценарий: одна карта < 1 с из кеша вместо десятков открытых файлов (~480 поисков за 10 дней).

## Goal

Первый шаг разведки — карта репозитория: `< 1 с` из кеша, ≤ 2k токенов на L0, без блужданий по файлам.

## Definition of done

- [x] CI green on https://github.com/trained-assist/software-engineering-playbooks/pull/62 (supersedes #59: ветка перебазирована на main, #59 конфликтовал — его CI не запускался)
- [ ] Merged to main
- [ ] Deployed to prod — verified live

## Slices

- [x] 1. Общий кеш карт по commit sha вне worktree.
- [x] 2. Парсер JS через вендоренный acorn (закрыты пробелы CJS/метод-скана).
- [x] 3. Рендер L1 «скелет» (детерминированный).
- [x] 4. Рендер L0 «карта» ≤ 2k токенов.
- [x] 5. LLM-описания L0 + деградация без ключа.
- [x] 6. MCP-тул `repo_map` + provider manifest.
- [x] 7. Фоновый сбор при спавне + ленивая достройка (+ kill-switch `REPO_MAP_SPAWN_BUILD`).
- [x] 8. Правило «сначала repo_map» в плейбуках feature/debugging.
- [x] 9. Тесты срезов + песочница `npm run sandbox:repo-map` (S5).
