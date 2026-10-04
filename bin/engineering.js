#!/usr/bin/env node
'use strict';

const path = require('path');
const { prepareTask } = require('../src/prepare-task');
const {
  spawnWorkspace,
  statusWorkspace,
  releaseWorkspace,
  reconcileWorkspaces,
  WorkspaceError,
} = require('../src/workspace');
const { rolloutAutofix, resolveGithubCapability } = require('../src/pr-autofix');
const { findRepos } = require('../src/repo-catalog');
const { repoStatus } = require('../src/repo-status');
const { changeFind, changeBind } = require('../src/change-find');
const { changeStatus } = require('../src/change-status');
const { verify } = require('../src/verify');
const { repoSearch } = require('../src/repo-search');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

const USAGE = [
  'Usage: trained-engineering <command> [options]',
  '',
  '  prepare-task --repo <path> --task <text> [--max-results 24] [--no-index]',
  '',
  '  repo-find --query <text> [--scope visible|org:<name>|user:<name>] [--limit 10]',
  '            [--cursor <n>] [--refresh] [--include-archived]',
  '',
  '  repo-status --repo <owner/name> [--prs 10] [--issues 10] [--refresh]',
  '',
  '  repo-search --repo <path> --query <text> [--strategy auto|keyword|dense|hybrid] [--limit 8]',
  '             [--include src/,docs/] [--include-stale] [--refresh] [--max-chunks <n>]',
  '',
  '  change-find --repo <owner/name> (--task-ref <text> | --query <text>)',
  '              [--known-refs <ref,ref>] [--since <date>] [--until <date>] [--limit 10]',
  '              [--principal <id>]',
  '  change-bind --repo <owner/name> --task-ref <text> --refs <"PR #1, branch x">',
  '              [--principal <id>]',
  '  change-status --change-ref <#115|branch eng/x|sha abc1234|URL> [--repo <owner/name>]',
  '                [--workspace-ref <ws-id|path>] [--requirements-ref <issue#112@3>]',
  '                [--principal <id>]',
  '',
  '  verify (--requirements <json-array> | --requirements-ref <issue#112|file:path>)',
  '         --target <json-object> [--repo <owner/name>] [--scope implementation|delivery|user_scenario]',
  '         [--evidence-refs <ref,ref>] [--run-checks] [--no-judge] [--max-checks <n>]',
  '         [--principal <id>] [--root <store-root>]',
  '',
  '  workspace-spawn --root <dir> --source-checkout <git-repo> --base-revision <sha>',
  '                  --principal <id> --host <id> --repo-id <id> --root-task-id <id> --idempotency-key <key>',
  '                  [--profile cli] [--allow-fetch]',
  '  workspace-status --root <dir> --workspace-id <id> [--principal <id>] [--root-task-id <id>] [--host <id>]',
  '  workspace-release --root <dir> --workspace-id <id> --principal <id> --root-task-id <id>',
  '                    [--host <id>] [--processes-stopped] [--force] [--delivery-merged]',
  '  workspace-reconcile --root <dir>',
  '',
  '  pr-autofix-rollout [--all] [--repo <owner/name>] [--repos <file>] [--ref <tag>]',
  '                     [--ci-workflow <name>] [--dry-run] [--no-cleanup] [--json]',
].join('\n');

const a = args(process.argv.slice(2));
const command = a._[0];

function boolFlag(value) {
  return value === undefined ? undefined : value !== 'false';
}

// Every repository appears with the reason it was skipped. A rollout that silently
// omits a repository is the adoption problem this command exists to remove.
function printRollout(result) {
  for (const row of result.report) {
    const detail = row.pr ? ` ${row.pr.url}` : '';
    const reason = row.reason ? ` — ${row.reason}` : '';
    process.stdout.write(`${row.repo}  ${row.status}${reason}${detail}\n`);
  }
  process.stdout.write(
    `\n${result.summary.pr_opened} PR(s) opened, ${result.summary.installed} already installed, `
    + `${result.summary.skipped} skipped (ref ${result.ref})\n`,
  );
}

function splitList(value) {
  if (value === undefined || value === null || value === true || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function collectRepos(a) {
  const repos = [];
  if (a.repo !== undefined && a.repo !== null && a.repo !== '') {
    for (const part of String(a.repo).split(',')) {
      const trimmed = part.trim();
      if (trimmed) repos.push(trimmed);
    }
  }
  if (a.repos !== undefined && a.repos !== null && a.repos !== '') {
    const raw = require('fs').readFileSync(String(a.repos), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) repos.push(trimmed);
    }
  }
  return repos;
}

async function main() {
  if (command === 'prepare-task') {
    const packet = prepareTask({
      repoPath: a.repo,
      task: a.task,
      preferIndex: !a['no-index'],
      maxResults: Number(a['max-results'] || 24),
    });
    print(packet);
  } else if (command === 'workspace-spawn') {
    print(spawnWorkspace({
      workspaceRoot: a.root,
      sourceCheckout: a['source-checkout'],
      baseRevision: a['base-revision'],
      principal: a.principal,
      hostId: a.host,
      repositoryId: a['repo-id'],
      rootTaskId: a['root-task-id'],
      idempotencyKey: a['idempotency-key'],
      workspaceProfile: a.profile || 'cli',
      allowFetch: Boolean(a['allow-fetch']),
    }));
  } else if (command === 'workspace-status') {
    print(statusWorkspace({
      workspaceRoot: a.root,
      workspaceId: a['workspace-id'],
      principal: a.principal,
      rootTaskId: a['root-task-id'],
      hostId: a.host,
    }));
  } else if (command === 'workspace-release') {
    print(releaseWorkspace({
      workspaceRoot: a.root,
      workspaceId: a['workspace-id'],
      principal: a.principal,
      rootTaskId: a['root-task-id'],
      hostId: a.host,
      processesStopped: boolFlag(a['processes-stopped']) !== false,
      force: Boolean(a.force),
      deliveryEvidence: a['delivery-merged'] ? { merged: true, evidence: a['delivery-evidence'] || 'cli' } : null,
    }));
  } else if (command === 'workspace-reconcile') {
    print(reconcileWorkspaces({ workspaceRoot: a.root }));
  } else if (command === 'pr-autofix-rollout') {
    const repos = collectRepos(a);
    if (!a.all && repos.length === 0) {
      console.error('pr-autofix-rollout: pass --all (org inventory), --repo <owner/name> or --repos <file>');
      process.exit(2);
    }
    const result = await rolloutAutofix({
      profileId: process.env.USER_ID || '',
      repos: a.all ? null : repos,
      autofix_ref: a.ref,
      ci_workflow_name: a['ci-workflow'],
      github: resolveGithubCapability(),
      dryRun: Boolean(a['dry-run']),
      withCleanup: !a['no-cleanup'],
    });
    if (a.json) print(result);
    else printRollout(result);
  } else if (command === 'repo-status') {
    if (!a.repo || a.repo === true) {
      console.error('repo-status: pass --repo <owner/name>');
      process.exit(2);
    }
    const limits = {};
    if (a.prs !== undefined && a.prs !== true) limits.prs = Number(a.prs);
    if (a.issues !== undefined && a.issues !== true) limits.issues = Number(a.issues);
    print(await repoStatus({
      repo: a.repo,
      limits: Object.keys(limits).length ? limits : undefined,
      refresh: a.refresh === true,
    }));
  } else if (command === 'repo-search') {
    if (!a.repo || a.repo === true) {
      console.error('repo-search: pass --repo <path> (a local checkout)');
      process.exit(2);
    }
    if (!a.query || a.query === true) {
      console.error('repo-search: pass --query <text>');
      process.exit(2);
    }
    print(await repoSearch({
      repo_path: path.resolve(String(a.repo)),
      query: a.query,
      strategy: typeof a.strategy === 'string' ? a.strategy : undefined,
      limit: a.limit !== undefined && a.limit !== true ? Number(a.limit) : undefined,
      include: splitList(a.include),
      include_stale: a['include-stale'] === true,
      refresh: a.refresh === true,
      max_chunks: a['max-chunks'] !== undefined && a['max-chunks'] !== true ? Number(a['max-chunks']) : undefined,
      embed_model: typeof a['embed-model'] === 'string' ? a['embed-model'] : undefined,
      workspaces_root: typeof a.root === 'string' ? a.root : undefined,
    }));
  } else if (command === 'repo-find') {
    if (!a.query || a.query === true) {
      console.error('repo-find: pass --query <text>');
      process.exit(2);
    }
    print(await findRepos({
      query: a.query,
      scope: a.scope,
      limit: a.limit !== undefined && a.limit !== true ? Number(a.limit) : undefined,
      cursor: a.cursor !== undefined && a.cursor !== true ? String(a.cursor) : undefined,
      refresh: a.refresh === true,
      include_archived: a['include-archived'] === true,
    }));
  } else if (command === 'change-find') {
    if (!a.repo || a.repo === true) {
      console.error('change-find: pass --repo <owner/name>');
      process.exit(2);
    }
    if ((!a['task-ref'] || a['task-ref'] === true) && (!a.query || a.query === true)) {
      console.error('change-find: pass --task-ref <text> or --query <text>');
      process.exit(2);
    }
    const timeRange = {};
    if (a.since && a.since !== true) timeRange.since = a.since;
    if (a.until && a.until !== true) timeRange.until = a.until;
    const knownRefs = splitList(a['known-refs']);
    print(await changeFind({
      repo: a.repo,
      task_ref: typeof a['task-ref'] === 'string' ? a['task-ref'] : undefined,
      query: typeof a.query === 'string' ? a.query : undefined,
      known_refs: knownRefs.length ? knownRefs : undefined,
      time_range: Object.keys(timeRange).length ? timeRange : undefined,
      limit: a.limit !== undefined && a.limit !== true ? Number(a.limit) : undefined,
    }, {
      principal: a.principal !== undefined && a.principal !== true ? a.principal : (process.env.USER_ID || ''),
      workspaceRoot: typeof a.root === 'string' ? a.root : undefined,
    }));
  } else if (command === 'change-bind') {
    if (!a.repo || a.repo === true) {
      console.error('change-bind: pass --repo <owner/name>');
      process.exit(2);
    }
    if (!a['task-ref'] || a['task-ref'] === true) {
      console.error('change-bind: pass --task-ref <text>');
      process.exit(2);
    }
    const refs = splitList(a.refs);
    if (!refs.length) {
      console.error('change-bind: pass --refs <"PR #1, branch eng/x">');
      process.exit(2);
    }
    print(await changeBind({
      repo: a.repo,
      task_ref: a['task-ref'],
      refs,
    }, {
      principal: a.principal !== undefined && a.principal !== true ? a.principal : (process.env.USER_ID || ''),
      workspaceRoot: typeof a.root === 'string' ? a.root : undefined,
    }));
  } else if (command === 'change-status') {
    if (!a['change-ref'] || a['change-ref'] === true) {
      console.error('change-status: pass --change-ref <#115|branch eng/x|sha abc1234|URL>');
      process.exit(2);
    }
    print(await changeStatus({
      change_ref: a['change-ref'],
      repo: typeof a.repo === 'string' ? a.repo : undefined,
      workspace_ref: typeof a['workspace-ref'] === 'string' ? a['workspace-ref'] : undefined,
      requirements_ref: typeof a['requirements-ref'] === 'string' ? a['requirements-ref'] : undefined,
    }, {
      principal: a.principal !== undefined && a.principal !== true ? a.principal : (process.env.USER_ID || ''),
      workspaceRoot: typeof a.root === 'string' ? a.root : undefined,
    }));
  } else if (command === 'verify') {
    function jsonArg(name) {
      const v = a[name];
      if (v === undefined || v === true) return undefined;
      try {
        return JSON.parse(v);
      } catch (e) {
        console.error(`verify: --${name} must be JSON (${e.message})`);
        process.exit(2);
      }
    }
    const target = jsonArg('target');
    const requirements = jsonArg('requirements');
    if (!target && !a['workspace-ref']) {
      console.error('verify: pass --target <json-object> ({"pr":115} / {"commit":"abc"} / {"workspace_ref":"ws-…"})');
      process.exit(2);
    }
    if (!requirements && !a['requirements-ref']) {
      console.error('verify: pass --requirements <json-array> or --requirements-ref <issue#112[@rev]|file:path[@rev]>');
      process.exit(2);
    }
    const budget = {};
    if (a['no-judge'] === true) budget.judge = false;
    if (typeof a['max-checks'] === 'string') budget.max_checks = Number(a['max-checks']);
    print(await verify({
      requirements,
      requirements_ref: typeof a['requirements-ref'] === 'string' ? a['requirements-ref'] : undefined,
      target,
      workspace_ref: typeof a['workspace-ref'] === 'string' ? a['workspace-ref'] : undefined,
      repo: typeof a.repo === 'string' ? a.repo : undefined,
      scope: typeof a.scope === 'string' ? a.scope : undefined,
      evidence_refs: typeof a['evidence-refs'] === 'string' ? a['evidence-refs'] : undefined,
      run_checks: a['run-checks'] === true,
      budget: Object.keys(budget).length ? budget : undefined,
    }, {
      principal: a.principal !== undefined && a.principal !== true ? a.principal : (process.env.USER_ID || ''),
      workspaceRoot: typeof a.root === 'string' ? a.root : undefined,
    }));
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

main().catch((e) => {
  if (e instanceof WorkspaceError) {
    print({ error: e.code, message: e.message, details: e.details });
    process.exit(1);
  }
  if (e && e.code) {
    print({ error: e.code, message: e.message });
    process.exit(1);
  }
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
