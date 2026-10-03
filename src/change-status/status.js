'use strict';

// engineering_change_status (#112) — six independent facts about one change:
// written, committed, pushed, merged, delivered, verified.
//
// The whole point of this tool is that it does NOT collapse them. «Фича готова»
// is not a conclusion this method is allowed to reach: each stage answers
// satisfied / not_satisfied / unknown / not_applicable with its own refs,
// revision and observed_at, and the answer ends with what is missing next —
// as a recommendation, never as an action (#112: read-only, no auto-commit /
// push / merge).
//
// Order of collection and its consequences:
//   1. access probe on the repository — if the repo cannot be read, the call
//      fails honestly instead of reporting six `unknown`s that look like a
//      quiet, healthy absence;
//   2. local read-only git facts (src/change-status/local.js) — these may be
//      unavailable, and that is reported as unknown, never as not_satisfied;
//   3. GitHub facts (src/change-status/github.js) — PR / branch / commit /
//      issue, reusing pr_status (#52) instead of a second GitHub client;
//   4. verification record (src/change-status/verification.js) — read-only;
//      engineering_verify (#113) writes them;
//   5. pure stage evaluation (src/change-status/stages.js).
//
// A change without Git is legal: point workspace_ref at a directory that is not
// a repository and the three git stages become not_applicable while delivered
// and verified are still judged.

const { ghFetch: defaultGhFetch } = require('../github/client');
const { prStatus, issueStatus, prodVerdict } = require('../github/pr-status-core');
const { parseTaskRef, normTask } = require('../change-find/refs');
const { normalizeRepo } = require('../change-find/find');
const local = require('./local');
const gh = require('./github');
const verification = require('./verification');
const { evaluateStages, nextMissingActions, summarize, STAGE_ORDER } = require('./stages');

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The change_ref may itself carry the repository (a GitHub URL) — that wins over
// a separately passed repo only when the caller did not state one explicitly.
function resolveIdentity(input) {
  const parsed = parseTaskRef(typeof input.change_ref === 'string' ? input.change_ref : '');
  const urlPull = parsed.urls.find(u => u.kind === 'pull');
  const urlIssue = parsed.urls.find(u => u.kind === 'issue');
  const urlCommit = parsed.urls.find(u => u.kind === 'commit');
  const urlBranch = parsed.urls.find(u => u.kind === 'branch');

  const number = (urlPull && urlPull.number)
    || (urlIssue && urlIssue.number)
    || (parsed.numbers[0] && parsed.numbers[0].number)
    || null;

  // `#115` is genuinely ambiguous — GitHub numbers issues and PRs in one
  // sequence — so it gets its own kind and is resolved by asking GitHub, not by
  // guessing. A label with no ref at all is a task: it can still answer the
  // workspace stages and reports the Git-dependent ones as unknown.
  const kind = urlPull || parsed.numbers.some(n => n.via === 'pr')
    ? 'pull'
    : urlIssue
      ? 'issue'
      : urlCommit || parsed.commits.length
        ? 'commit'
        : urlBranch || parsed.branches.length
          ? 'branch'
          : number
            ? 'number'
            : 'task';

  let repoFromRef = null;
  for (const u of parsed.urls) if (!repoFromRef) repoFromRef = u.repo;
  const repo = input.repo ? normalizeRepo(input.repo) : (repoFromRef ? normalizeRepo(repoFromRef) : null);

  return {
    parsed,
    repo,
    repo_from_ref: repoFromRef,
    kind,
    number,
    sha: urlCommit ? urlCommit.sha : (parsed.commits[0] || null),
    branch: urlBranch ? urlBranch.name : (parsed.branches[0] || null),
    url: (urlPull && urlPull.url) || (urlIssue && urlIssue.url) || null,
    raw: parsed.raw,
  };
}

async function changeStatus(input = {}, deps = {}) {
  const now = deps.now || Date.now;
  const ghFetch = deps.ghFetch || defaultGhFetch;
  const prStatusImpl = deps.prStatus || prStatus;
  const issueStatusImpl = deps.issueStatus || issueStatus;
  const prodVerdictImpl = deps.prodVerdict || prodVerdict;
  const principal = deps.principal !== undefined ? deps.principal : (process.env.USER_ID || '');
  const workspaceRoot = deps.workspaceRoot;

  const changeRef = typeof input.change_ref === 'string' ? input.change_ref.trim() : '';
  let taskLabelOnly = false;
  if (!changeRef && !input.workspace_ref) {
    throw fail('INVALID_CHANGE_REF', 'change_ref is required — PR/branch/commit/issue, её URL или номер, напр. «#115» или «branch eng/x»');
  }

  const id = resolveIdentity({ ...input, change_ref: changeRef || `workspace:${input.workspace_ref}` });
  const repo = id.repo;
  if (!repo) {
    throw fail('INVALID_REPO', 'repo is required, когда change_ref не содержит GitHub-ссылку: передай repo="owner/name"');
  }
  if (id.kind === 'task' && !input.workspace_ref) {
    // A task label alone resolves no PR, branch or commit. That is not an
    // error — it is the «we don't know where this landed» case, and the caller
    // should see unknown on the Git stages, not a refusal.
    taskLabelOnly = true;
  }

  const observedAt = new Date(now()).toISOString();
  const sources = [];

  // 1. access probe — an unreadable repository is an error, not six unknowns.
  const probe = deps.skipAccessProbe
    ? { ok: true, identity: { default_branch: 'main' } }
    : await gh.accessProbe(repo, ghFetch);
  if (!probe.ok) {
    return {
      ok: false,
      repo,
      change: { ref: changeRef || null, kind: id.kind, number: id.number, sha: id.sha, branch: id.branch, url: id.url },
      error: {
        code: probe.error.code,
        message: probe.error.message,
        hint: probe.error.code === 'GITHUB_AUTH'
          ? 'нет доступа к GitHub — это не «изменений нет», доступ не выдан или токен протух'
          : 'репозиторий не найден или нет доступа к нему',
      },
      sources: [{ name: 'github', ok: false, operation: 'read', detail: probe.error.code }],
      observed_at: observedAt,
    };
  }
  const defaultBranch = probe.identity.default_branch || 'main';
  sources.push({ name: 'github', ok: true, operation: 'read', detail: `repo=${probe.identity.full_name || repo}, default=${defaultBranch}` });

  // 2. local read-only git facts.
  const localFacts = local.localFacts({
    workspaceRef: input.workspace_ref,
    taskRef: changeRef || (id.kind === 'unknown' ? '' : changeRef),
    repo,
    principal,
    workspaceRoot,
  });
  if (localFacts.workspace.found) {
    sources.push({
      name: 'workspace-store',
      ok: true,
      operation: 'read',
      detail: `workspace=${localFacts.workspace.workspace_id || localFacts.workspace.code_path} (via ${localFacts.workspace.via}), git ${localFacts.git.available === true ? 'доступен' : localFacts.git.available === false ? 'неприменим' : 'неизвестен'}`,
    });
  } else {
    sources.push({ name: 'workspace-store', ok: true, operation: 'read', detail: `рабочая область не найдена: ${localFacts.workspace.reason}` });
  }

  // 3. GitHub facts.
  let pr = null;
  let prs = [];
  let delivered = { verdict: 'unknown', note: 'изменение не привязано к merge-коммиту — доставку подтвердить нечем' };
  let errors = [];

  let resolvedKind = id.kind;

  if ((id.kind === 'pull' || id.kind === 'number') && id.number) {
    const r = await gh.collectPr(repo, id.number, ghFetch, prStatusImpl, prodVerdictImpl);
    pr = r.pr; delivered = r.delivered;
    if (r.error) errors.push({ source: 'pr', ...r.error });
    // `#N` was ambiguous: GitHub answered, and the answer was «это issue».
    if (!pr && r.error && (r.error.code === 'NOT_A_PR' || r.error.code === 'NOT_FOUND')) {
      resolvedKind = 'issue';
      const asIssue = await gh.collectIssue(repo, id.number, issueStatusImpl, prStatusImpl, prodVerdictImpl);
      pr = asIssue.pr; prs = asIssue.prs || []; delivered = asIssue.delivered;
    }
  } else if (id.kind === 'issue' && id.number) {
    const r = await gh.collectIssue(repo, id.number, issueStatusImpl, prStatusImpl, prodVerdictImpl);
    pr = r.pr; prs = r.prs || []; delivered = r.delivered;
    if (r.error) errors.push({ source: 'issue', ...r.error });
  } else if (id.kind === 'branch' && id.branch) {
    const r = await gh.collectBranch(repo, id.branch, ghFetch, prStatusImpl, defaultBranch, prodVerdictImpl);
    pr = r.pr; prs = r.prs; delivered = r.delivered;
    errors = errors.concat(r.branch.errors || []);
    if (r.branch.merged_into_default !== null && r.branch.merged_into_default !== undefined) {
      localFacts.git.merged_into_default = r.branch.merged_into_default;
    }
    if (r.branch.default_branch) localFacts.git.default_branch = r.branch.default_branch;
    if (r.branch.default_head_sha) localFacts.git.default_head_sha = r.branch.default_head_sha;
    if (!pr && r.branch.head_sha) localFacts.git.head_sha = localFacts.git.head_sha || r.branch.head_sha;
  } else if (id.kind === 'commit' && id.sha) {
    const r = await gh.collectCommit(repo, id.sha, ghFetch, prStatusImpl, defaultBranch, prodVerdictImpl);
    pr = r.pr; prs = r.prs; delivered = r.delivered;
    errors = errors.concat(r.commit_ref.errors || []);
    if (r.commit_ref.merged_into_default !== null && r.commit_ref.merged_into_default !== undefined) {
      localFacts.git.merged_into_default = r.commit_ref.merged_into_default;
    }
    localFacts.git.default_branch = localFacts.git.default_branch || defaultBranch;
  }

  if (errors.length) {
    sources.push({ name: 'github-sections', ok: false, operation: 'read', detail: errors.map(e => `${e.source}:${e.code}`).join(', ') });
  } else {
    sources.push({ name: 'github-sections', ok: true, operation: 'read', detail: `${id.kind}${id.number ? ` #${id.number}` : ''}${id.branch ? ` ${id.branch}` : ''}${id.sha ? ` ${id.sha.slice(0, 8)}` : ''}` });
  }

  // 4. verification record (read-only; engineering_verify writes them).
  const requirementsRef = typeof input.requirements_ref === 'string' && input.requirements_ref.trim()
    ? input.requirements_ref.trim()
    : null;
  const vkey = verification.readVerification({
    workspaceRoot,
    principal,
    repositoryId: repo,
    kind: pr ? 'pull' : id.kind,
    change: {
      number: (pr && pr.number) || id.number,
      sha: (pr && pr.merge_commit_sha) || (pr && pr.head_sha) || id.sha,
      branch: (pr && pr.head_ref) || id.branch,
      url: (pr && pr.url) || id.url,
    },
    requirementsRef,
  });
  sources.push({
    name: 'verification-store',
    ok: true,
    operation: 'read',
    detail: vkey.found ? `запись ${vkey.key} (commit ${(vkey.record && vkey.record.commit) || '—'})` : (vkey.note || 'записи нет'),
  });

  // 5. pure evaluation.
  const remoteRef = pr ? `PR #${pr.number}` : (resolvedKind === 'commit' && id.sha ? `commit ${id.sha.slice(0, 8)}` : (id.branch ? `branch ${id.branch}` : null));
  const facts = {
    change: { kind: resolvedKind, number: id.number, sha: id.sha, branch: id.branch, url: id.url },
    remote: {
      // «The change exists on GitHub» — the fourth proof that «written» can be
      // satisfied without a dirty tree or a local commit.
      known: Boolean(pr) || remoteRef !== null,
      ref: remoteRef,
    },
    task_label_only: taskLabelOnly,
    workspace: localFacts.workspace,
    git: localFacts.git,
    pr,
    prs,
    delivered,
    verification: { ...vkey, requirements_ref: requirementsRef },
  };

  const stages = evaluateStages(facts, { observedAt });
  const summary = summarize(stages);

  return {
    ok: true,
    repo,
    change: {
      ref: changeRef || null,
      kind: id.kind,
      kind: resolvedKind,
      identity: resolvedKind === 'pull' ? `PR #${id.number}` : resolvedKind === 'issue' ? `issue #${id.number}` : resolvedKind === 'branch' ? `branch ${id.branch}` : resolvedKind === 'commit' ? `commit ${id.sha}` : (id.raw || 'task'),
      number: id.number,
      sha: id.sha,
      branch: id.branch,
      url: id.url || (id.kind === 'pull' && id.number ? `https://github.com/${repo}/pull/${id.number}` : null),
      repo_from_ref: id.repo_from_ref,
      requirements_ref: requirementsRef,
    },
    workspace: localFacts.workspace,
    stages,
    summary,
    next_missing_actions: nextMissingActions(stages),
    facts: {
      git: localFacts.git,
      pr,
      prs,
      delivery: delivered,
      verification: vkey.found
        ? { found: true, key: vkey.key, source: vkey.source, record: vkey.record }
        : { found: false, note: vkey.note || null },
      errors,
    },
    sources,
    freshness: { observed_at: observedAt },
    limitations: [
      'инструмент только читает: он не коммитит, не пушит, не мёржит и не деплоит — next_missing_actions это рекомендации',
      'нет рабочей области → written/committed/pushed = unknown, а не «изменений нет»: отсутствие workspace ничего не доказывает',
      'локальные git-факты читаются из локальных remote-tracking ссылок и могут отставать от GitHub; источник правды для merged/delivered — GitHub',
      'delivered подтверждается только сравнением с health прод-сервиса; зелёный deploy-джоб остаётся свидетельством, а не вердиктом',
      'verified читает запись, которую пишет engineering_verify (#113); без записи стадия = unknown, даже если CI зелёный',
      'стадии независимы: порядок не обязателен, внешний документ может быть доставлен без Git (тогда git-стадии not_applicable)',
      taskLabelOnly ? 'change_ref — метка задачи без PR/ветки/sha: merged/delivered = unknown, подскажите номер PR или ветку' : null,
    ].filter(Boolean),
  };
}

module.exports = { changeStatus, STAGE_ORDER, normTask };