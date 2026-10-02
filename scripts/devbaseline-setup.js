#!/usr/bin/env node
'use strict';

// Z01 · T10 (issue software-engineering-playbooks#78): the ONE entry point for putting the
// devbaseline into a repository. Local process, no ssh alias, no second host:
//
//   npm run setup:devbaseline -- --repo owner/name [--ref v1.7.4] [--base main]
//                                 [--ci-workflow CI] [--no-teardown] [--json]
//
// Reads a GitHub token from the environment exactly like the rest of the pr-autofix service
// (ENGINEERING_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN). It never prints one.
//
// Exit codes are part of the contract (see src/pr-autofix/setup.js):
//   0 = observed the state that was asked for (including "already pinned" — a no-op is success)
//   5 = a phase could not be observed
//   6 = invalid state

const path = require('path');
const os = require('os');
const { setupDevbaseline, SETUP_CODES } = require('../src/pr-autofix/setup');

function parseArgv(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    flags[key] = next;
    i++;
  }
  return flags;
}

function defaultRoot(profileId) {
  const base = process.env.ENGINEERING_PR_AUTOFIX_ROOT
    || path.join(os.homedir(), 'agent-data', 'engineering', 'pr-autofix');
  return profileId ? path.join(base, profileId) : base;
}

function main() {
  const flags = parseArgv(process.argv.slice(2));
  const repo = typeof flags.repo === 'string' ? flags.repo : null;
  if (!repo || typeof repo !== 'string' || repo.indexOf('/') === -1) {
    process.stderr.write('usage: npm run setup:devbaseline -- --repo owner/name [--ref vX.Y.Z]\n');
    return SETUP_CODES.INVALID_STATE;
  }
  const profileId = typeof flags['profile-id'] === 'string' ? flags['profile-id'] : 'default';
  const root = typeof flags.root === 'string' ? flags.root : defaultRoot(profileId);

  return setupDevbaseline({
    repo,
    profileId,
    root,
    autofix_ref: typeof flags.ref === 'string' ? flags.ref : undefined,
    base_branch: typeof flags.base === 'string' ? flags.base : undefined,
    ci_workflow_name: typeof flags['ci-workflow'] === 'string' ? flags['ci-workflow'] : undefined,
    withTeardown: flags['no-teardown'] !== true,
  }).then((r) => {
    if (flags.json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.code; }
    for (const p of r.phases) {
      process.stdout.write(`${p.ok === false ? 'FAIL' : ' ok '} ${p.phase}${p.detail && p.detail.reason ? ` (${p.detail.reason})` : ''}\n`);
    }
    if (r.evidence) {
      const e = r.evidence;
      process.stdout.write(`evidence: repo=${e.repo} ref=${e.pinned_ref} base=${e.base_branch} ci=${e.ci_workflow_name}\n`);
      process.stdout.write(`evidence: changed=${e.changed} idempotent=${e.idempotent} reason=${e.reason} pr=${e.pr ? e.pr.url : '—'}\n`);
      process.stdout.write(`evidence: files=${e.files.join(', ')}\n`);
    }
    if (r.error) process.stderr.write(`error: ${r.error.code} ${r.error.message || ''}\n`);
    return r.code;
  }).catch((e) => {
    process.stderr.write(`error: ${e && e.code ? e.code : 'ERROR'} ${e && e.message}\n`);
    return SETUP_CODES.PHASE_UNOBSERVABLE;
  });
}

Promise.resolve().then(main).then((code) => { process.exitCode = code; }).catch((e) => {
  process.stderr.write(`error: ${e.code || 'ERROR'} ${e.message}\n`);
  process.exitCode = SETUP_CODES.PHASE_UNOBSERVABLE;
});