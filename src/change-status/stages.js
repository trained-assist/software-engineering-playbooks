'use strict';

// Six independent facts about one change (#112).
//
// This file is PURE: it turns collected facts into stage verdicts and never
// touches the network, git or disk. That is deliberate — «написано», «закоммичено»,
// «запушено», «смержено», «доставлено», «проверено» must be decidable from a
// facts snapshot, so the contract can be tested deterministically and a bug in
// one collector can never quietly change a verdict.
//
// Load-bearing rules:
//   - a stage is only ever satisfied/not_satisfied/unknown/not_applicable.
//     Nothing is rounded up to «готово» because an earlier stage looks fine.
//   - `unknown` is a first-class answer, not a failure: an unreachable CI or an
//     unreachable production endpoint must never read as «not done».
//   - `not_applicable` is reserved for a change that genuinely has no Git
//     context (an external document delivered without a repository). A workspace
//     we cannot reach is `unknown`, NOT `not_applicable` — the absence of a
//     workspace is not proof of an absent change (#112).
//   - the delivered verdict only ever comes from a health-compare; a green
//     deploy job is evidence attached to `unknown`, never a verdict (⚫ R9).
//   - verification is bound to (requirements revision, commit). A new revision
//     turns a previous `verified` into `not_satisfied: stale`, not into
//     `unknown` — the record exists, it just no longer applies.

const STAGE_ORDER = ['written', 'committed', 'pushed', 'merged', 'delivered', 'verified'];

const STATUSES = ['satisfied', 'not_satisfied', 'unknown', 'not_applicable'];

const NEXT_ACTION = {
  written: 'Написать изменения в рабочем дереве рабочей области (или указать workspace_ref, где они уже есть)',
  committed: 'Закоммитить незакоммиченные изменения в своей ветке',
  pushed: 'Запушить ветку в origin — коммиты пока только локальные',
  merged: 'Открыть PR и смержить его в дефолтную ветку (сам инструмент не коммитит, не пушит и не мёржит)',
  delivered: 'Дождаться деплоя и проверить, что доставленная ревизия действительно в проде',
  verified: 'Проверить результат против принятых требований (инструмент engineering_verify) и записать вердикт',
};

function stage(name, status, reason, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`bad stage status "${status}" for ${name}`);
  return {
    stage: name,
    status,
    reason,
    refs: extra.refs || [],
    revision: extra.revision === undefined ? null : extra.revision,
    evidence: extra.evidence || [],
    observed_at: extra.observed_at || null,
  };
}

// ── git stages ───────────────────────────────────────────────────────────────

function gitUnavailable(facts, observedAt, why) {
  const reason = facts.git.available === false
    ? 'изменение без Git-контекста: ' + why
    : why;
  return {
    written: stage('written', facts.git.available === false ? 'not_applicable' : 'unknown', reason, { observed_at: observedAt }),
    committed: stage('committed', facts.git.available === false ? 'not_applicable' : 'unknown', reason, { observed_at: observedAt }),
    pushed: stage('pushed', facts.git.available === false ? 'not_applicable' : 'unknown', reason, { observed_at: observedAt }),
  };
}

function writtenStage(facts, observedAt) {
  const { git } = facts;
  if (git.available !== true) return null;
  const dirtyFiles = (git.dirty && git.dirty.files) || 0;
  const ahead = git.commits_ahead === null || git.commits_ahead === undefined ? null : Number(git.commits_ahead);

  // «Написано» = изменение материально существует. Four independent proofs,
  // because the obvious one («ветка впереди базы») goes away the moment the
  // work is pushed or merged — and a merged change is obviously written.
  const upstreamSynced = ahead === 0 && Boolean(git.upstream_sha) && git.upstream_sha === git.head_sha;
  const remoteKnown = Boolean(facts.remote && facts.remote.known);
  const refs = [];
  if (dirtyFiles > 0) refs.push(`uncommitted:${dirtyFiles}`);
  if (ahead > 0) refs.push(`commits-ahead:${ahead}`);
  if (remoteKnown && facts.remote.ref) refs.push(`remote:${facts.remote.ref}`);

  if (dirtyFiles > 0) {
    return stage('written', 'satisfied',
      `изменения есть в рабочем дереве (${dirtyFiles} файл.)`,
      { observed_at: observedAt, revision: git.head_sha || null, refs, evidence: dirtyEvidence(git) });
  }
  if (ahead !== null && ahead > 0) {
    return stage('written', 'satisfied',
      `ветка содержит ${ahead} коммит(ов) относительно базы`,
      { observed_at: observedAt, revision: git.head_sha || null, refs, evidence: dirtyEvidence(git) });
  }
  if (upstreamSynced || remoteKnown) {
    const why = remoteKnown
      ? `изменение известно на GitHub (${facts.remote.ref || 'ветка/PR'}), рабочее дерево чистое`
      : `ветка синхронизирована с ${git.upstream}, рабочее дерево чистое`;
    return stage('written', 'satisfied', why,
      { observed_at: observedAt, revision: git.head_sha || null, refs });
  }
  return stage('written', 'not_satisfied',
    `в рабочем дереве нет изменений и ветка ${git.branch || '(без ветки)'} не содержит коммитов относительно базы`,
    { observed_at: observedAt, revision: git.head_sha || null });
}

function dirtyEvidence(git) {
  const ev = [];
  const dirty = git.dirty || {};
  for (const t of (dirty.tracked || []).slice(0, 20)) ev.push({ source: 'git-status', detail: `${t.code} ${t.file}` });
  for (const u of (dirty.untracked || []).slice(0, 20)) ev.push({ source: 'git-status', detail: `?? ${u}` });
  return ev;
}

function committedStage(facts, observedAt, written) {
  const { git } = facts;
  if (git.available !== true) return null;
  const dirtyFiles = (git.dirty && git.dirty.files) || 0;
  const ahead = git.commits_ahead === null || git.commits_ahead === undefined ? null : Number(git.commits_ahead);

  if (dirtyFiles > 0) {
    return stage('committed', 'not_satisfied',
      `незакоммиченные изменения: ${dirtyFiles} файл. (committed считается по чистому дереву)`,
      { observed_at: observedAt, revision: git.head_sha || null, refs: [`uncommitted:${dirtyFiles}`], evidence: dirtyEvidence(git) });
  }
  if (!git.head_sha) {
    return stage('committed', 'unknown', 'HEAD неизвестен — commits нельзя подтвердить', { observed_at: observedAt });
  }
  if (ahead === 0) {
    const merged = facts.pr && facts.pr.merged;
    return stage('committed', 'satisfied',
      merged
        ? 'рабочее дерево чистое, изменения закоммичены и уже смержены'
        : 'рабочее дерево чистое, незакоммиченных изменений нет',
      { observed_at: observedAt, revision: git.head_sha, refs: [`commit:${git.head_sha}`] });
  }
  if (ahead === null) {
    return stage('committed', 'satisfied',
      'рабочее дерево чистое — изменения в коммитах; число коммитов относительно базы неизвестно (нет upstream)',
      { observed_at: observedAt, revision: git.head_sha, refs: [`commit:${git.head_sha}`] });
  }
  return stage('committed', 'satisfied',
    `${ahead} коммит(ов) относительно базы, дерево чистое`,
    { observed_at: observedAt, revision: git.head_sha, refs: [`commit:${git.head_sha}`] });
}

function pushedStage(facts, observedAt) {
  const { git } = facts;
  if (git.available !== true) return null;
  const ahead = git.commits_ahead === null || git.commits_ahead === undefined ? null : Number(git.commits_ahead);

  if (ahead !== null && ahead > 0) {
    const base = git.upstream || git.comparison_base || 'удалённой ветке';
    const why = git.upstream
      ? `${ahead} коммит(ов) только локально — их нет в ${base}`
      : `${ahead} коммит(ов) только локально — ветка не отслеживает удалённую, и этих коммитов нет в ${base}`;
    return stage('pushed', 'not_satisfied', why,
      { observed_at: observedAt, revision: git.head_sha || null, refs: [`local-only:${ahead}`], evidence: (git.ahead_shas || []).map(sha => ({ source: 'git-rev-list', detail: sha })) });
  }
  if (ahead === 0) {
    return stage('pushed', 'satisfied',
      `ветка синхронизирована с ${git.upstream || 'upstream'}`,
      { observed_at: observedAt, revision: git.upstream_sha || git.head_sha || null, refs: git.upstream ? [`upstream:${git.upstream}`] : [] });
  }
  // No upstream to compare with: the GitHub side may still prove the head is there.
  const pr = facts.pr;
  if (pr && pr.head_sha && git.head_sha && pr.head_sha === git.head_sha) {
    return stage('pushed', 'satisfied',
      'HEAD совпадает с head PR на GitHub — коммит на удалённом репозитории',
      { observed_at: observedAt, revision: git.head_sha, refs: [`pr:${pr.number}`] });
  }
  return stage('pushed', 'unknown',
    'нет upstream-ветки, с которой можно сравнить: нельзя отличить «не пушили» от «ветка без трекинга»',
    { observed_at: observedAt, revision: git.head_sha || null });
}

// ── merged ───────────────────────────────────────────────────────────────────

function mergedStage(facts, observedAt) {
  const pr = facts.pr;
  if (pr) {
    const refs = [`pr:${pr.number}`];
    if (pr.url) refs.push(pr.url);
    if (pr.merged && pr.merge_commit_sha) {
      return stage('merged', 'satisfied',
        `PR #${pr.number} смержен ${pr.merged_at}`,
        { observed_at: observedAt, revision: pr.merge_commit_sha, refs });
    }
    if (pr.merged) {
      return stage('merged', 'satisfied',
        `PR #${pr.number} смержен, но merge_commit_sha неизвестен`,
        { observed_at: observedAt, refs });
    }
    if (pr.state === 'closed') {
      return stage('merged', 'not_satisfied', `PR #${pr.number} закрыт без мержа`, { observed_at: observedAt, refs });
    }
    return stage('merged', 'not_satisfied',
      `PR #${pr.number} открыт${pr.draft ? ' (черновик)' : ''}, не смержен`,
      { observed_at: observedAt, refs });
  }

  if (facts.git && facts.git.available === true && facts.git.merged_into_default !== null && facts.git.merged_into_default !== undefined) {
    // When the caller passed a task label instead of a ref, this branch is the
    // workspace's branch — an inference, and the reason says so.
    const via = facts.change && facts.change.kind === 'task' ? 'ветке рабочей области' : 'ветке';
    if (facts.git.merged_into_default) {
      return stage('merged', 'satisfied',
        `содержимое ${via} ${facts.git.branch} уже входит в ${facts.git.default_branch || 'дефолтную ветку'} (PR не найден)`,
        { observed_at: observedAt, revision: facts.git.default_head_sha || null, refs: [`branch:${facts.git.branch}`] });
    }
    return stage('merged', 'not_satisfied',
      `${via} ${facts.git.branch} не входит в ${facts.git.default_branch || 'дефолтную ветку'}, PR не найден`,
      { observed_at: observedAt, refs: [`branch:${facts.git.branch}`] });
  }

  return stage('merged', 'unknown',
    'нет ни PR, ни проверки «содержимое ветки в дефолтной» — mergе нельзя ни подтвердить, ни опровергнуть',
    { observed_at: observedAt });
}

// ── delivered ────────────────────────────────────────────────────────────────

function deliveredStage(facts, observedAt) {
  const d = facts.delivered || { verdict: 'unknown' };
  const refs = [];
  if (d.merge_commit) refs.push(`commit:${d.merge_commit}`);
  if (d.health_commit) refs.push(`health:${d.health_commit}`);
  if (d.deploy_run) refs.push(d.deploy_run);
  const evidence = [];
  if (d.source) evidence.push({ source: d.source, detail: d.compare || d.evidence || d.note || '' });

  if (d.verdict === 'live') {
    return stage('delivered', 'satisfied',
      `доставлено: прода отдаёт ревизию ${d.health_commit} (health-compare, ${d.compare})`,
      { observed_at: observedAt, revision: d.health_commit || d.merge_commit || null, refs, evidence });
  }
  if (d.verdict === 'not_yet') {
    return stage('delivered', 'not_satisfied',
      `мерж есть, но прода отдаёт ${d.health_commit} — ${d.compare}`,
      { observed_at: observedAt, revision: d.health_commit || null, refs, evidence });
  }
  const note = d.note || d.evidence || 'прод-эндпоинт недоступен';
  const extra = d.deploy_run
    ? `; зелёный deploy-джоб ${d.deploy_run} — это свидетельство, а не доказательство (верифицирует только health-compare)`
    : '';
  return stage('delivered', 'unknown',
    `доставку подтвердить нельзя: ${note}${extra}`,
    { observed_at: observedAt, refs, evidence });
}

// ── verified ─────────────────────────────────────────────────────────────────

function verifiedStage(facts, observedAt, deliveredRevision) {
  const v = facts.verification || {};
  const requirementsRef = v.requirements_ref || null;

  if (!v.found) {
    return stage('verified', 'unknown',
      'записи о верификации нет — проверенность не подтверждена ничем (её пишет engineering_verify)',
      { observed_at: observedAt, refs: requirementsRef ? [`requirements:${requirementsRef}`] : [] });
  }

  const rec = v.record || {};
  const recordCommit = rec.commit || null;
  const refs = [];
  if (rec.verification_id) refs.push(`verification:${rec.verification_id}`);
  if (recordCommit) refs.push(`commit:${recordCommit}`);
  if (rec.requirements_revision) refs.push(`requirements:${rec.requirements_revision}`);
  if (v.source) refs.push(`${v.source}:${v.key || ''}`.replace(/:$/, ''));

  const stale = [];
  if (recordCommit && deliveredRevision && recordCommit !== deliveredRevision) {
    stale.push(`запись относится к ревизии ${recordCommit}, а доставлена ${deliveredRevision}`);
  }
  if (requirementsRef && rec.requirements_revision && rec.requirements_revision !== requirementsRef) {
    stale.push(`требования изменились: в записи ${rec.requirements_revision}, запрошены ${requirementsRef}`);
  }
  if (!recordCommit && requirementsRef) {
    stale.push('запись не привязана к ревизии требований — проверить её актуальность нельзя');
  }

  if (stale.length) {
    return stage('verified', 'not_satisfied',
      `прежняя верификация устарела: ${stale.join('; ')}`,
      { observed_at: observedAt, revision: recordCommit, refs, evidence: [{ source: 'verification-record', detail: rec.verified_at ? `verified_at=${rec.verified_at}` : 'verified_at неизвестен' }] });
  }

  // A record exists, but engineering_verify said the requirements are NOT met
  // (partial / not_met / inconclusive). That is the opposite of «verified» —
  // the stage must not read it as satisfied (#113: per-REQ traceability, a
  // single record never collapses into an optimistic word).
  if (rec.verdict && rec.verdict !== 'pass') {
    return stage('verified', 'not_satisfied',
      `запись верификации есть, но её вердикт — ${rec.verdict}: проверенность не подтверждена`,
      { observed_at: observedAt, revision: recordCommit, refs, evidence: [{ source: 'verification-record', detail: `verdict=${rec.verdict}${rec.verified_at ? `, verified_at=${rec.verified_at}` : ''}` }] });
  }

  return stage('verified', 'satisfied',
    'есть запись верификации, привязанная к этой ревизии и к этим требованиям',
    { observed_at: observedAt, revision: recordCommit, refs, evidence: [{ source: 'verification-record', detail: rec.verified_at ? `verified_at=${rec.verified_at}` : '' }] });
}

// ── assembly ─────────────────────────────────────────────────────────────────

function evaluateStages(facts, { observedAt } = {}) {
  const at = observedAt || new Date(0).toISOString();

  const written = writtenStage(facts, at);
  const stages = {};

  if (written) {
    stages.written = written;
    stages.committed = committedStage(facts, at) || written;
    stages.pushed = pushedStage(facts, at) || written;
  } else {
    Object.assign(stages, gitUnavailable(facts, at, facts.git.reason || 'рабочая область не найдена'));
  }

  stages.merged = mergedStage(facts, at);
  stages.delivered = deliveredStage(facts, at);

  // «verified» is judged against the revision that is actually delivered, so a
  // re-deploy without a re-verify cannot look verified.
  const deliveredRevision = stages.delivered.revision
    || (facts.pr && facts.pr.merge_commit_sha)
    || (facts.git && facts.git.head_sha)
    || null;
  stages.verified = verifiedStage(facts, at, deliveredRevision);

  const ordered = {};
  for (const name of STAGE_ORDER) ordered[name] = stages[name];
  return ordered;
}

function nextMissingActions(stages) {
  const out = [];
  let first = true;
  for (const name of STAGE_ORDER) {
    const s = stages[name];
    if (!s || s.status !== 'not_satisfied') continue;
    out.push({
      stage: name,
      action: NEXT_ACTION[name] || `проверить стадию ${name}`,
      next: first,
      why: s.reason,
    });
    first = false;
  }
  return out;
}

function summarize(stages) {
  const counts = { satisfied: 0, not_satisfied: 0, unknown: 0, not_applicable: 0 };
  for (const name of STAGE_ORDER) {
    const s = stages[name];
    if (s && counts[s.status] !== undefined) counts[s.status]++;
  }
  const blocking = STAGE_ORDER.find(n => stages[n] && stages[n].status === 'not_satisfied');
  return {
    counts,
    first_missing_stage: blocking || null,
    // A single verdict is deliberately NOT produced: six facts that can be
    // unknown must not collapse into one optimistic word.
    verdict: blocking ? 'incomplete' : (counts.unknown ? 'incomplete_unknown' : 'complete'),
  };
}

module.exports = { STAGE_ORDER, STATUSES, NEXT_ACTION, evaluateStages, nextMissingActions, summarize, stage };