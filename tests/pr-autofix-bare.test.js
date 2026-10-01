'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const { setupDevbaseline, getAutofixRegistration, registerAutofix } = require('../src/pr-autofix');

function fixture(t) {
  const parent = process.env.SANDBOX_ROOT || path.join(__dirname, '../.sandbox');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'devbaseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'consumer.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=master', bare], { stdio: 'ignore' });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_INDEX_FILE: path.join(root, 'index') };
  const git = (args, input) => execFileSync('git', ['--git-dir', bare, ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const empty = git(['mktree'], '');
  const initial = git(['commit-tree', empty], 'fixture\n');
  git(['update-ref', 'refs/heads/master', initial]);
  const pulls = [];
  let writes = 0;
  const ok = (data) => ({ ok: true, status: 200, data });
  const missing = () => ({ ok: false, status: 404, data: { message: 'Not Found' } });
  const ghFetch = async (method, endpoint, body) => {
    const u = new URL(endpoint, 'http://fixture');
    let m;
    if (u.pathname.startsWith('/repos/trained-assist/pr-autofix/contents/')) {
      if (u.searchParams.get('ref') !== 'v1.7.4') return missing();
      const name = u.pathname.split('/contents/')[1];
      const tool = process.env.PR_AUTOFIX_PINNED_DIR;
      const content = tool ? fs.readFileSync(path.join(tool, name), 'utf8') : 'on:\n  workflow_call:\n';
      return ok({ content: Buffer.from(content).toString('base64') });
    }
    if (u.pathname === '/repos/fixture/consumer') return ok({ default_branch: 'master' });
    if (u.pathname.endsWith('/actions/workflows')) return ok({ workflows: [{ name: 'Node.js CI', path: '.github/workflows/ci.yml' }] });
    if ((m = u.pathname.match(/\/contents\/(.+)$/))) {
      const file = decodeURIComponent(m[1]);
      if (method === 'GET') {
        try {
          const rev = u.searchParams.get('ref');
          return ok({ content: Buffer.from(git(['show', `${rev}:${file}`]) + '\n').toString('base64'), sha: git(['rev-parse', `${rev}:${file}`]) });
        } catch { return missing(); }
      }
      const parentSha = git(['rev-parse', body.branch]);
      git(['read-tree', parentSha]);
      const blob = git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64'));
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
      const tree = git(['write-tree']);
      const sha = git(['commit-tree', tree, '-p', parentSha], body.message);
      git(['update-ref', `refs/heads/${body.branch}`, sha]); writes++;
      return ok({ content: { sha: blob }, commit: { sha } });
    }
    if ((m = u.pathname.match(/\/git\/refs?\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(m[1]);
      try {
        if (method === 'PATCH') git(['update-ref', `refs/heads/${branch}`, body.sha]);
        return ok({ object: { sha: git(['rev-parse', `refs/heads/${branch}`]) } });
      } catch { return missing(); }
    }
    if (u.pathname.endsWith('/git/refs')) { git(['update-ref', body.ref, body.sha]); return ok({}); }
    if (u.pathname.endsWith('/pulls')) {
      if (method === 'GET') return ok(pulls.filter(p => p.state === 'open'));
      const pr = { number: pulls.length + 1, state: 'open', html_url: 'https://example.test/fixture/consumer/pull/1', head: { ref: body.head }, base: { ref: body.base } };
      pulls.push(pr); return ok(pr);
    }
    throw Error(`unexpected fixture endpoint ${method} ${u.pathname}`);
  };
  return { root, git, ghFetch, pulls, writes: () => writes };
}

test('bare endpoint: setup/run/evidence/teardown, fresh registry repeat, exact SHAs and old-pin refusal', async t => {
  const f = fixture(t);
  const args = { repo: 'fixture/consumer', profileId: 'fixture', root: path.join(f.root, 'registry'), github: { ghToken: 'fixture', ghFetch: f.ghFetch } };
  const first = await setupDevbaseline(args);
  assert.equal(first.code, 0, JSON.stringify(first.error));
  assert.equal(first.evidence.base_branch, 'master');
  assert.equal(first.evidence.ci_workflow_name, 'Node.js CI');
  assert.equal(f.writes(), 2);
  assert.equal(getAutofixRegistration(args), null);
  assert.equal(first.evidence.repeat.changed_files, 0);
  assert.equal(first.evidence.source_sha, first.evidence.repeat.sha);
  assert.match(first.evidence.source_sha, /^[a-f0-9]{40}$/);
  assert.ok(Object.values(first.evidence.file_shas).every(s => /^[a-f0-9]{40}$/.test(s)));
  const second = await setupDevbaseline(args);
  assert.equal(second.code, 0);
  assert.equal(second.evidence.changed, false);
  assert.equal(second.evidence.source_sha, first.evidence.source_sha);
  assert.equal(f.writes(), 2);
  f.git(['update-ref', 'refs/heads/master', first.evidence.source_sha]);
  f.pulls[0].state = 'closed';
  registerAutofix({ ...args, registration: { repo: args.repo, features: { cleanup: true, fix: true } } });
  const before = getAutofixRegistration(args);
  const landed = await setupDevbaseline(args);
  assert.equal(landed.code, 0);
  assert.equal(landed.evidence.reason, 'already_pinned');
  assert.deepEqual(getAutofixRegistration(args), before);
  const refused = await setupDevbaseline({ ...args, autofix_ref: 'v1.0.0' });
  assert.equal(refused.error.code, 'REF_NOT_CALLABLE');
  assert.equal(f.writes(), 2);
  assert.deepEqual(getAutofixRegistration(args), before);
  console.log(JSON.stringify({ first: first.evidence, repeat: second.evidence, teardown: landed.teardown, refused: refused.error.code }));
});

test('CLI starts with no registry, awaits result and returns nonzero for rejected pin', async t => {
  const f = fixture(t);
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    try {
      const result = await f.ghFetch(req.method, req.url, data ? JSON.parse(data) : undefined);
      res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.data));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preload = path.join(f.root, 'preload.cjs');
  fs.writeFileSync(preload, `const m = require(${JSON.stringify(path.join(__dirname, '../src/pr-autofix/installer'))}); m.setGithubCapabilityFactory(() => m.createGithubCapability({ token: 'fixture', apiBase: process.env.ENGINEERING_GITHUB_API_BASE }));`);
  const run = (ref) => new Promise(resolve => {
    const child = spawn(process.execPath, ['--require', preload, 'scripts/devbaseline-setup.js', '--repo', 'fixture/consumer', '--root', path.join(f.root, 'cli-registry'), '--ref', ref, '--json'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, ENGINEERING_GITHUB_TOKEN: 'fixture', ENGINEERING_GITHUB_API_BASE: `http://127.0.0.1:${server.address().port}` },
    });
    let out = '', err = ''; child.stdout.on('data', s => out += s); child.stderr.on('data', s => err += s);
    child.on('close', code => resolve({ code, out, err }));
  });
  const good = await run('v1.7.4');
  assert.equal(good.code, 0, good.err + good.out);
  assert.equal(JSON.parse(good.out).evidence.idempotent, true);
  const bad = await run('v0.0.0');
  assert.equal(bad.code, 5, bad.err + bad.out);
  assert.equal(JSON.parse(bad.out).error.code, 'REF_NOT_CALLABLE');
});
