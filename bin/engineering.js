#!/usr/bin/env node
'use strict';

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
