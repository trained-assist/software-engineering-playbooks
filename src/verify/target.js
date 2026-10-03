'use strict';

// Target resolution for engineering_verify (#113): what exactly is being
// judged, pinned to ONE revision before any check runs.
//
// Pinning first is the whole point: checks, evidence and the receipt all carry
// the same `pinned_sha`, so «verified» is never a claim about a moving branch.
// A target that cannot be pinned does not produce a verdict — it produces
// inconclusive with the access code (never «not met»), and a target that does
// not belong to the declared repository is an input error (TARGET_MISMATCH),
// not a quiet verification of something else.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { normalizeRepo } = require('../change-find/find');
const { prStatus } = require('../github/pr-status-core');
const { classify } = require('../github/client');
const local = require('../change-status/local');

function fail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

const ACCESS_CODES = new Set(['GITHUB_AUTH', 'GITHUB_FORBIDDEN', 'GITHUB_ERROR', 'RATE_LIMITED', 'NETWORK']);

function repoFromUrl(url) {
  const m = String(url || '').match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues|commit)\/?/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function kindsOf(target) {
  const kinds = [];
  if (target.pr !== undefined && target.pr !== null && target.pr !== '') kinds.push('pr');
  if (target.commit) kinds.push('commit');
  if (target.branch) kinds.push('branch');
  if (target.artifact) kinds.push('artifact');
  if (target.workspace_ref) kinds.push('workspace');
  return kinds;
}

/**
 * @returns {Promise<{resolved:true, target:{…}} | {resolved:false, limitation:{code,message}}>}
 * Throws only on caller mistakes (no target, wrong repository, unknown ref) —
 * those are not verification outcomes.
 */
async function resolveTarget(input = {}, deps = {}) {
  const now = deps.now || Date.now;
  const ghFetch = deps.ghFetch;
  const prStatusImpl = deps.prStatus || prStatus;
  const principal = deps.principal !== undefined ? deps.principal : (process.env.USER_ID || '');
  const workspaceRoot = deps.workspaceRoot;
  const target = input.target && typeof input.target === 'object' ? input.target : {};

  const kinds = kindsOf(target);
  if (!kinds.length) {
    throw fail('INVALID_TARGET', 'target is required: pass target.pr, target.commit, target.branch, target.workspace_ref or target.artifact');
  }
  if (kinds.length > 1) {
    throw fail('INVALID_TARGET', `target must name one thing, got: ${kinds.join(', ')}`);
  }
  const kind = kinds[0];

  const repo = target.repo ? normalizeRepo(target.repo) : (input.repo ? normalizeRepo(input.repo) : null);
  if (kind !== 'artifact' && !repo) {
    throw fail('INVALID_REPO', 'repo is required to pin a GitHub target: pass repo="owner/name" (or target.repo)');
  }
  if (target.url && repoFromUrl(target.url) && repo && repoFromUrl(target.url) !== repo) {
    throw fail('TARGET_MISMATCH',
      `target URL belongs to ${repoFromUrl(target.url)} but the call declares ${repo} — refusing to verify a different repository`,
      { url_repo: repoFromUrl(target.url), declared_repo: repo });
  }

  const observedAt = new Date(now()).toISOString();

  if (kind === 'artifact') {
    const file = path.resolve(String(target.artifact));
    if (!fs.existsSync(file)) throw fail('TARGET_NOT_FOUND', `artifact not found: ${file}`);
    const buf = fs.readFileSync(file);
    return {
      resolved: true,
      target: {
        kind: 'artifact',
        repository_id: repo,
        artifact_path: file,
        pinned_sha: `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`,
        observed_at: observedAt,
        limits: ['артефакт не привязан к git-ревизии: пин — хеш содержимого'],
      },
    };
  }

  if (kind === 'workspace') {
    // An explicit workspace id is looked up WITHOUT the repository filter, so a
    // workspace that belongs to another repository surfaces as TARGET_MISMATCH
    // instead of a silent «not found» (the wrong-repository case must be an
    // input error, not an unverifiable target).
    const ws = local.resolveWorkspace({
      workspaceRef: target.workspace_ref,
      taskRef: target.task_ref,
      repo: target.workspace_ref ? undefined : repo,
      principal,
      workspaceRoot,
    });
    if (!ws.found) {
      // A workspace we cannot resolve proves nothing about the change — the
      // verification is inconclusive, not failed.
      return {
        resolved: false,
        limitation: { code: 'WORKSPACE_UNRESOLVED', message: ws.reason || 'рабочая область не найдена' },
      };
    }
    const recordRepo = ws.record && ws.record.repositoryId ? normalizeRepo(ws.record.repositoryId) : null;
    if (recordRepo && repo && recordRepo !== repo) {
      throw fail('TARGET_MISMATCH',
        `workspace ${ws.workspace_id || ws.code_path} belongs to ${recordRepo} but the call declares ${repo}`,
        { workspace_repo: recordRepo, declared_repo: repo });
    }
    const facts = local.gitFacts(ws.code_path);
    if (facts.available !== true) {
      return {
        resolved: false,
        limitation: { code: 'WORKSPACE_UNAVAILABLE', message: facts.reason || 'git-факты рабочей области недоступны' },
      };
    }
    return {
      resolved: true,
      target: {
        kind: 'workspace',
        repository_id: recordRepo || repo,
        workspace_id: ws.workspace_id || null,
        workspace_path: facts.code_path,
        branch: facts.branch || null,
        pinned_sha: facts.head_sha,
        observed_at: observedAt,
        limits: facts.dirty && facts.dirty.files ? [`в рабочей области ${facts.dirty.files} несохранённых файлов: пин — HEAD, рабочее дерево может быть новее`] : [],
      },
    };
  }

  if (kind === 'pr') {
    const number = Number(target.pr);
    if (!Number.isInteger(number) || number <= 0) throw fail('INVALID_TARGET', `target.pr must be a positive number, got «${target.pr}»`);
    let r;
    try {
      r = await prStatusImpl(repo, number, { include_logs: false, enrich: false });
    } catch (e) {
      r = { ok: false, error: { code: 'GITHUB_ERROR', message: e && e.message ? e.message : String(e) } };
    }
    if (!r.ok) {
      const code = (r.error && r.error.code) || 'GITHUB_ERROR';
      if (code === 'NOT_FOUND' || code === 'NOT_A_PR') {
        throw fail('TARGET_NOT_FOUND', `PR ${repo}#${number} not found: ${r.error && r.error.message ? r.error.message : code}`);
      }
      if (ACCESS_CODES.has(code)) {
        return { resolved: false, limitation: { code, message: `PR ${repo}#${number} не читается: ${r.error && r.error.message ? r.error.message : code}` } };
      }
      return { resolved: false, limitation: { code, message: `PR ${repo}#${number} не прочитан: ${r.error && r.error.message ? r.error.message : code}` } };
    }
    const pr = r.pr || {};
    const pinned = (pr.merged && pr.merge_commit_sha) || pr.head_sha || null;
    if (!pinned) return { resolved: false, limitation: { code: 'TARGET_UNPINNABLE', message: `у PR ${repo}#${number} нет head_sha/merge_commit_sha` } };
    return {
      resolved: true,
      target: {
        kind: 'pull',
        repository_id: repo,
        number: pr.number,
        merged: Boolean(pr.merged),
        url: pr.url || null,
        head_sha: pr.head_sha || null,
        merge_commit_sha: pr.merge_commit_sha || null,
        pinned_sha: pinned,
        observed_at: observedAt,
        limits: pr.merged ? [] : ['PR не смержен: пин — head PR, а не ревизия main'],
      },
    };
  }

  // commit / branch — read the object itself so the pin is the canonical SHA.
  const rev = kind === 'commit' ? String(target.commit) : String(target.branch);
  if (kind === 'commit' && !/^[0-9a-f]{7,40}$/i.test(rev)) {
    throw fail('INVALID_TARGET', `target.commit must be a hex sha, got «${rev}»`);
  }
  if (typeof ghFetch !== 'function') throw fail('INVALID_DEPS', 'ghFetch is required to pin a commit or branch');
  let commit;
  try {
    commit = await ghFetch(`/repos/${repo}/commits/${encodeURIComponent(rev)}`);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    const code = (classify(e) || {}).code || 'GITHUB_ERROR';
    if (code === 'NOT_FOUND') {
      throw fail('TARGET_NOT_FOUND', `${kind} «${rev}» not found in ${repo}`);
    }
    if (ACCESS_CODES.has(code)) {
      return { resolved: false, limitation: { code, message: `${kind} «${rev}» не читается: ${message}` } };
    }
    return { resolved: false, limitation: { code, message: `${kind} «${rev}» не прочитан: ${message}` } };
  }
  if (!commit || !commit.sha) return { resolved: false, limitation: { code: 'TARGET_UNPINNABLE', message: `GitHub не вернул sha для ${kind} «${rev}»` } };
  return {
    resolved: true,
    target: {
      kind,
      repository_id: repo,
      ref: rev,
      pinned_sha: commit.sha,
      observed_at: observedAt,
      limits: [],
    },
  };
}

module.exports = { resolveTarget, repoFromUrl, kindsOf };
