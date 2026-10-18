'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const catalog = require('../../checklists/catalog.json');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.next', 'dist', 'build', 'coverage', 'vendor']);
const isRelevantScript = name => /^(?:test(?:[:_-].*)?|check(?:[:_-].*)?|lint|typecheck|build|dev|start|e2e|integration)(?:$|:)/i.test(name);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(root, depth = 1) {
  const found = [];
  function visit(dir, level) {
    if (level > depth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name), level + 1);
        continue;
      }
      found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  visit(root, 0);
  return found.sort();
}

function inspectGit(root) {
  try {
    const options = { encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] };
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], options).trim();
    const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], options).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], options).trim();
    return { root: fs.realpathSync(top), branch: branch || null, dirty: Boolean(status), changeCount: status ? status.split('\n').length : 0 };
  } catch {
    return null;
  }
}

function inspectRepository(inputPath) {
  const root = path.resolve(inputPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: 'REPOSITORY_PATH_NOT_FOUND', message: 'Указанный путь не является доступной папкой репозитория.' };
  }

  const files = listFiles(root, 2);
  const topFiles = new Set(files.filter(file => !file.includes('/')));
  const packageFile = path.join(root, 'package.json');
  const pkg = readJson(packageFile);
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).filter(isRelevantScript).sort() : [];
  const packageSignals = pkg ? [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ] : [];
  const has = pattern => files.some(file => pattern.test(file));
  const evidence = [];
  const capabilities = [];

  if (pkg) evidence.push('package.json');
  if (topFiles.has('AGENTS.md') || topFiles.has('CONTRIBUTING.md') || topFiles.has('README.md')) evidence.push('project instructions/docs');
  if (scripts.some(name => /^test(?::|$)/.test(name)) || has(/(^|\/)(tests?|__tests__)\//) || has(/\.(test|spec)\.[cm]?[jt]sx?$/)) capabilities.push('test-runner');
  if (scripts.some(name => ['dev', 'start'].includes(name))) capabilities.push('local-app-start');
  if (has(/(^|\/)(vitest|jest|playwright|cypress|pytest|tox|cargo-nextest|wdio)\.config\./) || packageSignals.includes('@playwright/test') || packageSignals.includes('playwright')) capabilities.push('browser-or-e2e-tests');
  if (has(/(^|\/)(wrangler\.toml|wrangler\.jsonc?|\.dev\.vars\.example)$/)) capabilities.push('cloudflare-worker-or-pages');
  if (files.some(file => file.startsWith('.github/workflows/'))) capabilities.push('github-actions');
  if (topFiles.has('Dockerfile') || files.some(file => /(^|\/)(docker-compose|compose)\.(ya?ml)$/i.test(file))) capabilities.push('container-runtime');
  if (has(/(^|\/)(migrations?|drizzle|prisma|knex|alembic)(\/|\.|$)/i)) capabilities.push('database-migrations');
  if (files.some(file => /(^|\/)(fixtures?|testdata|__fixtures__)\//i.test(file))) capabilities.push('test-fixtures');

  const packageManifests = [{ path: 'package.json', scripts }];
  for (const file of files.filter(name => /^packages\/[^/]+\/package\.json$/.test(name)).slice(0, 12)) {
    const nested = readJson(path.join(root, file));
    if (!nested) continue;
    const names = Object.keys(nested.scripts || {}).filter(isRelevantScript).sort();
    if (names.length) packageManifests.push({ path: file, scripts: names });
  }

  const lockfile = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find(name => topFiles.has(name)) || null;
  const project = {
    root: fs.realpathSync(root),
    git: inspectGit(root),
    languages: [
      ...(pkg ? ['JavaScript/TypeScript'] : []),
      ...(topFiles.has('pyproject.toml') || topFiles.has('requirements.txt') ? ['Python'] : []),
      ...(topFiles.has('Cargo.toml') ? ['Rust'] : []),
      ...(topFiles.has('go.mod') ? ['Go'] : []),
    ],
    packageManager: pkg?.packageManager || (lockfile === 'bun.lock' || lockfile === 'bun.lockb' ? 'bun' : lockfile === 'pnpm-lock.yaml' ? 'pnpm' : lockfile === 'yarn.lock' ? 'yarn' : lockfile === 'package-lock.json' ? 'npm' : null),
    packageManifests,
    capabilities,
    evidence: [...new Set(evidence)],
  };

  return { ok: true, project };
}

function classifyTask(task, intent = 'auto') {
  if (intent !== 'auto') return intent;
  if (/\b(bug|debug|debugging|regression|broken|fails?|error|doesn't work|not working|исправ|ошибк|не работает|сломал|регресс|падает|падени|баг)\b/i.test(task)) return 'debugging';
  if (/\b(test|testing|test path|how to verify|как проверить|тестирован|проверить проект|нет тестов|нет очевидн)\b/i.test(task)) return 'test-path';
  return 'change';
}


function deliveryDisabledByTask(task) {
  const text = String(task || '');
  return /\b(no\s+(pr|pull\s*request|branch|merge|deploy|ci)|no\s+\w+\s+(pr|pull\s*request|branch|merge|deploy|ci)|without\s+(pr|pull\s*request|branch|merge|deploy|ci)|skip\s+(pr|pull\s*request|branch|ci|merge|deploy)|direct(?:ly)?\s+(to|into|commit)|commit\s+directly|только\s+локально|без\s+(pr|pull\s*request|ветк|мерж|депло|ci)|не\s+(делай|нужен|нужно)\s+.*(pr|pull\s*request|ветк|мерж|депло|ci)|напрямую\s+в\s+(main|master))\b/i.test(text);
}

function resolveDelivery(task, options = {}) {
  const candidates = [
    options.delivery,
    options.includeDelivery,
    options.include_delivery,
    options.defaultDelivery,
    options.default_delivery,
    options.pr,
    options.pullRequest,
    options.pull_request,
    options.deliverable,
    options.deliveryScope,
    options.delivery_scope,
    options.mode,
    options.scope,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return candidate !== 0;
    const value = String(candidate).trim().toLowerCase();
    if (['false', 'none', 'disabled', 'no', 'off', '0', 'local', 'local-only', 'narrow'].includes(value)) return false;
    if (value.includes('local') || value.includes('no-pr') || value.includes('no pr') || value.includes('narrow')) return false;
    if (['true', 'default', 'enabled', 'yes', 'on', '1', 'full'].includes(value)) return true;
  }
  return !deliveryDisabledByTask(task);
}

function prepareChecklist({ task, repoPath, repo_path, intent = 'auto', delivery, includeDelivery, include_delivery, defaultDelivery, default_delivery, pr, pullRequest, pull_request, deliverable, deliveryScope, delivery_scope, mode, scope } = {}) {
  if (typeof task !== 'string' || task.trim().length === 0) {
    return { ok: false, error: 'TASK_REQUIRED', message: 'Передай краткое описание задачи.' };
  }
  const resolvedRepoPath = typeof repoPath === 'string' && repoPath.trim() ? repoPath : repo_path;
  if (typeof resolvedRepoPath !== 'string' || resolvedRepoPath.trim().length === 0) {
    return { ok: false, error: 'REPOSITORY_PATH_REQUIRED', message: 'Передай путь к проверяемой кодовой базе.' };
  }
  if (!['auto', 'debugging', 'test-path', 'change'].includes(intent)) {
    return { ok: false, error: 'INTENT_INVALID', message: 'intent должен быть auto, debugging, test-path или change.' };
  }

  const inspected = inspectRepository(resolvedRepoPath);
  if (!inspected.ok) return inspected;
  const type = classifyTask(task, intent);
  const definition = catalog.taskTypes[type];
  const deliveryIsEnabled = resolveDelivery(task, { delivery, includeDelivery, include_delivery, defaultDelivery, default_delivery, pr, pullRequest, pull_request, deliverable, deliveryScope, delivery_scope, mode, scope });
  const checklist = deliveryIsEnabled
    ? definition.checklist
    : definition.checklist.filter(item => !item.delivery);
  return {
    ok: true,
    version: catalog.version,
    taskType: type,
    taskSummary: task.trim().slice(0, 500),
    project: inspected.project,
    delivery: deliveryIsEnabled,
    defaultDelivery: deliveryIsEnabled,
    checklist,
    guidance: definition.guidance,
    execution: {
      commandsRun: false,
      filesChanged: false,
      externalEffects: false,
    },
  };
}

module.exports = { classifyTask, inspectRepository, prepareChecklist };
