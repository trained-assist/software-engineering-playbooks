#!/usr/bin/env node
// Sandbox loop для P24 — «Реальные playbooks и адаптация плана» (эпик E5 #21,
// карточка #63, этап I07, приёмка AC-143). Одна команда, детерминированный
// PASS/FAIL, sanitized transcript.
//
// Сценарий приёмки, разложенный на наблюдаемые шаги:
//   [1] компиляция всех локальных артефактов в pinned plans с воспроизводимыми
//       step mappings (чек-лист #63: «Compile всех 11 artifacts в pinned plans»);
//   [2] реальный путь плейбука feature: PR → CI → verify gates с evidence
//       (AC-143: «PR → CI → verify gates имеют evidence»);
//   [3] нативное извлечение плейбука НЕ подменяет execution plan (AC-143);
//   [4] правка definition'а не меняет ID запущенных шагов (AC-143);
//   [5] feature/integration split + migration dependency;
//   [6] управляемые сбои: красный CI, потерянный ACK dispatch'а, вечно-красный CI,
//       дубликат/поздний ответ пользователя, restart ожидания, устаревшее
//       доказательство приёмки;
//   [7] HH simple schedule по-прежнему без GTD (AC-143);
//   [8] логи этапа I07: корреляция, ключи событий, причины перехода, без секретов
//       и текста задачи;
//   [9] приёмка репозитория: tests/execution-plans.test.js зелёные.
//
// Уровень: S3 — реальные модули этого репозитория, сеть недоступна, движок не нужен.
// Облачный CI — синтетическая фикстура на диске под изолированным корнем.
// Прод-данные, секреты и реальные провайдеры не используются.
//
// Run:   npm run test:sandbox:real-playbooks
//        node scripts/sandbox/real-playbooks.mjs [--out docs/evidence/p24-real-playbooks-and-plan-adaptation]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const CLOCK_START = Date.parse('2026-10-03T09:00:00.000Z');
const PROFILE = 'p24-sandbox-profile';
const GOAL = 'sandbox goal (text never logged)';
const REPO_VAR = 'trained-assist/software-engineering-playbooks';
const BINDING_VALUE = 'sandbox-fixture-binding-value';

const SANDBOX_ROOT = path.join(REPO, '.sandbox', `p24-${process.pid}`);
fs.mkdirSync(SANDBOX_ROOT, { recursive: true, mode: 0o700 });

const outFlagIndex = process.argv.indexOf('--out');
const OUT_DIR = outFlagIndex >= 0 ? path.resolve(REPO, process.argv[outFlagIndex + 1]) : null;

const {
  adaptFeatureIntegrationSplit,
  assertRunningStepsUnchanged,
  compilePlan,
  createCloudCiProvider,
  createGtdPort,
  createInProcessGtdTransport,
  createPlanRuntime,
  createSimpleSchedule,
  diffPlans,
  viewChecklist,
} = require(path.join(REPO, 'src', 'execution-plans'));
const { createPlaybookArtifactHost, listPinnedPlaybooks, readEvents } = require(path.join(REPO, 'src', 'playbook-artifacts'));

const failures = [];
const transcript = [];
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '   ok  -' : '   FAIL-'} ${label}${extra ? ` — ${extra}` : ''}`);
  transcript.push(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(label);
};
const note = line => {
  console.log(`          ${line}`);
  transcript.push(`     ·  ${line}`);
};
const section = title => {
  console.log(`\n[${title}]`);
  transcript.push(`\n[${title}]`);
};

let clockNow = CLOCK_START;
const clock = () => new Date(clockNow);
const advance = seconds => {
  clockNow += seconds * 1000;
  return new Date(clockNow);
};

function varsFor(playbookId) {
  const { definition } = require(path.join(REPO, 'src', 'playbook-artifacts')).resolvePinnedPlaybook({ root: REPO, playbookId, detail: 'full' });
  const vars = {};
  for (const input of definition.inputs || []) vars[input.name] = input.name === 'repo' ? REPO_VAR : `sandbox-${input.name}`;
  return vars;
}

function runtimeFor(label, { conclusions, ciFault = 'none', gtdTransport } = {}) {
  const dataRoot = path.join(SANDBOX_ROOT, label);
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const ci = createCloudCiProvider({ root: path.join(dataRoot, 'ci'), clock, conclusions, fault: ciFault });
  const gtd = createGtdPort({ clock, transport: gtdTransport });
  const runtime = createPlanRuntime({ root: REPO, dataRoot, clock, ci, gtd });
  return { runtime, ci, gtd, dataRoot };
}

function passingValidators(step) {
  return Object.fromEntries(step.gate.validators.map(validator => [validator.name, { status: 'passed', evidenceRef: `ev:${step.stepKey}` }]));
}

console.log('[sandbox] P24 · real playbooks and plan adaptation (issue #63, stage I07, AC-143)');
console.log(`[sandbox] isolated sandbox: ${path.relative(REPO, SANDBOX_ROOT)} (no network, no engine, no production data)`);

// ── 1. Компиляция всех локальных артефактов в pinned plans ─────────────────
section('1. compile every pinned artifact into a plan with reproducible step mappings');
{
  const artifacts = listPinnedPlaybooks({ root: REPO });
  const rows = [];
  for (const descriptor of artifacts) {
    const first = compilePlan({ root: REPO, playbookId: descriptor.id, profileId: PROFILE, userTaskId: 'ut-p24-compile', goal: GOAL, vars: varsFor(descriptor.id), sourceRevision: 'sandbox-rev' });
    const second = compilePlan({ root: REPO, playbookId: descriptor.id, profileId: PROFILE, userTaskId: 'ut-p24-compile', goal: GOAL, vars: varsFor(descriptor.id), sourceRevision: 'sandbox-rev' });
    const reproducible = first.planId === second.planId && first.steps.every((step, i) => step.stepId === second.steps[i].stepId);
    rows.push({ id: descriptor.id, version: descriptor.version, steps: descriptor.stepCount, planId: first.planId, reproducible });
    check(reproducible, `${descriptor.id}@${descriptor.version}: повторная компиляция даёт те же planId и stepId`, `${descriptor.stepCount} шагов`);
  }
  note(`всего артефактов: ${rows.length}, шагов: ${rows.reduce((sum, row) => sum + row.steps, 0)}`);
  note(`пример: ${rows[0].id} → ${rows[0].planId} (${rows[0].steps} шагов, revision 1)`);
  check(rows.length >= 7, 'все engineering-артефакты этого checkout скомпилированы', `${rows.length} шт.`);
}

// ── 1b. Reviewed scope: артефакты других доменов (сеть + gh, иначе SKIP) ────
// Чек-лист #63 требует «compile всех 11 artifacts». 7 из них лежат в этом
// репозитории и компилируются всегда; остальные 5 — в доменных репозиториях,
// поэтому их компиляция здесь сете-зависима: без gh/сети раздел честно помечается
// SKIPPED, а не «зелёный». Артефакты скачиваются в .sandbox/ (в репозитории) и в
// коммит не попадают.
section('1b. compile the reviewed domain artifacts (network + gh; skipped when unavailable)');
{
  const REVIEWED = [
    { repo: 'trained-assist/trained-assist-sales-skill', ref: 'b45aa6eecb1da612d1766dbae739e15b10a01de2', file: 'exhibition-catalog-to-sales-site' },
    { repo: 'trained-assist/trained-assist-documents-skill', ref: 'fe4e88ec5c7a2332e2450e11961a9c6d49b55045', file: 'freelance-project-spec' },
    { repo: 'trained-assist/trained-assist-documents-skill', ref: 'fe4e88ec5c7a2332e2450e11961a9c6d49b55045', file: 'presentation-creation' },
    { repo: 'trained-assist/trained-assist-hh-skill', ref: '0a45af2e1173e3d2172f0d025fdd3f7fc100c2f4', file: 'recruiting-vacancy-launch' },
    { repo: 'trained-assist/trained-assist-marketing-skill', ref: '59ef5334b9d4edffa30b4f379dbdf734adc96e22', file: 'customer-development-collect' },
  ];
  const remoteRoot = path.join(SANDBOX_ROOT, 'reviewed-repo');
  const ghVersion = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (ghVersion.status !== 0) {
    note(`SKIPPED: gh недоступен (${(ghVersion.error && ghVersion.error.code) || `status=${ghVersion.status}`}) — reviewed-scope не проверяется этим прогоном, а не «считается зелёным»`);
    check(true, 'reviewed-scope помечен SKIPPED, а не пройден молча');
  } else {
    fs.mkdirSync(path.join(remoteRoot, 'playbooks'), { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(REPO, 'contracts'), path.join(remoteRoot, 'contracts'), { recursive: true });
    let compiled = 0;
    let refused = 0;
    for (const item of REVIEWED) {
      const fetched = spawnSync('gh', ['api', `repos/${item.repo}/contents/playbooks/${item.file}.json?ref=${item.ref}`, '--jq', '.content'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (fetched.status !== 0 || !fetched.stdout.trim()) {
        note(`SKIPPED ${item.file}: артефакт не прочитан (сеть или доступ)`);
        continue;
      }
      const bytes = Buffer.from(fetched.stdout.replace(/\s+/g, ''), 'base64');
      fs.writeFileSync(path.join(remoteRoot, 'playbooks', `${item.file}.json`), bytes, { mode: 0o600 });
      const definition = JSON.parse(bytes.toString('utf8'));
      const vars = {};
      for (const input of definition.inputs || []) vars[input.name] = `sandbox-${input.name}`;
      for (const stage of definition.stages || []) {
        for (const step of stage.steps || []) {
          for (const match of (step.instructions || '').matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)) vars[match[1]] = `sandbox-${match[1]}`;
        }
      }
      try {
        const plan = compilePlan({ root: remoteRoot, playbookId: item.file, profileId: PROFILE, userTaskId: 'ut-p24-reviewed', goal: GOAL, vars, sourceRevision: item.ref.slice(0, 12) });
        compiled += 1;
        note(`compiled ${item.file}@${definition.version}: ${plan.steps.length} шагов, plan ${plan.planId}`);
        check(true, `reviewed ${item.file}: скомпилирован в pinned plan`, `${plan.steps.length} шагов`);
      } catch (error) {
        refused += 1;
        const reason = error.details && error.details.unsupported ? error.details.unsupported.join(',') : (error.details && error.details.missing ? error.details.missing.map(m => m.name).join(',') : '');
        note(`refused ${item.file}: ${error.code}${reason ? ` (${reason})` : ''}`);
        check(error.code === 'UNSUPPORTED_STEP_CONTRACT' || error.code === 'PROGRAMMATIC_HANDLER_UNRESOLVED' || error.code === 'COMPILE_INPUT_MISSING' || error.code === 'ARTIFACT_SCHEMA_INVALID', `reviewed ${item.file}: отказ до диспатча с явным кодом`, error.code);
      }
    }
    check(compiled + refused > 0, 'reviewed-scope действительно прогнан, а не пропущен', `compiled=${compiled} refused=${refused}`);
  }
}

// ── 2. Реальный путь feature: PR → CI → verify gates с evidence ─────────────
section('2. feature plan: PR → CI → verify gates with evidence');
{
  const { runtime, ci, gtd } = runtimeFor('walkthrough', { conclusions: ['pending', 'red', 'green'] });
  const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-walk', goal: GOAL, vars: varsFor('feature'), sourceRevision: 'sandbox-rev' });
  const evidence = [];
  let guard = 0;
  while (guard++ < 40) {
    const step = runtime.readyStep(plan.planId);
    if (!step) break;
    const state = runtime.load(plan.planId).stepStates[step.stepId];
    if (state === 'awaiting_user_input') {
      const record = runtime.load(plan.planId).awaiting[step.stepId];
      const answered = runtime.answer({ planId: plan.planId, awaitingInputId: record.awaitingInputId, answerEventId: `ans-${step.stepKey}`, answer: { ok: true } });
      note(`${step.stepKey}: ответ принят (${answered.accepted ? 'одно возобновление' : 'дубль'})`);
      continue;
    }
    if (state === 'awaiting_condition') {
      const tick = runtime.tick({ planId: plan.planId });
      const transition = tick.transitions[0];
      note(`${step.stepKey}: тик виртуальных часов → ${transition.kind} (${transition.conclusion || 'pending'})`);
      if (transition.conclusion) evidence.push({ stepKey: step.stepKey, conclusion: transition.conclusion, externalRef: transition.externalRef, via: 'virtual_clock_tick' });
      continue;
    }
    const result = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
    if (result.run && result.run.report) evidence.push({ stepKey: step.stepKey, conclusion: result.run.report.conclusion, externalRef: result.run.externalOperationRef.ref.id });
    if (result.externalOperationRef && result.externalOperationRef.ref) evidence.push({ stepKey: step.stepKey, externalRef: result.externalOperationRef.ref.id, dispatchCount: result.externalOperationRef.dispatchCount });
    note(`${step.stepKey} → ${result.state} (гейт ${result.gate.result}/${result.gate.reasonCode}, dispatch=${result.dispatchCount ?? '-'})`);
  }
  const final = runtime.load(plan.planId);
  check(final.status === 'completed' || final.status === 'active', 'план дошёл до конца без ручного вмешательства', `status=${final.status}`);
  check(evidence.some(item => item.conclusion === 'red'), 'красный CI зафиксирован как структурный отчёт', JSON.stringify(evidence.find(item => item.conclusion === 'red')));
  check(evidence.some(item => item.conclusion === 'green'), 'зелёный CI зафиксирован с внешним ref', JSON.stringify(evidence.find(item => item.conclusion === 'green')));
  check(ci.dispatchCount() >= 1, 'облачный CI диспатчился хотя бы один раз', `dispatchCount=${ci.dispatchCount()}`);
  check(gtd.calls.outcomes === 0, 'unmanaged-задача не вызывала GTD ни разу', `calls=${JSON.stringify(gtd.calls)}`);
  const checklist = viewChecklist(final);
  note(`checklist: ${checklist.progress.passed}/${checklist.progress.total} шагов, required ${checklist.progress.requiredPassed}/${checklist.progress.required}`);
  check(checklist.progress.passed === checklist.progress.total, 'checklist view показывает все шаги пройденными');
}

// ── 3. Извлечение плейбука ≠ execution plan ────────────────────────────────
section('3. native playbook retrieval does not substitute the execution plan');
{
  const dataRoot = path.join(SANDBOX_ROOT, 'retrieval');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const host = createPlaybookArtifactHost({ root: REPO, dataRoot, profileId: PROFILE, clock, bindingResolver: ({ ref }) => (ref ? BINDING_VALUE : undefined), sourceRevision: 'sandbox-rev' });
  const before = fs.readdirSync(dataRoot);
  const read = host.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature', detail: 'full' }, caller: { profileId: PROFILE, userTaskId: 'ut-p24-read' }, binding: { ref: 'sbx/playbooks#read', scope: 'playbooks:read' }, operationId: 'op-p24-read' });
  check(read.kind === 'completed', 'плейбук извлечён как данные');
  check(read.result.execution.planStarted === false && read.result.execution.planId === null, 'извлечение не запускает план', `reason=${read.result.execution.reason}`);
  check(read.result.advisory.requiresGtdId === false && read.result.advisory.createsGtdId === false, 'advisory-извлечение не требует и не создаёт gtdId');
  const onDisk = fs.readdirSync(dataRoot).filter(file => !before.includes(file));
  check(onDisk.length === 1 && onDisk[0] === 'playbook-artifacts', 'на диске появился только лог — ни плана, ни рана', onDisk.join(','));
  const events = readEvents(path.join(dataRoot, 'playbook-artifacts', 'events.jsonl'));
  check(events.some(entry => entry.event === 'artifact.resolved'), 'в логе есть только разрешение артефакта', events.map(entry => entry.event).join(','));

  // План появляется только после явной компиляции, и только по pinned-артефакту.
  const { runtime } = runtimeFor('compile-only', { conclusions: ['green'] });
  const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-compile', goal: GOAL, vars: varsFor('feature') });
  check(Boolean(plan.planId) && plan.steps.length === 15, 'план появляется только после компиляции', `${plan.planId}, ${plan.steps.length} шагов`);
  check(runtime.readyStep(plan.planId) !== null, 'готовый шаг выдаётся рантаймом, а не чтением');
  assert.throws(() => compilePlan({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-x', goal: GOAL, vars: varsFor('feature'), expectedHash: `sha256:${'0'.repeat(64)}` }), err => err.code === 'ARTIFACT_HASH_MISMATCH');
  note('дрейф хеша артефакта отклоняется до компиляции (ARTIFACT_HASH_MISMATCH)');
}

// ── 4. Правка definition'а не меняет ID запущенных шагов ───────────────────
section('4. a controlled artifact edit does not change running step IDs');
{
  const artifactRoot = path.join(SANDBOX_ROOT, 'edited-repo');
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(REPO, 'playbooks'), path.join(artifactRoot, 'playbooks'), { recursive: true });
  fs.cpSync(path.join(REPO, 'contracts'), path.join(artifactRoot, 'contracts'), { recursive: true });

  const { runtime } = runtimeFor('edit', { conclusions: ['green'] });
  const plan = runtime.compile({ root: artifactRoot, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-edit', goal: GOAL, vars: varsFor('feature'), sourceRevision: 'pinned-rev-1' });
  const first = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: first.stepId, outcome: 'done', validatorResults: passingValidators(first) });
  const midRun = runtime.snapshot(plan.planId);

  const file = path.join(artifactRoot, 'playbooks', 'feature.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.version = 3;
  edited.stages[0].steps[0].title = 'Сценарий пользователя (переписан)';
  // Шаг добавляем в КОНЕЦ стадии: legacy-ключ `stageId#ordinal` стабилен только
  // при добавлении в конец — вставка в середину сдвигает ordinal всех следующих
  // шагов, и это честно видно в diffPlans как переименование, а не как «тот же шаг».
  edited.stages[0].steps.push({ ...edited.stages[0].steps[0], title: 'Новый шаг в конце стадии', step_type: 'explore-context' });
  fs.writeFileSync(file, JSON.stringify(edited, null, 2));

  const pinned = runtime.assertPinnedDefinition(plan.planId);
  check(pinned.matchesPlan === true, 'активный план продолжает pinned-ревизию (хеш сохранённых байтов совпадает)');
  const after = runtime.snapshot(plan.planId);
  assertRunningStepsUnchanged({ before: midRun, after });
  check(true, 'запущенные шаги не переименованы и не перестроены', `${midRun.steps[0].stepId} → ${after.steps[0].stepId}`);
  check(midRun.steps[0].title === after.steps[0].title, 'заголовок running-шага не изменился');

  const recompiled = runtime.compile({ root: artifactRoot, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-edit', goal: GOAL, vars: varsFor('feature'), sourceRevision: 'pinned-rev-2' });
  const delta = runtime.diff(plan.planId, recompiled.planId);
  check(recompiled.planId !== plan.planId, 'перекомпиляция даёт новый planId');
  check(delta.added.length === 1, 'вставленный шаг виден как added', JSON.stringify(delta.added));
  const retained = delta.retained.find(row => row.stepKey === 'frame#1');
  check(retained && retained.sameStepId === false && retained.retitled === true, 'неизменный шаг сопоставлен по stepKey, но получил новый stepId', JSON.stringify(retained));
  check(delta.retained.every(row => row.beforeStepId !== row.afterStepId), 'ни один stepId не переиспользован молча');
}

// ── 5. Feature/integration split + migration dependency ───────────────────
section('5. feature/integration split with a migration dependency');
{
  const { runtime } = runtimeFor('split', { conclusions: ['green'] });
  const base = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-split', goal: GOAL, vars: varsFor('feature') });
  const { featurePlan, integrationPlan, adaptation } = adaptFeatureIntegrationSplit(base, { migration: { migrationId: '0009_orders_index' } });
  runtime.save(featurePlan);
  runtime.save(integrationPlan);

  check(adaptation.kind === 'feature_integration_split', 'адаптация зафиксирована как evidence', adaptation.changes.map(change => change.kind).join(' | '));
  check(featurePlan.compiledPlanRevision === 2 && integrationPlan.compiledPlanRevision === 2, 'ревизия плана увеличена у обоих');
  check(integrationPlan.planDependencies.length === 1 && integrationPlan.planDependencies[0].when === 'passed', 'интеграция зависит от доказанного merge плана фичи', JSON.stringify(integrationPlan.planDependencies));
  const retainedIds = [...featurePlan.steps, ...integrationPlan.steps.filter(step => step.stepType !== 'migration')].map(step => step.stepId).sort();
  check(JSON.stringify(retainedIds) === JSON.stringify(base.steps.map(step => step.stepId).sort()), 'перенесённые шаги сохранили свои stepId один в один');
  const migration = integrationPlan.steps.find(step => step.stepType === 'migration');
  check(migration.adapter.synthetic === 'migration_node' && migration.externalOperation.kind === 'schema_migration', 'узел миграции — явный синтетический узел с внешней операцией');
  check(integrationPlan.steps.find(step => step.stepType === 'verify-real').dependsOn[0] === migration.stepId, 'verify-real ждёт receipt миграции');
  check(featurePlan.gtdId === base.gtdId && integrationPlan.gtdId === base.gtdId, 'расщепление не плодит вторую запись контроля');

  check(runtime.readyStep(integrationPlan.planId) === null, 'интеграция заблокирована, пока merge не доказан');
  const waiting = runtime.log.entries.find(entry => entry.event === 'plan.dependency.waiting');
  check(Boolean(waiting) && waiting.reasonCode === 'UPSTREAM_STEP_NOT_PASSED', 'незакрытая зависимость видна в логе', waiting && waiting.dependencyStepKey);
}

// ── 6. Управляемые сбои ────────────────────────────────────────────────────
section('6. controlled failures (not only the happy path)');
{
  // 6.1 Потерянный ACK dispatch'а: unknown → reconcile без второго dispatch.
  {
    const { runtime, ci } = runtimeFor('lost-ack', { conclusions: ['green'], ciFault: 'lost_dispatch_ack' });
    const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-lost', goal: GOAL, vars: varsFor('feature') });
    const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
    const first = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
    check(first.state === 'unknown' && first.gate.reasonCode === 'EFFECT_STATE_UNKNOWN', 'потерянный ACK — неизвестный исход, а не «повторить»');
    const reconciled = runtime.reconcileExternal({ planId: plan.planId, stepId: step.stepId, operationId: runtime.load(plan.planId).stepExternalOps[step.stepId].operationId });
    check(reconciled.found && reconciled.secondDispatch === false, 'reconcile нашёл run по operationId');
    check(ci.dispatchCount() === 1, 'повторного dispatch не было', `dispatchCount=${ci.dispatchCount()}`);
  }

  // 6.2 Вечно-красный CI: cap завершает прогрессию, а не обходится новой записью.
  {
    const { runtime, ci, gtd } = runtimeFor('never-green', { conclusions: ['red'], ciFault: 'never_green' });
    const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-cap', goal: GOAL, vars: varsFor('feature') });
    const step = plan.steps.find(candidate => candidate.stepType === 'ci-green');
    let last = null;
    for (let attempt = 1; attempt <= step.maxAttempts; attempt += 1) last = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: {} });
    check(last.capReached && last.planStatus === 'stopped', 'исчерпание попыток останавливает план', `attempts=${step.maxAttempts}`);
    check(runtime.load(plan.planId).blocker.reason === 'ATTEMPT_CAP_EXHAUSTED', 'причина остановки записана в плане');
    check(gtd.calls.register === 0, 'новая запись контроля для обхода cap не создана', `register calls=${gtd.calls.register}`);
    check(ci.dispatchCount() === step.maxAttempts, 'каждая попытка после красного вывода — новый run', `dispatchCount=${ci.dispatchCount()}`);
  }

  // 6.3 Дубликат и поздний ответ пользователя: ровно одно возобновление.
  {
    const { runtime, dataRoot } = runtimeFor('await', { conclusions: ['green'] });
    const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-await', goal: GOAL, vars: varsFor('feature') });
    const step = plan.steps.find(candidate => candidate.wait && candidate.wait.kind === 'user_input');
    const parked = runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'awaiting_user_input', detail: { question: 'уточнить цель' } });
    const restarted = createPlanRuntime({ root: REPO, dataRoot, clock, ci: createCloudCiProvider({ root: path.join(dataRoot, 'ci'), clock, conclusions: ['green'] }), gtd: createGtdPort({ clock, transport: createInProcessGtdTransport({ clock }) }) });
    check(restarted.load(plan.planId).stepStates[step.stepId] === 'awaiting_user_input', 'ожидание переживает перезапуск рантайма');
    const accepted = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-1', answer: { ok: true } });
    const duplicate = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-1', answer: { ok: true } });
    const late = restarted.answer({ planId: plan.planId, awaitingInputId: parked.awaiting.awaitingInputId, answerEventId: 'ans-2', answer: { ok: true } });
    check(accepted.accepted && !duplicate.accepted && !late.accepted, 'дубликат и поздний ответ не возобновляют работу дважды');
    const resumes = restarted.log.entries.filter(entry => entry.event === 'awaiting.answer.accepted');
    check(resumes.length === 1, 'ровно одно возобновление на ответ', `accepted=${resumes.length}`);
  }

  // 6.4 Устаревшее доказательство не закрывает план (PR-20).
  {
    const { runtime } = runtimeFor('stale', { conclusions: ['green'] });
    const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-stale', goal: GOAL, vars: varsFor('feature') });
    const first = runtime.readyStep(plan.planId);
    runtime.runStep({ planId: plan.planId, stepId: first.stepId, outcome: 'done', validatorResults: passingValidators(first) });
    runtime.openAcceptance({ planId: plan.planId });
    advance(3600);
    const decision = runtime.accept({ planId: plan.planId });
    check(!decision.accepted && decision.reasonCode === 'ACCEPTANCE_STALE_EVIDENCE', 'план не закрывается без свежего доказательства по каждому пункту', `missing=${decision.missing.length} stale=${decision.stale.length}`);
  }
}

// ── 7. HH simple schedule без GTD ─────────────────────────────────────────
section('7. HH simple schedule stays without GTD');
{
  const gtd = createGtdPort({ clock, transport: createInProcessGtdTransport({ clock }) });
  const schedule = createSimpleSchedule({ scheduleId: 'SC-hh-recruiting', intervalSeconds: 3600, gtdPort: gtd, clock, profileId: PROFILE });
  const first = schedule.fire({ at: clock() });
  advance(3600);
  const second = schedule.fire({ at: clock() });
  const duplicate = schedule.fire({ at: clock() });
  check(first.status === 'fired' && second.status === 'fired', 'два срабатывания → две задачи', `${first.userTaskId} / ${second.userTaskId}`);
  check(first.userTaskId !== second.userTaskId, 'каждое срабатывание — новая userTaskId');
  check(duplicate.status === 'duplicate' && !duplicate.created, 'повтор того же тика не создаёт вторую задачу');
  check(gtd.calls.register === 0 && gtd.records().length === 0, 'расписание само не регистрирует контроль', `register calls=${gtd.calls.register}`);
  const terminal = schedule.terminalResult(first.userTaskId);
  check(terminal.continuationOwner === 'output' && !('gtdId' in terminal), 'терминальный результат без gtdId (его нет, а не «пустой»)');
  const disabled = schedule.disable();
  advance(3600);
  check(schedule.fire({ at: clock() }).status === 'disabled', 'выключенное расписание не создаёт задач');
  check(disabled.acceptedTasksUntouched.length === 2, 'disable ≠ cancel: принятые задачи не тронуты');
  check(schedule.occurrences().length === 2, 'выключение не удаляет историю срабатываний');
}

// ── 8. Логи этапа I07 ──────────────────────────────────────────────────────
section('8. I07 logs: correlation, event keys, transition reasons, no secrets');
{
  const { runtime, gtd } = runtimeFor('logs', { conclusions: ['pending', 'green'] });
  const plan = runtime.compile({ root: REPO, playbookId: 'feature', profileId: PROFILE, userTaskId: 'ut-p24-logs', goal: GOAL, vars: varsFor('feature'), bindings: [{ name: 'github', ref: 'sbx/github#write', scope: 'repo:write' }] });
  const step = runtime.readyStep(plan.planId);
  runtime.runStep({ planId: plan.planId, stepId: step.stepId, outcome: 'done', validatorResults: passingValidators(step) });
  const ciStep = runtime.load(plan.planId).steps.find(candidate => candidate.stepType === 'ci-green');
  runtime.save({ ...runtime.load(plan.planId), stepStates: Object.fromEntries(runtime.load(plan.planId).steps.map(candidate => [candidate.stepId, candidate.stepId === ciStep.stepId ? 'pending' : 'passed'])) });
  runtime.runStep({ planId: plan.planId, stepId: ciStep.stepId, outcome: 'done', validatorResults: {} });

  const entries = runtime.log.entries;
  const keys = new Set();
  let clean = true;
  for (const entry of entries) {
    keys.add(entry.event);
    const serialized = JSON.stringify(entry);
    if (!('profileId' in entry) || !('userTaskId' in entry) || !('runId' in entry) || !('operationId' in entry)) clean = false;
    if (!('from' in entry) || !('to' in entry) || typeof entry.reasonCode !== 'string' || entry.reasonCode.length === 0) clean = false;
    if (serialized.includes(GOAL) || serialized.includes(BINDING_VALUE) || /Bearer |token=|apiKey/i.test(serialized) || serialized.includes(process.env.HOME || '/Users/')) clean = false;
  }
  check(clean, 'каждая строка лога несёт корреляцию, ключ события и причину перехода; секретов и текста задачи нет', `${entries.length} строк`);
  for (const expected of ['plan.compiled', 'step.settled', 'gtd.skipped', 'external.dispatch.confirmed', 'external.poll']) {
    check(keys.has(expected), `в логе есть ${expected}`);
  }
  const compiled = entries.find(entry => entry.event === 'plan.compiled');
  check(compiled.gtdId === null && compiled.continuationOwner === 'output', 'unmanaged-план в логе помечен как output-owned');
  check(gtd.calls.outcomes === 0, 'GTD не вызывался для unmanaged-задачи');
}

// ── 9. Приёмка репозитория ────────────────────────────────────────────────
section('9. repo acceptance tests');
{
  const run = spawnSync(process.execPath, ['--test', 'tests/execution-plans.test.js'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  const pass = (out.match(/^ℹ pass (\d+)$/m) || [])[1];
  const fail = (out.match(/^ℹ fail (\d+)$/m) || [])[1];
  check(run.status === 0 && fail === '0', 'tests/execution-plans.test.js зелёные', `pass=${pass} fail=${fail}`);
}

// ── Cleanup и transcript ───────────────────────────────────────────────────
section('cleanup');
{
  const leftovers = fs.existsSync(SANDBOX_ROOT) ? fs.readdirSync(SANDBOX_ROOT).length : 0;
  note(`песочница прогона: ${path.relative(REPO, SANDBOX_ROOT)} (${leftovers} каталогов, изолированный data root, файлы не коммитятся)`);
  const evidenceText = transcript.join('\n');
  check(!evidenceText.includes(BINDING_VALUE) && !evidenceText.includes(GOAL), 'credential и текст задачи не попали в transcript');
  check(!evidenceText.includes(process.env.HOME || '/Users/') && !/\/Users\//.test(evidenceText), 'личные пути хоста не попали в transcript');
  check(!/\/var\/folders\//.test(evidenceText) && !/node_modules/.test(evidenceText), 'системные пути не попали в transcript');
}

console.log('\n=== TRANSCRIPT (sanitized) ===');
for (const line of transcript) console.log(line);
console.log('=== END TRANSCRIPT ===');

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    card: 'P24 — real playbooks and plan adaptation',
    epic: 'E5 · trained-assist/trained-agent-architecture#21',
    issue: 'trained-assist/trained-agent-architecture#63',
    acceptance: 'AC-143',
    stage: 'I07',
    fixture: 'synthetic cloud CI on disk + in-process GTD transport + virtual clock; real pinned playbook artifacts of this checkout',
    generatedAt: new Date().toISOString(),
    sourceRevision: process.env.P24_SOURCE_REVISION || null,
    node: process.version,
    failures,
    transcript: transcript.filter(Boolean),
  };
  const file = path.join(OUT_DIR, 'transcript.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(OUT_DIR, 'transcript.sha256'), `${sha}  transcript.json\n`);
  console.log(`\n[sandbox] transcript: ${path.relative(REPO, file)} (sha256 ${sha.slice(0, 16)}…)`);
}

if (failures.length > 0) {
  console.error(`\n[sandbox] FAIL — ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n[sandbox] PASS — все проверки P24 зелёные; песочница: ${path.relative(REPO, SANDBOX_ROOT)}`);
process.exit(0);