'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareChecklist, classifyTask, inspectRepository } = require('../src/checklists/prepare');
const { TOOL, CI_WAIT_TOOL, handleRequest } = require('../src/mcp-checklists');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-checklist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, content = '') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('debugging checklist detects test routes and runtime affordances without executing project scripts', t => {
  const root = fixture(t);
  write(root, 'package.json', JSON.stringify({
    packageManager: 'bun@1.2.0',
    scripts: { test: 'echo MUST_NOT_RUN > test-was-run', 'test:worker': 'vitest run --project worker', dev: 'wrangler dev' },
    devDependencies: { '@cloudflare/vitest-plugin': '^1.0.0', '@playwright/test': '^1.0.0' },
  }));
  write(root, 'wrangler.toml');
  write(root, 'vitest.config.ts');
  write(root, 'playwright.config.ts');
  write(root, '.github/workflows/test.yml');
  write(root, 'Dockerfile');
  write(root, '.env', 'SECRET_VALUE=do-not-return');

  const result = prepareChecklist({ task: 'Session manager is broken after resume', repoPath: root });

  assert.equal(result.ok, true);
  assert.equal(result.taskType, 'debugging');
  assert.deepEqual(result.project.packageManager, 'bun@1.2.0');
  assert.deepEqual(result.project.packageManifests[0].scripts, ['dev', 'test', 'test:worker']);
  assert.deepEqual(result.project.capabilities, [
    'test-runner', 'local-app-start', 'browser-or-e2e-tests', 'cloudflare-worker-or-pages', 'github-actions', 'container-runtime',
  ]);
  assert.match(JSON.stringify(result), /тестовый пользовател/iu);
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_RUN|SECRET_VALUE|do-not-return/);
  assert.equal(fs.existsSync(path.join(root, 'test-was-run')), false);
  assert.equal(result.execution.commandsRun, false);
});

test('intent selection is based on task kind, while environment capabilities remain evidence-based', t => {
  const root = fixture(t);
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  write(root, 'wrangler.jsonc', '{}');

  const result = prepareChecklist({ task: 'Add a session recovery endpoint', repoPath: root });

  assert.equal(result.taskType, 'change');
  assert.deepEqual(result.project.capabilities, ['test-runner', 'cloudflare-worker-or-pages']);
  assert.equal(classifyTask('What test path should I use?', 'auto'), 'test-path');
  assert.equal(classifyTask('The page crashes on resume', 'debugging'), 'debugging');
});

test('missing project test infrastructure is reported without inventing commands', t => {
  const root = fixture(t);
  write(root, 'README.md', '# Project');

  const inspected = inspectRepository(root);
  const result = prepareChecklist({ task: 'How can we test this?', repoPath: root });

  assert.deepEqual(inspected.project.packageManifests, [{ path: 'package.json', scripts: [] }]);
  assert.deepEqual(inspected.project.capabilities, []);
  assert.equal(result.taskType, 'test-path');
  assert.match(result.guidance.join('\n'), /Если её нет/u);
});

test('invalid repository paths and task inputs return clear read-only errors', () => {
  assert.deepEqual(prepareChecklist({ task: 'debug this', repoPath: '/path/that/does/not/exist' }), {
    ok: false,
    error: 'REPOSITORY_PATH_NOT_FOUND',
    message: 'Указанный путь не является доступной папкой репозитория.',
  });
  assert.equal(prepareChecklist({ task: '', repoPath: '.' }).error, 'TASK_REQUIRED');
  assert.equal(prepareChecklist({ task: 'debug', repoPath: '.', intent: 'deploy' }).error, 'INTENT_INVALID');
});

test('MCP surface exposes checklist preparation and bounded CI wait tools', async t => {
  const root = fixture(t);
  write(root, 'package.json', '{"scripts":{"test":"node --test"}}');

  const listed = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['engineering_checklist_prepare', 'engineering_ci_wait']);
  assert.deepEqual(TOOL.inputSchema.required, ['task', 'repo_path']);
  assert.deepEqual(CI_WAIT_TOOL.inputSchema.required, ['repo']);

  const called = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: TOOL.name, arguments: { task: 'Debug a failing session', repo_path: root } },
  });
  const result = JSON.parse(called.result.content[0].text);
  assert.equal(result.taskType, 'debugging');
  assert.equal(result.execution.filesChanged, false);
  assert.equal((await handleRequest({ jsonrpc: '2.0', id: 3, method: 'initialize' })).result.serverInfo.name, 'engineering-checklists');
  const invalidWait = await handleRequest({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: CI_WAIT_TOOL.name, arguments: { repo: 'owner/repo', sha: 'abc', interval_seconds: 60 } },
  });
  assert.equal(JSON.parse(invalidWait.result.content[0].text).state, 'invalid_request');
});

test('MCP cancellation interrupts the wait request so changed criteria can be submitted', async () => {
  const pending = new Map();
  const wait = async (_args, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ ok: true, state: 'cancelled', outcome: 'pending' }), { once: true });
  });
  const call = handleRequest({
    jsonrpc: '2.0', id: 51, method: 'tools/call',
    params: { name: CI_WAIT_TOOL.name, arguments: { repo: 'owner/repo', run_id: 51 } },
  }, { pending, wait });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.has('51'), true);
  assert.equal(await handleRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 51 } }, { pending }), null);
  const result = await call;
  assert.equal(JSON.parse(result.result.content[0].text).state, 'cancelled');
  assert.equal(pending.has('51'), false);
});
