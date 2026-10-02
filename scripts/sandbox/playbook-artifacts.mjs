#!/usr/bin/env node
// Sandbox loop для P14 — «Доменные tools и playbook artifact retrieval» (эпик E5 #21,
// карточка #53, этап I04). Одна команда, детерминированный PASS/FAIL.
//
// Сценарий приёмки AC-116, разложенный на наблюдаемые шаги:
//   1. capability-каталог: версия / bindings / permissions объявлены ДО вызова;
//   2. read отдаёт pinned-артефакт как данные (путь + sha256 + объявленные входы);
//   3. read НЕ запускает план: execution.planStarted=false и на диске, кроме лога,
//      ничего не появилось;
//   4. advisory-вызов проходит без gtdId и не создаёт его;
//   5. мутация фейкового провайдера подтверждена проверяемой receipt;
//   6. повтор по тому же operationId = та же квитанция, ровно один внешний эффект;
//   7. управляемые сбои: чужой scope, binding отсутствует, missing_input, дрейф
//      версии, таймаут с неизвестным исходом (без слепого повтора), «ок» без
//      квитанции, истёкшая выдача, недоступный провайдер;
//   8. логи I04: profileId/userTaskId/runId/operationId + ключ события + причина
//      перехода, и ни одного значения credential binding'а;
//   9. MCP-фасад зарегистрирован и отвечает тем же handler'ом;
//  10. приёмка репозитория: tests/playbook-artifacts*.test.js зелёные.
//
// Уровень: S3 — реальные модули этого репозитория, сеть недоступна, движок не нужен.
// Внешние зависимости: фейковый провайдер пишет состояние на диск в изолированный
// .sandbox/p14-<pid>/ — это настоящий внешний эффект с проверяемой квитанцией, а не
// заглушка. Прод-данные, секреты и реальные провайдеры не используются.
//
// Run:   npm run test:sandbox:playbook-artifacts
//        node scripts/sandbox/playbook-artifacts.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const BINDING_VALUE = 'sandbox-fixture-binding-value';
const CLOCK = () => new Date('2026-10-03T10:00:00.000Z');
const SANDBOX_ROOT = path.join(REPO, '.sandbox', `p14-${process.pid}`);
fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

const { createPlaybookArtifactHost, readEvents } = require(path.join(REPO, 'src', 'playbook-artifacts'));
const registry = require(path.join(REPO, 'src', 'mcp-skills', 'registry'));

const failures = [];
const transcript = [];
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '   ok  -' : '   FAIL-'} ${label}${extra ? ` — ${extra}` : ''}`);
  transcript.push(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(label);
};
const note = line => { console.log(`          ${line}`); transcript.push(`     ·  ${line}`); };

const READ_CALLER = { profileId: 'p14-sandbox-profile', userTaskId: 'ut-p14-42' };
const READ_BINDING = { ref: 'sbx/playbooks#read', scope: 'playbooks:read' };
const WRITE_BINDING = { ref: 'sbx/playbooks#write', scope: 'playbooks:write' };
const bindingResolver = ({ ref }) => (ref ? BINDING_VALUE : undefined);

const hosts = [];
function host({ fault = 'none', dataRoot = path.join(SANDBOX_ROOT, 'data'), sourceRevision = 'sandbox-pinned-rev' } = {}) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const created = createPlaybookArtifactHost({
    root: REPO,
    dataRoot,
    profileId: READ_CALLER.profileId,
    clock: CLOCK,
    providerFault: fault,
    bindingResolver,
    sourceRevision,
  });
  hosts.push(created);
  return created;
}

console.log(`[sandbox] P14 · domain tools + playbook artifact retrieval (issue #53, stage I04)`);
console.log(`[sandbox] isolated sandbox: ${path.relative(REPO, SANDBOX_ROOT)} (no network, no engine, no production data)`);

// ── 1. Capability-каталог: версия / bindings / permissions явны ─────────────
{
  const main = host();
  console.log('\n[1] capability descriptors (published before any invocation)');
  for (const capability of main.listCapabilities()) {
    note(`${capability.capabilityId}@${capability.capabilityVersion} effect=${capability.effect} scopes=${capability.requiredScopes.join('|') || '-'} approval=${capability.permissions.requiresApproval} retry=${capability.permissions.retrySafety} requiresGtdId=${capability.advisory.requiresGtdId} transports=${capability.transports.join(',')}`);
  }
  const descriptors = main.listCapabilities();
  check(descriptors.length === 3, 'три capability в домене (list/get/record_selection)');
  check(descriptors.every(c => typeof c.capabilityVersion === 'number' && c.capabilityVersion >= 1), 'у каждой capability объявлена версия');
  check(descriptors.every(c => Array.isArray(c.requiredScopes) && c.requiredScopes.length > 0), 'у каждой capability объявлены требуемые scopes');
  check(descriptors.every(c => c.permissions && typeof c.permissions.retrySafety === 'string'), 'у каждой capability объявлены permissions');
  check(descriptors.every(c => c.transports.some(t => t.startsWith('mcp:')) && c.transports.includes('internal-api')), 'один handler доступен через MCP и через внутренний API');
}

// ── 2–3. Read: pinned артефакт как данные; план не запускается ─────────────
{
  const dataRoot = path.join(SANDBOX_ROOT, 'read');
  fs.mkdirSync(dataRoot, { recursive: true });
  const before = fs.readdirSync(dataRoot);
  const reader = host({ dataRoot });
  const catalog = reader.invoke({ capabilityId: 'engineering.playbook.list', arguments: {}, caller: READ_CALLER, binding: READ_BINDING, operationId: 'op-p14-list' });
  check(catalog.kind === 'completed', 'каталог pinned-артефактов прочитан', `${catalog.result.artifacts.length} шт.`);
  check(catalog.result.artifacts.every(a => /^sha256:[0-9a-f]{64}$/.test(a.artifactHash)), 'у каждого артефакта объявлен sha256');

  const read = reader.invoke({
    capabilityId: 'engineering.playbook.get',
    arguments: { playbook_id: 'feature', detail: 'full' },
    caller: READ_CALLER,
    binding: READ_BINDING,
    operationId: 'op-p14-read',
  });
  const { playbook, definition, execution, provenance } = read.result;
  const onDisk = fs.readFileSync(path.join(REPO, 'playbooks', 'feature.json'));
  const expectedHash = `sha256:${crypto.createHash('sha256').update(onDisk).digest('hex')}`;
  console.log('\n[2] engineering.playbook.get — artifact as data/resource');
  note(`${playbook.artifactRef} ${playbook.artifactHash}`);
  note(`title=${playbook.title} version=${playbook.version} stages=${playbook.stageCount} steps=${playbook.stepCount} inputs=${playbook.inputs.map(i => i.name).join('|')}`);
  note(`definition: ${definition.id}@${definition.version}, ${definition.stages.length} stages (данные, а не инструкция запускать)`);
  note(`interface=${provenance.interface} definitionSource=${provenance.definitionSource}`);
  check(read.kind === 'completed', 'read capability завершилась completed');
  check(playbook.artifactHash === expectedHash, 'хеш ответа совпадает с файлом playbooks/feature.json на диске');
  check(playbook.version === 2 && playbook.stageCount > 0, 'версия и инвентарь этапов/шагов объявлены явно');
  check(playbook.inputs.some(i => i.name === 'repo' && i.required), 'обязательные входы артефакта объявлены явно');

  console.log('\n[3] read не запускает план');
  const after = fs.readdirSync(dataRoot).filter(entry => entry !== 'playbook-artifacts');
  check(execution.planStarted === false && execution.planId === null, 'ответ объявляет planStarted=false', execution.reason);
  check(after.length === before.length, 'на диске не появилось ни плана, ни рана, ни очереди', `dataRoot: ${after.join(',') || 'пусто'}`);
  const moduleSources = fs.readdirSync(path.join(REPO, 'src', 'playbook-artifacts')).map(f => fs.readFileSync(path.join(REPO, 'src', 'playbook-artifacts', f), 'utf8')).join('\n');
  check(!/require\((['"])[^'"]*(workspace|runner|queue)[^'"]*\1\)/.test(moduleSources), 'граф импортов домена не тянет plan/run/queue');
}

// ── 4. Advisory без gtdId ──────────────────────────────────────────────────
{
  const advisory = host({ dataRoot: path.join(SANDBOX_ROOT, 'advisory') });
  const read = advisory.invoke({
    capabilityId: 'engineering.playbook.get',
    arguments: { playbook_id: 'ci-run' },
    caller: { profileId: READ_CALLER.profileId },
    binding: READ_BINDING,
    operationId: 'op-p14-no-gtd',
  });
  console.log('\n[4] advisory playbook без gtdId');
  note(`envelope без gtdId: profileId=${read.result.correlation.profileId} userTaskId=${String(read.result.correlation.userTaskId)} runId=${String(read.result.correlation.runId)}`);
  check(read.kind === 'completed', 'read проходит без gtdId в envelope');
  check(read.result.advisory.requiresGtdId === false && read.result.advisory.createsGtdId === false && read.result.advisory.gtdId === null, 'advisory: gtdId не требуется и не создаётся');
  const advisoryEvent = advisory.log.entries.find(e => e.event === 'advisory.settled');
  check(Boolean(advisoryEvent) && advisoryEvent.reasonCode === 'ADVISORY_NO_GTD' && advisoryEvent.gtdId === null, 'в логе зафиксирована причина ADVISORY_NO_GTD');
}

// ── 5–6. Write: receipt и happens-once по operationId ──────────────────────
{
  const writer = host({ dataRoot: path.join(SANDBOX_ROOT, 'write') });
  console.log('\n[5] engineering.playbook.record_selection — mutation + receipt');
  const selection = { playbook_id: 'debugging', reason: 'репро → фикс → проверка' };
  const first = writer.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: selection, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-write' });
  note(`receipt: ${JSON.stringify(first.effectReceipt)}`);
  check(first.kind === 'completed', 'write capability завершилась completed');
  check(Boolean(first.effectReceipt && first.effectReceipt.receiptId && first.effectReceipt.externalRef), 'мутация подтверждена проверяемой receipt');
  const external = writer.provider.lookup('op-p14-write');
  check(external.found && external.receiptId === first.effectReceipt.receiptId, 'квитанция сверяется с записью внешнего провайдера', external.externalRef);
  check(first.result.selection.playbookVersion > 0, 'квитанция фиксирует версию определения, а не только имя');
  check(first.result.execution.planStarted === false, 'запись выбора не запускает план');

  const replay = writer.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: selection, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-write' });
  note(`replay: replayed=${replay.result.selection.replayed} receipt=${replay.effectReceipt.receiptId} provider records=${writer.provider.count()}`);
  check(replay.kind === 'completed' && replay.result.selection.replayed === true, 'повтор того же operationId — replay, а не новая запись');
  check(JSON.stringify(replay.effectReceipt) === JSON.stringify(first.effectReceipt), 'replay вернул ту же квитанцию');
  check(writer.provider.count() === 1, 'внешний эффект произошёл ровно один раз');
}

// ── 7. Управляемые сбои ────────────────────────────────────────────────────
{
  console.log('\n[7] controlled failures');
  const failures_ = host({ dataRoot: path.join(SANDBOX_ROOT, 'failures') });
  const refused = (() => {
    try {
      failures_.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: READ_CALLER, binding: { ref: 'other#admin', scope: 'playbooks:admin' }, operationId: 'op-p14-foreign' });
      return null;
    } catch (e) {
      return e;
    }
  })();
  note(`foreign scope: code=${refused && refused.code}`);
  check(Boolean(refused && refused.code === 'BINDING_SCOPE_MISSING'), "чужой scope binding отклонён хостом до handler'а", refused && refused.code);
  check(!failures_.log.entries.some(e => e.event === 'artifact.resolved'), 'при чужом scope артефакт не читался');

  const noBinding = failures_.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: READ_CALLER, operationId: 'op-p14-nobinding' });
  check(noBinding.kind === 'blocked', 'без binding — blocked с явной причиной', noBinding.reason.slice(0, 60));

  const missing = failures_.invoke({ capabilityId: 'engineering.playbook.get', arguments: {}, caller: READ_CALLER, binding: READ_BINDING, operationId: 'op-p14-missing' });
  check(missing.kind === 'missing_input' && missing.fields[0] === 'playbook_id', 'нет обязательного аргумента — missing_input, а не выдуманный ответ');

  const drift = failures_.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature', playbook_version: 99 }, caller: READ_CALLER, binding: READ_BINDING, operationId: 'op-p14-drift' });
  check(drift.kind === 'technical_error' && drift.code === 'ARTIFACT_VERSION_MISMATCH', 'дрейф версии артефакта — отказ, а не «ближайшая доступная»');

  const unknown = host({ fault: 'timeout', dataRoot: path.join(SANDBOX_ROOT, 'timeout') });
  const timedOut = unknown.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'таймаут' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-timeout' });
  note(`timeout: code=${timedOut.code} effectStateUnknown=${timedOut.effectStateUnknown} provider records=${unknown.provider.count()}`);
  check(timedOut.kind === 'technical_error' && timedOut.code === 'EFFECT_STATE_UNKNOWN' && timedOut.effectStateUnknown === true, 'неизвестный исход внешнего эффекта не объявляется успехом');
  check(unknown.provider.count() === 1, 'эффект у провайдера уже произошёл — именно поэтому повтор вслепую опасен');
  const reconcile = unknown.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'таймаут' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-timeout' });
  note(`reconcile by operationId: kind=${reconcile.kind} replayed=${reconcile.result && reconcile.result.selection.replayed} provider records=${unknown.provider.count()}`);
  check(reconcile.kind === 'completed' && reconcile.result.selection.replayed === true, 'reconcile по operationId вернул ту же квитанцию');
  check(unknown.provider.count() === 1, 'reconcile не создал второго эффекта');

  const noReceipt = host({ fault: 'no_receipt', dataRoot: path.join(SANDBOX_ROOT, 'noreceipt') });
  const ack = noReceipt.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'ack без квитанции' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-noreceipt' });
  check(ack.kind === 'technical_error' && ack.code === 'PROVIDER_RECEIPT_MISSING', '«ок» без квитанции наружу не выходит (PR-16)');

  const expired = host({ fault: 'expired_auth', dataRoot: path.join(SANDBOX_ROOT, 'expired') });
  const expiredOutcome = expired.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'истёкшая выдача' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-expired' });
  check(expiredOutcome.kind === 'blocked', 'истёкшая выдача — blocked человеческим текстом', expiredOutcome.reason);

  const down = host({ fault: 'unreachable', dataRoot: path.join(SANDBOX_ROOT, 'down') });
  const unreachable = down.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'провайдер недоступен' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-down' });
  check(unreachable.kind === 'technical_error' && unreachable.code === 'PROVIDER_UNREACHABLE' && down.provider.count() === 0, 'недоступный провайдер — типизированная техническая ошибка, эффекта нет');
}

// ── 8. Логи I04 ────────────────────────────────────────────────────────────
{
  console.log('\n[8] logs I04 (readiness/инвокация/receipt + причины переходов)');
  const logged = host({ dataRoot: path.join(SANDBOX_ROOT, 'logs') });
  logged.invoke({ capabilityId: 'engineering.playbook.get', arguments: { playbook_id: 'feature' }, caller: READ_CALLER, binding: READ_BINDING, operationId: 'op-p14-log-read' });
  logged.invoke({ capabilityId: 'engineering.playbook.record_selection', arguments: { playbook_id: 'feature', reason: 'лог' }, caller: READ_CALLER, binding: WRITE_BINDING, operationId: 'op-p14-log-write' });
  const lines = readEvents(logged.logFile);
  for (const line of lines) {
    note(`${line.at} ${line.event} ${line.from ?? '∅'}→${line.to} reason=${line.reasonCode} profile=${line.profileId} task=${String(line.userTaskId)} run=${String(line.runId)} op=${line.operationId}`);
  }
  check(lines.every(l => 'at' in l && 'event' in l && 'reasonCode' in l && 'to' in l), 'у каждой строки есть ключ события и причина перехода');
  check(lines.every(l => l.profileId === READ_CALLER.profileId), 'в каждой строке есть trusted profileId');
  check(lines.some(l => l.event === 'provider.mutation.confirmed' && l.reasonCode === 'RECEIPT_CONFIRMED'), 'effect receipt попал в лог с причиной RECEIPT_CONFIRMED');
  check(lines.some(l => l.reasonCode === 'MISSING_INPUT' || l.reasonCode === 'ARTIFACT_PINNED'), 'причины переходов читаются построчно');

  const transcriptText = transcript.join('\n');
  const logText = fs.readFileSync(logged.logFile, 'utf8');
  check(!logText.includes(BINDING_VALUE) && !transcriptText.includes(BINDING_VALUE), "значение credential binding не попало ни в лог, ни в transcript");
  check(!logText.includes(READ_CALLER.profileId + '/home') && !/"\/Users\//.test(logText) && !/"\/Users\//.test(transcriptText), 'личные пути хоста не попали в evidence');
}

// ── 9. MCP-фасад ───────────────────────────────────────────────────────────
{
  console.log('\n[9] MCP facade (интерфейс, а не определение)');
  const names = registry.listTools().map(t => t.name);
  for (const tool of ['engineering_playbook_list', 'engineering_playbook_get', 'engineering_playbook_record_selection']) {
    check(names.includes(tool), `тул зарегистрирован: ${tool}`);
  }
  const ctx = {
    profileId: READ_CALLER.profileId,
    userTaskId: READ_CALLER.userTaskId,
    operationId: 'op-p14-mcp',
    bindings: [READ_BINDING, WRITE_BINDING],
  };
  const viaMcp = await registry.callTool('engineering_playbook_get', { playbook_id: 'feature' }, ctx);
  check(viaMcp.ok === true && viaMcp.execution.planStarted === false, 'MCP-вызов отдаёт те же данные и не запускает план');
  const viaMcpNoBindings = await registry.callTool('engineering_playbook_get', { playbook_id: 'feature' }, { profileId: READ_CALLER.profileId });
  check(viaMcpNoBindings.ok === false && viaMcpNoBindings.outcome === 'blocked', 'MCP без binding — blocked, а не тихий ответ');
  const facadeSource = fs.readFileSync(path.join(REPO, 'src', 'mcp-skills', 'tools', '70-playbook-artifacts.js'), 'utf8');
  check(!facadeSource.includes('"step_type"') && !facadeSource.includes('goal_template'), 'в интерфейсе нет содержимого definition (templates ≠ MCP)');
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'provider-manifest.json'), 'utf8'));
  check(manifest.actions.filter(a => a.name.startsWith('engineering_playbook_')).length === 3, 'три действия в provider-manifest.json');
}

// ── 10. Приёмка репозитория ───────────────────────────────────────────────
{
  console.log('\n[10] repo acceptance tests');
  const r = spawnSync(process.execPath, ['--test', 'tests/playbook-artifacts.test.js', 'tests/playbook-artifact-tools.test.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = (out.match(/^ℹ pass (\d+)$/m) || [])[1];
  const fail = (out.match(/^ℹ fail (\d+)$/m) || [])[1];
  check(r.status === 0 && fail === '0', 'tests/playbook-artifacts*.test.js зелёные', `pass=${pass} fail=${fail}`);
}

// ── Transcript ─────────────────────────────────────────────────────────────
console.log('\n=== TRANSCRIPT (sanitized) ===');
for (const line of transcript) console.log(line);
console.log('=== END TRANSCRIPT ===');

if (failures.length > 0) {
  console.error(`\n[sandbox] FAIL — ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n[sandbox] PASS — все проверки P14 зелёные; песочница: ${path.relative(REPO, SANDBOX_ROOT)}`);
process.exit(0);
