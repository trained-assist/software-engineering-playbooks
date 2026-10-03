'use strict';

// engineering_change_bind (#111) — the WRITE half of the contract: recording
// which change belongs to a task is a separate, explicit operation. Find never
// writes; bind never searches. The record goes into the host-owned workspace
// store (bindings/) under the caller's principal, so the next process of the
// same profile reads it back and another profile never sees it.

const { parseKnownRefs, normTask } = require('./refs');
const local = require('./local');
const { normalizeRepo } = require('./find');

function fail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

function normalizeRefs(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : (value === undefined || value === null ? [] : [value]));
  const refs = list.map((r) => String(r === undefined || r === null ? '' : r).trim()).filter(Boolean);
  if (!refs.length) {
    throw fail('INVALID_REFS', 'refs is required — pass the chosen change refs, e.g. ["PR #115"] or ["branch eng/…"]');
  }
  if (refs.length > 50) throw fail('INVALID_REFS', `refs is capped at 50 entries, got ${refs.length}`);
  return refs;
}

async function changeBind(input = {}, deps = {}) {
  const now = deps.now || Date.now;
  const repo = normalizeRepo(input.repo);
  const taskRef = typeof input.task_ref === 'string' ? input.task_ref.trim() : '';
  if (!taskRef) throw fail('INVALID_TASK_REF', 'task_ref is required — the task label the refs belong to');
  const refs = normalizeRefs(input.refs);
  const principal = deps.principal !== undefined ? deps.principal : (process.env.USER_ID || '');
  if (!principal) throw fail('PRINCIPAL_MISSING', 'USER_ID is not set — a binding must be owned by a profile, refusing to write it anonymously');
  const workspaceRoot = deps.workspaceRoot;

  const parsed = parseKnownRefs(refs);
  const unrecognised = parsed.unknown;

  const workspaces = local.listWorkspaces({ workspaceRoot, principal, repositoryId: repo });
  const match = workspaces.find((w) => normTask(w.rootTaskId) === normTask(taskRef)) || null;

  const record = local.writeBinding({
    workspaceRoot,
    principal,
    repositoryId: repo,
    taskRef,
    refs,
    workspaceId: match ? match.workspaceId : null,
    now,
  });

  return {
    ok: true,
    persisted: true,
    principal,
    repo,
    task_ref: taskRef,
    binding: record,
    workspace: match
      ? { found: true, workspace_id: match.workspaceId, branch: match.branch || null, status: match.status || null, code_path: match.codePath || null }
      : { found: false, note: 'no workspace record with this root_task_id in this repository for this profile' },
    parsed: {
      numbers: parsed.numbers.map((n) => ({ number: n.number, via: n.via })),
      branches: parsed.branches,
      commits: parsed.commits,
      urls: parsed.urls.map((u) => ({ repo: u.repo, kind: u.kind, number: u.number || null, sha: u.sha || null, name: u.name || null, url: u.url })),
      unrecognised,
    },
    sources: [{ name: 'workspace-store', ok: true, operation: 'write', principal }],
    limitations: [
      'запись выполняется от профиля (principal=USER_ID): другой профиль её не увидит',
      'повторный вызов с тем же task_ref обновляет refs и updatedAt, createdAt сохраняется',
      unrecognised.length ? `не разобраны как ref, сохранены как есть: ${unrecognised.join(', ')}` : null,
    ].filter(Boolean),
  };
}

module.exports = { changeBind, normalizeRefs };
