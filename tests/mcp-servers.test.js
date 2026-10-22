'use strict';

// The MCP stack is assembled from several repositories and one remote host.
// Nothing used to say which of them belong together, which revision each one
// runs, or which tool names each one publishes — so the host could run an
// unversioned working tree, and two servers could publish the same name, with
// one of them shadowing the other by start order (issue #164, finding 3).
//
// mcp-servers.json is that declaration; src/mcp-servers/ is the check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  validateDeclaration,
  compareHost,
  checkToolNameCollisions,
  checkComposition,
} = require('../src/mcp-servers');
const { probeTools } = require('../src/mcp-servers/probe');

const ROOT = path.join(__dirname, '..');
const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-servers.json'), 'utf8'));

function hostConfig(servers) {
  return { mcp: { servers } };
}

// A real git checkout with the declared layout, so the pin check has something
// to look at.
function fixtureCheckout({ dirty = false, entrypoint = 'src/mcp-skills/index.js', origin = 'https://github.com/trained-assist/software-engineering-playbooks' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-mcp-servers-'));
  const file = path.join(dir, entrypoint);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// fixture\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('remote', 'add', 'origin', origin);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  if (dirty) fs.appendFileSync(file, '// uncommitted\n');
  const sha = git('rev-parse', 'HEAD');
  return { dir, entrypointPath: file, sha, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the composition declaration is valid and describes every server of the stack', () => {
  const { errors, warnings } = validateDeclaration(declaration, { repoRoot: ROOT });
  assert.deepEqual(errors, [], `declaration errors: ${errors.join(' | ')}`);
  assert.deepEqual(warnings, [], `declaration warnings: ${warnings.join(' | ')}`);
  assert.ok(Object.keys(declaration.servers).length >= 8, 'the whole stack is declared');
});

test('a declared server must say what it is for, where it comes from and which revision it pins to', () => {
  const broken = {
    version: 1,
    servers: {
      'no-role': { type: 'local', enabled: true, source: { repository: 'x/y', entrypoint: 'a.js', ref: null } },
      'bad-type': { type: 'socket', enabled: true, role: 'x', source: { repository: 'x/y', entrypoint: 'a.js', ref: null } },
      'no-source': { type: 'local', enabled: true, role: 'x' },
      'bad-repository': { type: 'local', enabled: true, role: 'x', source: { repository: 'not-a-repo', entrypoint: 'a.js', ref: null } },
      'bad-ref': { type: 'local', enabled: true, role: 'x', source: { repository: 'x/y', entrypoint: 'a.js', ref: 42 } },
      'remote-without-url': { type: 'remote', enabled: true, role: 'x', source: {} },
    },
  };
  const { errors } = validateDeclaration(broken, { repoRoot: ROOT });
  assert.ok(errors.some(e => /"no-role" must declare a role/.test(e)), 'the role is required');
  assert.ok(errors.some(e => /"bad-type" must declare type/.test(e)), 'the type must be local or remote');
  assert.ok(errors.some(e => /"no-source" must declare a source/.test(e)), 'the source is required');
  assert.ok(errors.some(e => /"bad-repository" must declare source.repository/.test(e)), 'the repository must be org/repo');
  assert.ok(errors.some(e => /"bad-ref" source.ref/.test(e)), 'the pinned revision must be a sha, a tag or null');
  assert.ok(errors.some(e => /"remote-without-url" must declare source.url/.test(e)), 'a remote server needs a URL');
});

test('the declared tool count must match what the server actually publishes', () => {
  const wrong = JSON.parse(JSON.stringify(declaration));
  wrong.servers['engineering-skills'].expectedToolCount = 3;
  const { errors } = validateDeclaration(wrong, { repoRoot: ROOT });
  assert.ok(errors.some(e => /"engineering-skills" declares expectedToolCount 3, but the server publishes \d+/.test(e)),
    'the count is verified against the live registry');
});

test('a declared server may not disappear from the host', () => {
  const { errors } = compareHost(declaration, declaration.servers, hostConfig({}), { repoRoot: ROOT });
  assert.ok(errors.some(e => /"engineering-skills" is declared but missing from the host config/.test(e)),
    `a missing server is an error: ${errors.join(' | ')}`);
});

test('a server that is not declared may not run on the host', () => {
  const host = hostConfig({ 'mystery-server': { type: 'local', command: ['node', '/somewhere/index.js'] } });
  const { errors } = compareHost(declaration, declaration.servers, host, { repoRoot: ROOT });
  assert.ok(errors.some(e => /"mystery-server" is enabled but not declared/.test(e)),
    `an undeclared server is an error: ${errors.join(' | ')}`);
});

test('a server declared as disabled may not be enabled on the host', () => {
  const host = hostConfig({ trained: { type: 'remote', url: declaration.servers.trained.source.url } });
  const { errors } = compareHost(declaration, declaration.servers, host, { repoRoot: ROOT });
  assert.ok(errors.some(e => /"trained" is declared as disabled but is enabled in the host config/.test(e)),
    `the disabled state is enforced: ${errors.join(' | ')}`);
});

test('the host must start the declared entrypoint, from a clean checkout of the declared repository', (t) => {
  const fixture = fixtureCheckout({ dirty: true });
  t.after(fixture.cleanup);
  const pinned = {
    version: 1,
    servers: {
      'fixture-server': {
        type: 'local',
        enabled: true,
        role: 'fixture',
        source: {
          repository: 'trained-assist/software-engineering-playbooks',
          entrypoint: 'src/mcp-skills/index.js',
          ref: fixture.sha,
        },
        expectedToolCount: null,
      },
    },
  };
  const host = hostConfig({
    'fixture-server': { type: 'local', command: ['node', fixture.entrypointPath], cwd: fixture.dir },
  });
  const { errors } = compareHost(pinned, pinned.servers, host, { repoRoot: ROOT });
  assert.ok(errors.some(e => /runs an UNCOMMITTED checkout/.test(e)),
    `a dirty checkout of a pinned server is an error: ${errors.join(' | ')}`);
});

test('an unpinned server with a dirty checkout is reported, not failed', (t) => {
  const fixture = fixtureCheckout({ dirty: true });
  t.after(fixture.cleanup);
  const unpinned = {
    version: 1,
    servers: {
      'fixture-server': {
        type: 'local',
        enabled: true,
        role: 'fixture',
        source: { repository: 'trained-assist/software-engineering-playbooks', entrypoint: 'src/mcp-skills/index.js', ref: null },
        expectedToolCount: null,
      },
    },
  };
  const host = hostConfig({
    'fixture-server': { type: 'local', command: ['node', fixture.entrypointPath], cwd: fixture.dir },
  });
  const { errors, warnings } = compareHost(unpinned, unpinned.servers, host, { repoRoot: ROOT });
  assert.deepEqual(errors, [], `an unpinned server is not the declaration's business: ${errors.join(' | ')}`);
  assert.ok(warnings.some(w => /runs an UNCOMMITTED checkout/.test(w)), warnings.join(' | '));
});

test('a checkout of another repository is an error', (t) => {
  const fixture = fixtureCheckout({ origin: 'https://github.com/somebody/else.git' });
  t.after(fixture.cleanup);
  const pinned = {
    version: 1,
    servers: {
      'fixture-server': {
        type: 'local',
        enabled: true,
        role: 'fixture',
        source: { repository: 'trained-assist/software-engineering-playbooks', entrypoint: 'src/mcp-skills/index.js', ref: fixture.sha },
        expectedToolCount: null,
      },
    },
  };
  const host = hostConfig({
    'fixture-server': { type: 'local', command: ['node', fixture.entrypointPath], cwd: fixture.dir },
  });
  const { errors } = compareHost(pinned, pinned.servers, host, { repoRoot: ROOT });
  assert.ok(errors.some(e => /the declaration pins trained-assist\/software-engineering-playbooks/.test(e)),
    `the repository is verified: ${errors.join(' | ')}`);
});

test('two servers that publish the same tool name are an error', async () => {
  const host = hostConfig({
    alpha: { type: 'local', command: ['node', '/alpha.js'] },
    beta: { type: 'local', command: ['node', '/beta.js'] },
  });
  const servers = {
    alpha: { type: 'local', enabled: true, role: 'a', source: { repository: 'x/y', entrypoint: 'a.js', ref: null } },
    beta: { type: 'local', enabled: true, role: 'b', source: { repository: 'x/z', entrypoint: 'b.js', ref: null } },
  };
  const { errors } = await checkToolNameCollisions(servers, host, {
    probe: async () => ({ ok: true, tools: ['shared_tool', 'own_tool'], error: null }),
  });
  assert.ok(errors.some(e => /tool name "shared_tool" is published by 2 servers/.test(e)),
    `a duplicate tool name is an error: ${errors.join(' | ')}`);
});

test('the two engineering providers publish disjoint tool names', async () => {
  const host = hostConfig({
    'engineering-skills': {
      type: 'local',
      command: [process.execPath, path.join(ROOT, 'src', 'mcp-skills', 'index.js')],
      cwd: ROOT,
      environment: { USER_ID: 'check-mcp-servers-test' },
    },
    'engineering-checklists': {
      type: 'local',
      command: [process.execPath, path.join(ROOT, 'src', 'mcp-checklists', 'index.js')],
      cwd: ROOT,
    },
  });
  const { errors } = await checkToolNameCollisions(declaration.servers, host);
  assert.deepEqual(errors, [], `no duplicate tool names: ${errors.join(' | ')}`);
});

test('the probe reads the tools/list of a live MCP server', async () => {
  const answer = await probeTools([process.execPath, path.join(ROOT, 'src', 'mcp-checklists', 'index.js')]);
  assert.equal(answer.ok, true, answer.error || '');
  assert.deepEqual(answer.tools.sort(), ['agent_run_start', 'agent_run_wait', 'engineering_checklist_prepare', 'engineering_ci_wait']);
});

test('a server that cannot be started is a warning, never a crash', async () => {
  const answer = await probeTools([path.join(os.tmpdir(), 'definitely-not-a-server')], undefined, { timeoutMs: 5000 });
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.tools, []);
});

test('the whole check passes for the declaration of this repository', async () => {
  const { errors } = await checkComposition({ declaration, repoRoot: ROOT });
  assert.deepEqual(errors, [], `the declaration is consistent: ${errors.join(' | ')}`);
});
