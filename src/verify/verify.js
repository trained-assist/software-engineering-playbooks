'use strict';

// engineering_verify (#113) — an independent judge of whether a result meets
// the accepted requirements, callable outside a playbook run.
//
// What it deliberately does NOT do:
//   - it does not fix, commit, push or merge anything (read-only + one receipt
//     write into the caller's own verification store);
//   - it does not trust the implementer's report: evidence is re-collected from
//     GitHub / the workspace / an explicitly enabled command run;
//   - it does not collapse into one optimistic word: the answer keeps every
//     per-requirement verdict, and the overall verdict is the algebra below.
//
// Overall verdict algebra (required requirements only):
//   all satisfied                  → verified
//   some satisfied, some not       → partial
//   none satisfied, some not       → not_met
//   no verdicts, only unknowns     → inconclusive
// Unknown is never converted to pass, and access failures / a dead judge are
// limitations that produce inconclusive — never «не сделано».

const crypto = require('crypto');

const store = require('../workspace/store');
const { resolveRequirements } = require('./requirements');
const { resolveTarget } = require('./target');
const { runCheck, evidenceSatisfies, SCOPES, SUPPORTED_KINDS } = require('./checks');
const { judge: defaultJudge } = require('./judge');
const { verificationSlot } = require('../change-status/verification');
const { ghFetch: defaultGhFetch } = require('../github/client');

const RECORD_VERDICT = { verified: 'pass', partial: 'partial', not_met: 'not_met', inconclusive: 'inconclusive' };
const SHA_RE = /\b([0-9a-f]{7,40})\b/i;

function fail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null || scope === '') return 'implementation';
  if (!SCOPES.includes(scope)) throw fail('INVALID_SCOPE', `scope must be one of: ${SCOPES.join(', ')} — got «${scope}»`);
  return scope;
}

function normalizeEvidenceRefs(raw) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  return list.map((r) => String(r === undefined || r === null ? '' : r).trim()).filter(Boolean).slice(0, 30);
}

/** Provided evidence is only admissible if it is bound to the pinned revision. */
function classifyProvidedEvidence(refs, pinnedSha) {
  const fresh = [];
  const gaps = [];
  for (const ref of refs) {
    const m = ref.match(SHA_RE);
    if (!m) {
      gaps.push({ code: 'UNVERIFIABLE_EVIDENCE', ref, message: 'в ссылке нет ревизии — привязать утверждение к пину нельзя, в расчёт не идёт' });
      continue;
    }
    if (!pinnedSha || !String(pinnedSha).toLowerCase().startsWith(m[1].toLowerCase())) {
      gaps.push({ code: 'STALE_EVIDENCE', ref, message: `утверждение привязано к ${m[1]}, а проверяется ${pinnedSha || 'неизвестная ревизия'}` });
      continue;
    }
    fresh.push({ source: 'provided-evidence', ref, commit: pinnedSha });
  }
  return { fresh, gaps };
}

function emptyResult(item, reason, source = 'none') {
  return {
    id: item.id,
    text: item.text,
    required: item.required,
    verdict: 'unknown',
    source,
    checks: [],
    evidence: [],
    gaps: [],
    reason,
  };
}

async function collectChecks(item, ctx) {
  const out = [];
  for (const check of item.checks) {
    if (ctx.budgetChecks <= 0) {
      out.push({ kind: check.kind, status: 'unknown', reason_code: 'BUDGET_EXCEEDED', message: 'лимит проверок за вызов исчерпан' });
      break;
    }
    ctx.budgetChecks -= 1;
    out.push(await runCheck(check, ctx));
  }
  return out;
}

function judgeEvidenceText(results, provided) {
  const lines = [];
  for (const r of results) {
    for (const c of r.checks || []) {
      if (c.status === 'pass' || c.status === 'fail') {
        lines.push(`${r.id} check ${c.kind}: ${c.status}${c.message ? ` — ${c.message}` : ''}${c.evidenceRef ? ` [${c.evidenceRef}]` : ''}`);
      } else if (c.reason_code) {
        lines.push(`${r.id} check ${c.kind}: unknown (${c.reason_code})`);
      }
    }
    for (const e of r.evidence || []) lines.push(`${r.id} evidence: ${e}`);
  }
  for (const e of provided) lines.push(`provided evidence: ${e.ref} @ ${e.commit}`);
  return lines.join('\n');
}

/** Deterministic pass/fail/unknown for one requirement from its checks. */
function aggregateChecks(item, checkResults) {
  const passed = checkResults.filter((c) => c.status === 'pass');
  const failed = checkResults.filter((c) => c.status === 'fail');
  const unknowns = checkResults.filter((c) => c.status === 'unknown');
  const evidence = [];
  const gaps = [];

  for (const c of passed) {
    const fit = evidenceSatisfies(item.evidence, c.receipt);
    if (fit.ok) {
      evidence.push(c.evidenceRef || `${c.kind}:${c.receipt && c.receipt.type}`);
    } else {
      // The check passed, but what it proved is weaker than what the
      // requirement demands — «файл существует» не заменяет tool receipt.
      gaps.push({
        code: fit.gap,
        check: c.kind,
        message: `проверка «${c.kind}» дала ${c.receipt && c.receipt.type}, а требованию нужна evidence «${item.evidence}» — pass не засчитан`,
      });
      c.status = 'unknown';
      c.reason_code = fit.gap;
      unknowns.push(c);
    }
  }

  if (failed.length) {
    return { verdict: 'not_satisfied', source: 'deterministic', evidence, gaps, reason: failed.map((c) => c.message || c.reason_code).join('; ') || 'проверка не пройдена' };
  }
  // Все прошедшие чеки удовлетворили ожидание evidence → satisfied.
  const satisfiedByEvidence = passed.filter((c) => c.status === 'pass');
  if (satisfiedByEvidence.length && !unknowns.length) {
    return { verdict: 'satisfied', source: 'deterministic', evidence, gaps, reason: `${satisfiedByEvidence.length} детерминированная проверка(и) с receipt` };
  }
  if (satisfiedByEvidence.length && unknowns.length) {
    return { verdict: 'satisfied', source: 'deterministic', evidence, gaps, reason: `прошло ${satisfiedByEvidence.length}, остальные чеки не дали сигнала` };
  }
  return {
    verdict: 'unknown',
    source: 'deterministic',
    evidence,
    gaps,
    reason: unknowns.map((c) => c.reason_code || c.message).filter(Boolean).join('; ') || 'проверки не дали сигнала',
  };
}

function overallVerdict(results, items) {
  const required = results.filter((r) => r.required);
  if (!required.length) return 'inconclusive';
  const satisfied = required.filter((r) => r.verdict === 'satisfied').length;
  const notMet = required.filter((r) => r.verdict === 'not_satisfied').length;
  const unknown = required.filter((r) => r.verdict === 'unknown').length;
  if (notMet && satisfied) return 'partial';
  if (notMet) return 'not_met';
  if (unknown) return 'inconclusive';
  return 'verified';
}

async function verify(input = {}, deps = {}) {
  const now = deps.now || Date.now;
  const ghFetch = deps.ghFetch || defaultGhFetch;
  const judgeImpl = deps.judge || defaultJudge;
  const principal = deps.principal !== undefined ? deps.principal : (process.env.USER_ID || '');
  const workspaceRoot = deps.workspaceRoot;
  const observedAt = new Date(now()).toISOString();

  const scope = normalizeScope(input.scope);
  const runChecks = input.run_checks === true;
  const budget = (input.budget && typeof input.budget === 'object') ? input.budget : {};
  const judgeAllowed = budget.judge !== false;

  // 1. Requirements are frozen before anything else — and before any model.
  const req = await resolveRequirements(input, { ghFetch });

  // 2. The target is pinned before any check runs.
  const targetInput = { ...(input.target && typeof input.target === 'object' ? input.target : {}) };
  if (!targetInput.workspace_ref && input.workspace_ref) targetInput.workspace_ref = input.workspace_ref;
  if (!targetInput.repo && input.repo) targetInput.repo = input.repo;
  const resolved = await resolveTarget({ ...targetInput, repo: targetInput.repo || input.repo, target: targetInput }, {
    ghFetch, prStatus: deps.prStatus, principal, workspaceRoot, now,
  });

  const limitations = [];
  const providedRefs = normalizeEvidenceRefs(input.evidence_refs);
  const budgetChecks = Number.isFinite(Number(budget.max_checks)) && Number(budget.max_checks) > 0 ? Number(budget.max_checks) : 40;
  const ctx = {
    repo: targetInput.repo || input.repo || (resolved.resolved ? resolved.target.repository_id : null),
    pinnedSha: resolved.resolved ? resolved.target.pinned_sha : null,
    prNumber: resolved.resolved && resolved.target.kind === 'pull' ? resolved.target.number : (targetInput.pr || null),
    codePath: resolved.resolved ? resolved.target.workspace_path || null : null,
    workspaceRoot,
    ghFetch,
    runChecks,
    scope,
    budgetChecks,
  };

  const provided = resolved.resolved ? classifyProvidedEvidence(providedRefs, ctx.pinnedSha) : { fresh: [], gaps: providedRefs.map((ref) => ({ code: 'TARGET_UNRESOLVED', ref, message: 'нет закреплённой ревизии — утверждения не проверяемы' })) };

  if (!resolved.resolved) {
    limitations.push(resolved.limitation);
    const results = req.items.map((item) => emptyResult(item, `цель не закреплена: ${resolved.limitation.code}`));
    return {
      tool: 'engineering_verify',
      verdict: 'inconclusive',
      scope,
      requirements: {
        count: req.items.length,
        required: req.items.filter((i) => i.required).length,
        ref: req.requirements_ref,
        revision: req.revision,
        source: req.source,
        hash: req.items && req.items.length ? hashOf(req) : null,
      },
      target: { resolved: false, ...resolved.limitation },
      results,
      gaps: provided.gaps,
      limitations,
      evidence: [],
      receipt: null,
      observed_at: observedAt,
    };
  }

  // 3. Deterministic checks, requirement by requirement.
  const ctxRun = { ...ctx };
  const results = [];
  for (const item of req.items) {
    if (!item.checks.length) {
      results.push(emptyResult(item, 'у требования нет детерминированных проверок — нужно суждение по смыслу', 'none'));
      continue;
    }
    const checkResults = await collectChecks(item, ctxRun);
    const agg = aggregateChecks(item, checkResults);
    results.push({
      id: item.id,
      text: item.text,
      required: item.required,
      verdict: agg.verdict,
      source: agg.source,
      checks: checkResults.map((c) => ({
        kind: c.kind,
        status: c.status,
        receipt_type: c.receipt ? c.receipt.type : null,
        evidence_ref: c.evidenceRef || null,
        reason_code: c.reason_code || null,
        message: c.message || null,
        observed_at: c.observed_at || null,
      })),
      evidence: agg.evidence,
      gaps: agg.gaps,
      reason: agg.reason,
    });
  }

  // 4. Semantic judge for everything still undecided — one call, read-only.
  const undecided = results.filter((r) => r.verdict === 'unknown');
  let judgeInfo = null;
  if (undecided.length) {
    if (!judgeAllowed) {
      judgeInfo = { available: false, reason: 'judge-unavailable:DISABLED_BY_BUDGET' };
      for (const r of undecided) r.reason = `${r.reason}; судья отключён бюджетом`;
    } else {
      const itemsById = new Map(req.items.map((i) => [i.id, i]));
      judgeInfo = await judgeImpl({
        items: undecided.map((r) => itemsById.get(r.id)).filter(Boolean),
        evidenceText: judgeEvidenceText(results, provided.fresh),
        targetText: `${ctx.repo || ''} @ ${ctx.pinnedSha}`,
        scope,
        fetchImpl: deps.fetchImpl,
        apiKey: deps.apiKey !== undefined ? deps.apiKey : null,
      });
      if (judgeInfo.available) {
        for (const r of undecided) {
          const j = judgeInfo.results && judgeInfo.results[r.id];
          if (!j) {
            r.reason = `${r.reason}; судья не ответил по этому требованию`;
            continue;
          }
          r.verdict = j.verdict;
          r.source = 'semantic';
          r.reason = j.rationale || j.verdict;
          r.judge = { model: judgeInfo.model };
        }
      }
    }
    if (judgeInfo && !judgeInfo.available) {
      limitations.push({ code: 'JUDGE_UNAVAILABLE', message: judgeInfo.reason });
      for (const r of undecided) if (r.verdict === 'unknown') r.reason = `${r.reason}; ${judgeInfo.reason}`;
    }
  }

  const verdict = overallVerdict(results, req.items);

  // 5. Receipt — the only write, into the caller's own store.
  const receipt = writeReceipt({
    input, req, resolved: resolved.target, results, verdict, scope, principal, workspaceRoot, observedAt, limitations, provided,
  });
  if (receipt && receipt.warning) limitations.push(receipt.warning);

  const gaps = [
    ...provided.gaps,
    ...results.flatMap((r) => (r.gaps || []).map((g) => ({ ...g, requirement: r.id }))),
    ...results.filter((r) => r.verdict === 'unknown').map((r) => ({ code: 'REQUIREMENT_UNKNOWN', requirement: r.id, message: r.reason })),
  ];

  return {
    tool: 'engineering_verify',
    verdict,
    scope,
    requirements: {
      count: req.items.length,
      required: req.items.filter((i) => i.required).length,
      ref: req.requirements_ref,
      revision: req.revision,
      source: req.source,
      hash: hashOf(req),
      // accepted wording is frozen: the judge never updates it
      frozen_before_judge: true,
    },
    target: {
      resolved: true,
      kind: resolved.target.kind,
      repository_id: resolved.target.repository_id || null,
      pinned_sha: resolved.target.pinned_sha,
      workspace_id: resolved.target.workspace_id || null,
      url: resolved.target.url || null,
      observed_at: resolved.target.observed_at,
      limits: resolved.target.limits || [],
    },
    results,
    gaps,
    limitations,
    evidence: [
      ...provided.fresh,
      ...results.flatMap((r) => (r.evidence || []).map((e) => ({ source: 'deterministic', ref: e, commit: ctx.pinnedSha }))),
    ],
    supported_checks: SUPPORTED_KINDS,
    judge: judgeInfo ? { available: judgeInfo.available, model: judgeInfo.model || null, reason: judgeInfo.reason || null } : { available: null, reason: 'не требовался' },
    receipt: receipt && receipt.record ? receipt.record : null,
    observed_at: observedAt,
  };
}

function hashOf(req) {
  return req.source_revision || null;
}

function writeReceipt({ req, resolved, results, verdict, scope, principal, workspaceRoot, observedAt, limitations }) {
  const pinned = resolved.pinned_sha || null;
  const change = {
    kind: resolved.kind === 'pull' ? 'pull' : resolved.kind === 'artifact' ? 'commit' : resolved.kind,
    number: resolved.number || null,
    sha: pinned,
    branch: resolved.branch || null,
    url: resolved.url || null,
  };
  const slot = pinned ? verificationSlot({
    workspaceRoot,
    principal,
    repositoryId: resolved.repository_id,
    kind: change.kind,
    change: { number: change.number, sha: change.sha, branch: change.branch, url: change.url },
  }) : null;

  if (!principal) {
    return { record: null, warning: { code: 'NO_PRINCIPAL', message: 'запись верификации не создана: профиль (USER_ID) не задан' } };
  }
  if (!slot || !slot.file) {
    return { record: null, warning: { code: 'NO_VERIFICATION_SLOT', message: 'запись верификации не создана: не удалось построить ключ изменения' } };
  }

  const verificationId = `vfy_${crypto.randomBytes(6).toString('hex')}`;
  const record = {
    schemaVersion: 1,
    verification_id: verificationId,
    principal,
    repositoryId: resolved.repository_id || null,
    changeKey: slot.changeKey,
    change,
    verdict: RECORD_VERDICT[verdict] || 'inconclusive',
    commit: pinned,
    requirements_ref: req.requirements_ref,
    requirements_revision: req.revision,
    requirements_hash: req.source_revision || null,
    scope,
    verified_at: observedAt,
    source: 'engineering_verify',
    results: results.map((r) => ({ id: r.id, verdict: r.verdict, source: r.source, required: r.required })),
    gaps_count: results.reduce((n, r) => n + (r.gaps || []).length, 0),
    limitations: limitations.map((l) => l.code),
    evidence: results.flatMap((r) => r.evidence || []),
  };

  try {
    store.writeJsonAtomic(slot.file, record);
    return {
      record: {
        written: true,
        verification_id: verificationId,
        file: slot.file,
        commit: pinned,
        requirements_revision: req.revision,
        change_key: slot.changeKey,
        verdict: record.verdict,
        verified_at: observedAt,
      },
    };
  } catch (e) {
    return { record: null, warning: { code: 'RECORD_WRITE_FAILED', message: `запись верификации не сохранена: ${e.message}` } };
  }
}

module.exports = { verify, overallVerdict, classifyProvidedEvidence, normalizeScope };
