'use strict';

// Core-shaped modules moved from trained-assist-agent (#1631): isReady()/setupTools
// gating, the static listAllTools() catalog core's headless transport relies on, and
// the SKILLS_RESOLVED module filter. The registry reads env at require time, so each
// case loads it in a fresh process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY = path.join(__dirname, '..', 'src', 'mcp-skills', 'registry.js');

function load(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-reg-home-'));
  try {
    const out = execFileSync(process.execPath, ['-e', `
      const r = require(${JSON.stringify(REGISTRY)});
      process.stdout.write(JSON.stringify({ listed: r.listTools().map(t => t.name), all: r.listAllTools().map(t => t.name) }));
    `], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('without a GitHub token only setup tools of the GitHub modules are listed', () => {
  const { listed, all } = load({ USER_ID: 'nobody' });
  assert.ok(listed.includes('github_status'), 'setup tool stays listed');
  assert.ok(!listed.includes('github_create_pr'));
  assert.ok(!listed.includes('dev_workspace_setup'));
  assert.ok(!listed.includes('pr_status'), '62-pr-status is gated without a token');
  assert.ok(!listed.includes('issue_status'), '62-pr-status is gated without a token');
  assert.ok(listed.includes('cicd_track_pr'), '63-ci-cd needs no token');
  assert.ok(listed.includes('engineering_spawn_workspace'), 'engineering-native tools unaffected');
  for (const name of ['github_create_pr', 'dev_workspace_setup', 'dev_supersede_pr', 'cicd_track_pr', 'engineering_spawn_workspace', 'pr_status', 'issue_status']) {
    assert.ok(all.includes(name), `${name} in listAllTools`);
  }
});

test('with a GitHub token the moved tools are listed', () => {
  const { listed } = load({ USER_ID: 'someone', GH_TOKEN: 'x' });
  for (const name of ['github_create_pr', 'github_pr_checks', 'pr_status', 'issue_status', 'dev_workspace_setup', 'dev_new_repo', 'dev_supersede_pr', 'cicd_track_pr']) {
    assert.ok(listed.includes(name), name);
  }
});

test('SKILLS_RESOLVED hides modules of switched-off sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-reg-'));
  const file = path.join(dir, 'effective.json');
  fs.writeFileSync(file, JSON.stringify({ hidden: { modules: ['engineering-skills/60-github.js', 'trained-skills/61-dev.js'] } }));
  try {
    const { listed, all } = load({ USER_ID: 'someone', GH_TOKEN: 'x', SKILLS_RESOLVED: file });
    assert.ok(!listed.includes('github_create_pr'), 'own module hidden');
    assert.ok(listed.includes('dev_workspace_setup'), 'another server\'s entry is ignored');
    assert.ok(all.includes('github_create_pr'), 'static catalog keeps hidden tools');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
