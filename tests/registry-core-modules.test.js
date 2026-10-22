'use strict';

// Core-shaped modules moved from trained-assist-agent (#1631): isReady()/setupTools
// gating, the static listAllTools() catalog core's headless transport relies on, and
// the SKILLS_RESOLVED module filter. The registry reads env at require time, so each
// case loads it in a fresh process.
//
// Contract (issue #164): the catalog is DETERMINISTIC. tools/list never changes
// shape because a credential is missing — a tool that cannot work right now stays
// declared and answers the call with an explicit NOT_READY error that says what
// to configure. Before, a missing token silently removed 15 tools, so the same
// host saw a different catalog depending on the environment it booted in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY = path.join(__dirname, '..', 'src', 'mcp-skills', 'registry.js');

// The `gh auth token` fallback would make the "no token" case unreachable on a
// dev host that is logged into the gh CLI. These cases are about the file/env
// contract, so the fallback is switched off explicitly.
const NO_GH_FALLBACK = { ENGINEERING_GITHUB_DISABLE_GH_FALLBACK: '1' };

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-reg-home-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runIn(home, script, env) {
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8',
  });
  return out;
}

function load(env) {
  return withHome(home => {
    const out = runIn(home, `
      const r = require(${JSON.stringify(REGISTRY)});
      process.stdout.write(JSON.stringify({ listed: r.listTools().map(t => t.name), all: r.listAllTools().map(t => t.name) }));
    `, env);
    return JSON.parse(out);
  });
}

// Calls one tool and reports the outcome as JSON. A gated tool must fail with
// NOT_READY instead of "Unknown tool" — that is the whole point of keeping the
// catalog complete.
function callTool(env, name, args = {}) {
  return withHome(home => {
    const out = runIn(home, `
      const r = require(${JSON.stringify(REGISTRY)});
      r.callTool(${JSON.stringify(name)}, ${JSON.stringify(args)})
        .then(v => { process.stdout.write(JSON.stringify({ ok: true, value: v })); })
        .catch(e => { process.stdout.write(JSON.stringify({ ok: false, message: String(e && e.message) })); });
    `, env);
    return JSON.parse(out);
  });
}

test('the catalog is complete without a GitHub token — gated tools stay declared', () => {
  const { listed, all } = load({ USER_ID: 'nobody', ...NO_GH_FALLBACK });
  assert.ok(listed.includes('github_status'), 'setup tool stays listed');
  assert.ok(listed.includes('github_create_pr'), 'gated tool stays in the catalog');
  assert.ok(listed.includes('pr_status'), '62-pr-status stays in the catalog');
  assert.ok(listed.includes('issue_status'), '62-pr-status stays in the catalog');
  assert.ok(listed.includes('cicd_track_pr'), '63-ci-cd needs no token');
  assert.ok(listed.includes('engineering_spawn_workspace'), 'engineering-native tools unaffected');
  for (const name of ['github_create_pr', 'dev_supersede_pr', 'cicd_track_pr', 'engineering_spawn_workspace', 'pr_status', 'issue_status']) {
    assert.ok(all.includes(name), `${name} in listAllTools`);
  }
  assert.deepEqual(listed, all, 'tools/list and listAllTools agree when no module is hidden');
});

test('the catalog does not depend on whether a GitHub token is present', () => {
  const without = load({ USER_ID: 'someone', ...NO_GH_FALLBACK });
  const with_ = load({ USER_ID: 'someone', GH_TOKEN: 'x', ...NO_GH_FALLBACK });
  assert.deepEqual(with_.listed, without.listed, 'same catalog with and without a token');
  assert.deepEqual(with_.all, without.all);
});

test('a gated tool called without a token fails with an explicit NOT_READY error', () => {
  const result = callTool({ USER_ID: 'nobody', ...NO_GH_FALLBACK }, 'github_create_pr', { repo: 'owner/repo' });
  assert.equal(result.ok, false);
  assert.match(result.message, /^NOT_READY:/, 'the error is tagged, not a generic failure');
  assert.match(result.message, /GitHub-токен/i, 'the message names the missing credential');
  assert.match(result.message, /gh auth login|GH_TOKEN/, 'the message says how to fix it');
});

test('a gated tool answers with NOT_READY even when the token file does not exist', () => {
  const result = callTool({ USER_ID: 'nobody', AGENT_TOKENS_DIR: '/nonexistent-token-dir', ...NO_GH_FALLBACK }, 'pr_status', { repo: 'owner/repo', pr_number: 1 });
  assert.equal(result.ok, false);
  assert.match(result.message, /^NOT_READY:/);
});

test('SKILLS_RESOLVED hides modules of switched-off sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-reg-'));
  const file = path.join(dir, 'effective.json');
  fs.writeFileSync(file, JSON.stringify({ hidden: { modules: ['engineering-skills/60-github.js', 'trained-skills/61-dev.js'] } }));
  try {
    const { listed, all } = load({ USER_ID: 'someone', GH_TOKEN: 'x', SKILLS_RESOLVED: file });
    assert.ok(!listed.includes('github_create_pr'), 'own module hidden');
    assert.ok(listed.includes('dev_new_repo'), 'another server\'s entry is ignored');
    assert.ok(all.includes('github_create_pr'), 'static catalog keeps hidden tools');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
