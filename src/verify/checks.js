'use strict';

// Deterministic checks for engineering_verify (#113).
//
// Rules this file exists to enforce:
//   - a check returns a RECEIPT (typed, with observed_at and the reference it
//     was read from), never a bare boolean. «Файл существует» — это existence,
//     а не доказательство того, что инструмент отработал: existence-чек не
//     закрывает требование, которому нужен tool receipt / output (AC #113);
//   - проверка исполняется только в явно включённом режиме (run_checks) и
//     только внутри изолированной рабочей области; текст требований никогда не
//     исполняется — команда приходит структурно из checks[];
//   - недоступность (нет доступа к GitHub, нет рабочей области, тишина CI,
//     таймаут команды) даёт unknown с кодом, а не fail: infra ≠ провал (#122);
//   - «CI зелёный» при нуле джобов невозможен: 0 проверок = unknown, не pass
//     (дыра из #93).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED_KINDS = ['ci_green', 'pr_merged', 'file_at_commit', 'workspace_file', 'command'];
const SCOPES = ['implementation', 'delivery', 'user_scenario'];

const SCOPE_KINDS = {
  implementation: ['ci_green', 'file_at_commit', 'workspace_file', 'command'],
  delivery: ['pr_merged', 'ci_green'],
  user_scenario: ['command'],
};

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const CI_CONCLUSIONS_FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** Receipt types a requirement with a given evidence expectation accepts. */
const EVIDENCE_ACCEPTS = {
  existence: new Set(['existence', 'blob', 'ci', 'merge', 'output']),
  receipt: new Set(['blob', 'ci', 'merge', 'output']),
  output: new Set(['output']),
};

function ok(status, receipt, evidenceRef, extra = {}) {
  return { status, receipt: receipt || null, evidenceRef: evidenceRef || null, observed_at: new Date().toISOString(), ...extra };
}

function unknown(reasonCode, message, extra = {}) {
  return ok('unknown', null, null, { reason_code: reasonCode, message });
}

async function ciGreen(check, ctx) {
  const { repo, pinnedSha, ghFetch } = ctx;
  if (!pinnedSha) return unknown('NO_PINNED_SHA', 'нет закреплённой ревизии — CI проверять не по чему');
  let runs;
  let statusState = null;
  try {
    runs = await ghFetch(`/repos/${repo}/commits/${pinnedSha}/check-runs`);
    const st = await ghFetch(`/repos/${repo}/commits/${pinnedSha}/status`);
    statusState = st && st.state ? st.state : null;
  } catch (e) {
    return unknown('CI_UNREADABLE', `статусы проверок не читаются: ${e && e.message ? e.message : e}`);
  }
  const list = (runs && Array.isArray(runs.check_runs)) ? runs.check_runs : [];
  const summary = {
    type: 'ci',
    ref: `${repo}@${pinnedSha}`,
    total: list.length,
    conclusions: list.reduce((acc, r) => {
      const key = r.conclusion || r.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    status_state: statusState,
    source: `check-runs ${repo}@${pinnedSha}`,
  };

  if (!list.length && !statusState) {
    return unknown('CI_NO_CHECKS', `на ${pinnedSha} нет ни одного чека — «зелёный CI» при нуле джобов не бывает`, { receipt: ok('unknown', summary, null).receipt });
  }
  const failed = list.filter((r) => CI_CONCLUSIONS_FAIL.has(r.conclusion));
  if (failed.length || statusState === 'failure' || statusState === 'error') {
    return ok('fail', summary, `ci:${repo}@${pinnedSha}`, { message: `CI красный: ${failed.map((r) => r.name).slice(0, 5).join(', ') || statusState}` });
  }
  const running = list.filter((r) => r.status !== 'completed');
  if (running.length || statusState === 'pending') {
    return unknown('CI_RUNNING', `проверки ещё выполняются (${running.length || 'commit status pending'})`, { receipt: summary });
  }
  return ok('pass', summary, `ci:${repo}@${pinnedSha}`);
}

async function prMerged(check, ctx) {
  const { repo, ghFetch } = ctx;
  const number = Number(check.pr || ctx.prNumber);
  if (!Number.isInteger(number) || number <= 0) return unknown('NO_PR_REF', 'у проверки нет номера PR (check.pr или target.pr)');
  let pr;
  try {
    pr = await ghFetch(`/repos/${repo}/pulls/${number}`);
  } catch (e) {
    return unknown('PR_UNREADABLE', `PR ${repo}#${number} не читается: ${e && e.message ? e.message : e}`);
  }
  const receipt = {
    type: 'merge',
    ref: `${repo}#${number}`,
    merged: Boolean(pr.merged),
    merged_at: pr.merged_at || null,
    merge_commit_sha: pr.merge_commit_sha || null,
    state: pr.state,
    source: `pulls/${number}`,
  };
  if (!pr.merged) return ok('fail', receipt, `pr:${repo}#${number}`, { message: `PR ${repo}#${number} не смержен (state=${pr.state})` });
  return ok('pass', receipt, `pr:${repo}#${number}`);
}

function encodeContentPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

async function fileAtCommit(check, ctx) {
  const { repo, pinnedSha, ghFetch } = ctx;
  if (!pinnedSha) return unknown('NO_PINNED_SHA', 'нет закреплённой ревизии — файл проверять не по чему');
  const rel = String(check.path);
  try {
    const blob = await ghFetch(`/repos/${repo}/contents/${encodeContentPath(rel)}?ref=${encodeURIComponent(pinnedSha)}`);
    if (!blob || Array.isArray(blob) || blob.type !== 'file') {
      return ok('fail', { type: 'blob', ref: `${repo}@${pinnedSha}`, path: rel, note: 'по этому пути не файл' }, `blob:${repo}@${pinnedSha}:${rel}`, { message: `по пути ${rel} на ${pinnedSha} нет файла` });
    }
    return ok('pass', { type: 'blob', ref: `${repo}@${pinnedSha}`, path: rel, blob_sha: blob.sha, size: blob.size, source: `contents?ref=${pinnedSha}` }, `blob:${repo}@${pinnedSha}:${rel}`);
  } catch (e) {
    const status = e && e.status;
    if (status === 404) {
      return ok('fail', { type: 'blob', ref: `${repo}@${pinnedSha}`, path: rel, note: 'path-absent-at-commit' }, `blob:${repo}@${pinnedSha}:${rel}`,
        { message: `файла ${rel} нет на закреплённой ревизии ${pinnedSha}` });
    }
    return unknown('CONTENT_UNREADABLE', `${rel} не читается на ${pinnedSha}: ${e && e.message ? e.message : e}`);
  }
}

function workspaceFile(check, ctx) {
  const { codePath } = ctx;
  if (!codePath) return unknown('NO_WORKSPACE', 'рабочая области нет — локальную файловую проверку выполнить не по чему');
  const rel = String(check.path);
  const abs = path.resolve(codePath, rel);
  if (!abs.startsWith(path.resolve(codePath))) {
    return unknown('PATH_OUTSIDE_WORKSPACE', `путь ${rel} выходит за пределы рабочей области`);
  }
  if (!fs.existsSync(abs)) {
    return ok('fail', { type: 'existence', path: rel, exists: false, code_path: codePath }, `exists:${abs}`, { message: `файла ${rel} нет в рабочей области` });
  }
  const st = fs.statSync(abs);
  return ok('pass', { type: 'existence', path: rel, exists: true, size: st.size, mtime: st.mtime.toISOString(), code_path: codePath }, `exists:${abs}`);
}

function commandCheck(check, ctx) {
  const { codePath, workspaceRoot, runChecks } = ctx;
  if (!runChecks) {
    return unknown('COMMAND_CHECK_DISABLED',
      'команды не исполняются: включи явным режимом run_checks=true (и только для изолированной рабочей области)');
  }
  if (!codePath) return unknown('NO_WORKSPACE', 'команду можно выполнять только в рабочей области');
  const root = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!root || !path.resolve(codePath).startsWith(root)) {
    return unknown('NOT_ISOLATED_WORKSPACE',
      `рабочая область вне изолированного корня (${root || 'ENGINEERING_WORKSPACE_ROOT не задан'}) — команды запрещены`);
  }
  const command = String(check.command);
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd: codePath,
    encoding: 'utf8',
    timeout: Number(check.timeout_ms) > 0 ? Number(check.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (res.error && res.error.code === 'ETIMEDOUT') {
    return unknown('COMMAND_TIMEOUT', `команда не уложилась в таймаут: ${command.slice(0, 120)}`);
  }
  if (res.error) {
    return unknown('COMMAND_SPAWN_FAILED', `команда не запустилась: ${res.error.message}`);
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`.slice(-MAX_OUTPUT_CHARS);
  const receipt = {
    type: 'output',
    command: command.slice(0, 300),
    exit_code: res.status,
    output_excerpt: out.slice(-MAX_OUTPUT_CHARS),
    cwd: codePath,
    source: 'spawnSync(/bin/sh)',
    observed_at: new Date().toISOString(),
  };
  const evidenceRef = `cmd:${codePath}#${res.status}`;
  if (res.status === 0) return ok('pass', receipt, evidenceRef);
  return ok('fail', receipt, evidenceRef, { message: `команда завершилась с кодом ${res.status}` });
}

const RUNNERS = {
  ci_green: ciGreen,
  pr_merged: prMerged,
  file_at_commit: fileAtCommit,
  workspace_file: workspaceFile,
  command: commandCheck,
};

async function runCheck(check, ctx) {
  const kind = check && check.kind;
  const observedAt = new Date().toISOString();
  if (!SUPPORTED_KINDS.includes(kind)) {
    return { kind, ...unknown('UNSUPPORTED_CHECK', `неизвестный вид проверки «${kind}» — поддерживаемые: ${SUPPORTED_KINDS.join(', ')}`) };
  }
  if (ctx.scope && ctx.scope !== 'all' && !(SCOPE_KINDS[ctx.scope] || []).includes(kind)) {
    return { kind, ...unknown('CHECK_OUT_OF_SCOPE', `проверка «${kind}» не относится к scope «${ctx.scope}» (допустимые: ${(SCOPE_KINDS[ctx.scope] || []).join(', ') || '—'})`) };
  }
  const runner = RUNNERS[kind];
  const result = await runner(check, { ...ctx, scope: ctx.scope });
  return { kind, ...result, observed_at: result.observed_at || observedAt };
}

/**
 * Does the receipt satisfy the requirement's evidence expectation?
 * «Файл существует» не заменяет tool receipt / output validation (AC #113).
 */
function evidenceSatisfies(evidence, receipt) {
  if (!receipt || !receipt.type) return { ok: false, gap: 'NO_RECEIPT' };
  const accepts = EVIDENCE_ACCEPTS[evidence] || EVIDENCE_ACCEPTS.receipt;
  if (accepts.has(receipt.type)) return { ok: true };
  return { ok: false, gap: evidence === 'output' ? 'OUTPUT_REQUIRED' : 'NO_TOOL_RECEIPT' };
}

module.exports = {
  SUPPORTED_KINDS,
  SCOPES,
  SCOPE_KINDS,
  EVIDENCE_ACCEPTS,
  runCheck,
  evidenceSatisfies,
};
