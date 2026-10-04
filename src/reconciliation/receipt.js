'use strict';

// Honest-reading rules for a reconciliation receipt (contract: contracts/reconciliation-receipt.schema.json).
//
// Why a module and not just the schema (#135): the two facts this receipt exists to
// separate — "the code is delivered" and "the canonical baseline says so" — can only be
// checked against EACH OTHER, and cross-field contradictions cannot be expressed in JSON
// Schema. `applied` while one delta entry is not applied; `applied` while a conflict was
// recorded; `deployed` while delivery is unknown: each is structurally valid and
// semantically false. Those are the cases the old `archive` step could not state, so its
// single validator (`living_docs_updated_and_plan_closed`, absent from the agent's
// validator registry) could neither see nor block them.
//
// Pure: receipt (+ optional prior receipts) → { ok, violations, facts, summary }.
// No I/O, no printing, no exit code — scripts/check-reconciliation.js is the CLI.
//
// Deliberately NOT a gate. A report that lies is worse than no report, but a hard gate on
// unvalidated keys is what #106 was about (owner decision 2026-10-03: report first).

const CODE_DELIVERY_STATES = ['merged', 'delivered', 'unknown'];
const BASELINE_STATES = ['applied', 'pending', 'not_applicable', 'conflict'];
const DELTA_KINDS = ['ADDED', 'MODIFIED', 'REMOVED'];
const TARGET_KINDS = ['spec', 'contract', 'architecture', 'adr'];
// A behaviour change is what a user or another system can observe: it belongs in the
// specification or a contract. Boundaries, invariants and decisions belong in
// architecture/ADR — that split is the reason `target.kind` is not free-form (#135).
const BEHAVIOUR_TARGETS = ['spec', 'contract'];

const SHA_REF = /^(?:sha|commit):([0-9a-f]{7,40})$/i;

function violation(code, message, extra = {}) {
  return { code, message, ...extra };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function shaFromRefs(refs) {
  for (const ref of Array.isArray(refs) ? refs : []) {
    const m = SHA_REF.exec(str(ref));
    if (m) return m[1];
  }
  return null;
}

function requiredTopLevel(receipt) {
  const missing = [];
  for (const key of ['plan', 'requirements', 'code_delivery', 'baseline', 'delta']) {
    const v = receipt && receipt[key];
    if (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) missing.push(key);
  }
  if (!Array.isArray(receipt && receipt.delta)) missing.push('delta');
  return [...new Set(missing)];
}

/**
 * @param {object} receipt
 * @param {{priorReceipts?: object[]}} [options] receipts already published for the plan,
 *        used to catch a replay that emits a second, different receipt for one step.
 */
function validate(receipt, options = {}) {
  const violations = [];
  const missingTop = requiredTopLevel(receipt);
  for (const key of missingTop) {
    violations.push(violation('RECEIPT_INCOMPLETE', `receipt is missing "${key}"`, { field: key }));
  }
  if (missingTop.length) return { ok: false, violations, facts: emptyFacts(), summary: summarizeReceipt(null) };

  const plan = receipt.plan || {};
  const requirements = receipt.requirements || {};
  const code = receipt.code_delivery || {};
  const baseline = receipt.baseline || {};
  const delta = Array.isArray(receipt.delta) ? receipt.delta : [];
  const missingReqs = Array.isArray(receipt.missing_requirements) ? receipt.missing_requirements : [];
  const followups = Array.isArray(receipt.followups) ? receipt.followups : [];
  const conflicts = Array.isArray(receipt.conflicts) ? receipt.conflicts : [];

  // --- identity: a receipt without a pinned (plan, step, requirements revision) cannot be re-checked
  for (const [field, value] of [['plan.plan_id', plan.plan_id], ['plan.step_id', plan.step_id], ['requirements.ref', requirements.ref], ['requirements.revision', requirements.revision]]) {
    if (!str(value)) violations.push(violation('RECEIPT_UNPINNED', `${field} is required: without it a later revision cannot invalidate this receipt`, { field }));
  }

  // --- FACT 1: code delivery, on its own evidence
  if (!CODE_DELIVERY_STATES.includes(code.state)) {
    violations.push(violation('CODE_DELIVERY_UNKNOWN_STATE', `code_delivery.state "${code.state}" is not one of ${CODE_DELIVERY_STATES.join('/')}`, { field: 'code_delivery.state' }));
  }
  if (code.state === 'merged' || code.state === 'delivered') {
    if (!shaFromRefs(code.refs) && !str(code.note)) {
      violations.push(violation('DELIVERY_WITHOUT_REF', `code_delivery.state=${code.state} but no pr:/sha:/commit: ref and no note`, { field: 'code_delivery.refs' }));
    }
  }

  // --- FACT 2: baseline, never inferred from code delivery
  if (!BASELINE_STATES.includes(baseline.state)) {
    violations.push(violation('BASELINE_UNKNOWN_STATE', `baseline.state "${baseline.state}" is not one of ${BASELINE_STATES.join('/')}`, { field: 'baseline.state' }));
  }
  if (baseline.state === 'applied') {
    if (!str(baseline.commit)) {
      violations.push(violation('BASELINE_APPLIED_WITHOUT_COMMIT', 'baseline.state=applied without a baseline commit: "applied" is a claim about the canonical baseline, not about the code', { field: 'baseline.commit' }));
    }
    if (!Array.isArray(baseline.paths) || baseline.paths.length === 0) {
      violations.push(violation('BASELINE_APPLIED_WITHOUT_PATHS', 'baseline.state=applied without listing the canonical paths that were actually touched', { field: 'baseline.paths' }));
    }
    if (!str(baseline.sync_kind)) {
      violations.push(violation('BASELINE_APPLIED_WITHOUT_SYNC_KIND', 'baseline.state=applied without sync_kind (in_pr | followup_pr): how the docs were delivered is part of the fact', { field: 'baseline.sync_kind' }));
    }
    if (baseline.sync_kind === 'in_pr') {
      const codeSha = shaFromRefs(code.refs);
      if (!codeSha) {
        violations.push(violation('BASELINE_SYNC_UNVERIFIABLE', 'sync_kind=in_pr claims the docs rode the code PR, but code_delivery carries no sha:/commit: ref to compare against', { field: 'code_delivery.refs' }));
      } else if (str(baseline.commit) && str(baseline.commit).startsWith(codeSha)) {
        // prefix match is enough: a shortened sha in the receipt against a full one from GitHub
      } else if (str(baseline.commit) && str(baseline.commit) !== codeSha && !str(baseline.commit).startsWith(codeSha)) {
        violations.push(violation('BASELINE_NOT_IN_CODE_PR', `sync_kind=in_pr but baseline.commit=${baseline.commit} is not the delivered code commit ${codeSha}`, { field: 'baseline.commit' }));
      }
    }
    if (conflicts.length) {
      violations.push(violation('CONFLICT_REPORTED_AS_APPLIED', `baseline.state=applied while ${conflicts.length} conflict(s) are recorded: a conflict is reported, never overwritten`, { field: 'conflicts' }));
    }
    if (missingReqs.length) {
      violations.push(violation('BASELINE_APPLIED_WITH_MISSING_REQUIREMENTS', `baseline.state=applied while ${missingReqs.length} accepted requirement(s) are still missing from the baseline`, { field: 'missing_requirements' }));
    }
  }
  if (baseline.state === 'pending' && !str(baseline.reason)) {
    violations.push(violation('BASELINE_PENDING_WITHOUT_REASON', 'baseline.state=pending without a reason: "delivered code, docs still pending" must say what is left', { field: 'baseline.reason' }));
  }
  if (baseline.state === 'not_applicable' && !str(baseline.reason)) {
    violations.push(violation('NOT_APPLICABLE_WITHOUT_REASON', 'baseline.state=not_applicable without a reason: an empty form is not a decision', { field: 'baseline.reason' }));
  }
  if (baseline.state === 'conflict' && !conflicts.length) {
    violations.push(violation('CONFLICT_WITHOUT_DETAIL', 'baseline.state=conflict but conflicts[] is empty: which path, with which commit', { field: 'conflicts' }));
  }
  for (const c of conflicts) {
    if (!str(c && c.path) || !str(c && c.with)) {
      violations.push(violation('CONFLICT_WITHOUT_DETAIL', 'every conflict needs path and with (commit/branch/PR)', { field: 'conflicts' }));
      break;
    }
  }

  // --- delta: per-requirement refs, evidence, and the behaviour→spec / boundary→architecture split
  const seenRequirements = new Set();
  for (const [i, entry] of delta.entries()) {
    const at = { index: i, requirement_id: str(entry && entry.requirement_id) || null };
    if (!DELTA_KINDS.includes(entry && entry.kind)) {
      violations.push(violation('DELTA_UNKNOWN_KIND', `delta[${i}].kind "${entry && entry.kind}" is not one of ${DELTA_KINDS.join('/')}`, at));
    }
    if (!str(entry && entry.requirement_id) || !str(entry && entry.requirement_ref)) {
      violations.push(violation('DELTA_WITHOUT_REQUIREMENT_REF', `delta[${i}] has no requirement_id/requirement_ref: an unreferenced requirement is the as-built story that drifts`, at));
    } else if (seenRequirements.has(str(entry.requirement_id))) {
      violations.push(violation('DUPLICATE_REQUIREMENT_IN_DELTA', `requirement "${entry.requirement_id}" appears twice in the delta: one requirement, one entry`, at));
    } else {
      seenRequirements.add(str(entry.requirement_id));
    }
    if (!Array.isArray(entry && entry.evidence_refs) || entry.evidence_refs.length === 0) {
      violations.push(violation('DELTA_WITHOUT_EVIDENCE', `delta[${i}] has no evidence_refs: the existence of a file is not proof that this delta was applied`, at));
    }
    const target = (entry && entry.target) || {};
    if (!TARGET_KINDS.includes(target.kind) || !str(target.path)) {
      violations.push(violation('DELTA_WITHOUT_CANONICAL_TARGET', `delta[${i}].target needs kind (${TARGET_KINDS.join('/')}) and path`, at));
    }
    if (entry && entry.behavior_change === true && !BEHAVIOUR_TARGETS.includes(target.kind)) {
      violations.push(violation('BEHAVIOUR_CHANGE_ONLY_IN_ARCHITECTURE', `delta[${i}] is a behaviour change but lands in ${target.kind}: behaviour goes to spec/contract, boundaries and invariants to architecture/ADR`, at));
    }
    if (entry && entry.kind === 'REMOVED' && !str(entry.superseded_by) && !str(entry.removal_evidence)) {
      violations.push(violation('REMOVED_WITHOUT_PROOF', `delta[${i}] removes a rule without superseded_by or removal_evidence: "removed" must be verifiable, not asserted`, at));
    }
    if (entry && entry.applied === false && entry.deferred === true) {
      const tracked = followups.some(f => str(f && f.ref) && (str(f.ref).includes(str(entry.requirement_id)) || str(f.why).includes(str(entry.requirement_id))))
        || missingReqs.some(m => str(m && m.requirement_id) === str(entry.requirement_id));
      if (!tracked) {
        violations.push(violation('DEFERRED_AS_DONE', `delta[${i}] is deferred and not applied, but no followup/missing-requirement records it: a documented defer must not read as completed`, at));
      }
    }
    if (entry && entry.source && entry.source.deployed === true && code.state === 'unknown') {
      violations.push(violation('DEPLOYED_WITHOUT_DELIVERY', `delta[${i}] claims source.deployed=true while code_delivery.state=unknown`, at));
    }
    if (baseline.state === 'applied' && entry && entry.applied === true && str(target.path) && Array.isArray(baseline.paths)) {
      if (!baseline.paths.map(str).includes(str(target.path))) {
        violations.push(violation('DELTA_APPLIED_OUTSIDE_BASELINE', `delta[${i}] target ${target.path} is not among the baseline paths actually touched`, at));
      }
    }
  }

  for (const m of missingReqs) {
    if (!str(m && m.requirement_id) || !str(m && m.reason)) {
      violations.push(violation('MISSING_REQUIREMENT_UNTRACKED', 'every missing requirement needs an id and a reason', { field: 'missing_requirements' }));
      break;
    }
  }
  for (const f of followups) {
    if (!str(f && f.ref) || !str(f && f.why)) {
      violations.push(violation('FOLLOWUP_WITHOUT_REF', 'every followup needs a ref (issue/doc path) and a why: a followup without a ref is a wish', { field: 'followups' }));
      break;
    }
  }

  // --- replay: one step, one receipt. A repeat must not produce a second PR or duplicated requirements.
  const priors = Array.isArray(options.priorReceipts) ? options.priorReceipts : [];
  for (const prior of priors) {
    if (!prior || !prior.plan || prior.plan.plan_id !== plan.plan_id || prior.plan.step_id !== plan.step_id) continue;
    const sameRequirements = str(prior.requirements && prior.requirements.revision) === str(requirements.revision);
    if (!sameRequirements) {
      violations.push(violation('REPLAY_CHANGED_REQUIREMENTS', `step ${plan.step_id} already published a receipt for requirements revision "${prior.requirements && prior.requirements.revision}" — a replay must not quietly re-reconcile against a newer revision`, { field: 'requirements.revision' }));
    }
  }

  const facts = {
    requirements: `${requirements.ref}@${requirements.revision}`,
    code_delivery: code.state,
    baseline: baseline.state,
    delta_total: delta.length,
    delta_applied: delta.filter(d => d && d.applied === true).length,
    delta_deferred: delta.filter(d => d && d.deferred === true).length,
    missing_requirements: missingReqs.length,
    followups: followups.length,
    conflicts: conflicts.length,
    baseline_paths: Array.isArray(baseline.paths) ? baseline.paths.length : 0,
  };
  return { ok: violations.length === 0, violations, facts, summary: summarizeReceipt(facts) };
}

function emptyFacts() {
  return {
    requirements: null, code_delivery: null, baseline: null, delta_total: 0, delta_applied: 0,
    delta_deferred: 0, missing_requirements: 0, followups: 0, conflicts: 0, baseline_paths: 0,
  };
}

function summarizeReceipt(facts) {
  if (!facts) return 'receipt: incomplete';
  return `code=${facts.code_delivery || '?'} baseline=${facts.baseline || '?'} delta=${facts.delta_total}(applied ${facts.delta_applied}, deferred ${facts.delta_deferred}) ` +
    `missing=${facts.missing_requirements} conflicts=${facts.conflicts} followups=${facts.followups} reqs=${facts.requirements || 'unpinned'}`;
}

module.exports = { validate, summarizeReceipt, CODE_DELIVERY_STATES, BASELINE_STATES, DELTA_KINDS, TARGET_KINDS };