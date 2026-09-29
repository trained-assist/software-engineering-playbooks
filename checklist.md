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
- Сейлз-форма «любой документ → более сейлзовый вид» — отдельная операция, не в генератор.
- Вынос спецификационной части из `trained-assist-freelance-skill` — отдельный PR после мержа этого.

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
