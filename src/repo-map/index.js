'use strict';

// Public surface of the repo-map feature: `repo_map(repo, level, focus)`.
//
// Invariants (issue #49 / agent #1481):
//   - the answer is never empty: every branch explains what happened and what
//     to do instead (read the raw repository);
//   - a map is only ever served for the commit that is checked out now — a
//     foreign sha is reported, never silently returned as current;
//   - a missing map is built lazily on first use (that is how a merge in main
//     invalidates everything without a webhook).

const fs = require('fs');
const path = require('path');
const { currentRevision } = require('../index/build');
const { mapDirFor, resolveWorkspacesRoot } = require('./paths');
const { buildMap, isBuilt, readIndexDir } = require('./build');
const { renderL1 } = require('./l1');

function fallbackText(reason) {
  return [
    `Карта репозитория недоступна: ${reason}.`,
    'Не додумывай содержимое: читай сырой репо (README, каталоги, нужные файлы) — этот путь работает всегда.',
  ].join('\n');
}

async function renderMap({ repoPath, workspacesRoot, level = 0, focus = [], sha = null } = {}) {
  const root = resolveWorkspacesRoot(workspacesRoot);
  if (!repoPath) {
    return { status: 'failed', sha: null, text: fallbackText('не передан repo (путь к репозиторию)') };
  }
  const abs = path.resolve(repoPath);
  const head = currentRevision(abs);
  if (!head) {
    return { status: 'failed', sha: null, text: fallbackText(`${abs} не является git-репозиторием`) };
  }
  if (sha && sha !== head) {
    return {
      status: 'missing',
      sha: head,
      text: fallbackText(
        `запрошен коммит ${String(sha).slice(0, 8)}, а в рабочей копии ${head.slice(0, 8)} — карту чужого коммита не отдаём`,
      ),
    };
  }

  try {
    await buildMap({ repoPath: abs, workspacesRoot: root });
  } catch (e) {
    return { status: 'failed', sha: head, text: fallbackText(`сборка не удалась (${(e && e.message) || e})`) };
  }

  try {
    const dir = mapDirFor({ repoPath: abs, workspacesRoot: root, sha: head });
    if (Number(level) === 1) {
      const index = readIndexDir(path.join(dir, 'index'));
      if (!index) return { status: 'failed', sha: head, text: fallbackText('индекс для этого коммита не читается') };
      return { status: 'ready', sha: head, text: renderL1({ index, sha: head, focus }) };
    }
    const l0 = JSON.parse(fs.readFileSync(path.join(dir, 'map-l0.json'), 'utf8'));
    if (!l0 || typeof l0.text !== 'string' || !l0.text.trim()) {
      return { status: 'failed', sha: head, text: fallbackText('карта L0 пуста') };
    }
    return { status: 'ready', sha: head, text: l0.text };
  } catch (e) {
    return { status: 'failed', sha: head, text: fallbackText(`карта не читается (${(e && e.message) || e})`) };
  }
}

// Cheap, synchronous, no building: what exists for the checked-out commit.
function mapStatus({ repoPath, workspacesRoot } = {}) {
  const root = resolveWorkspacesRoot(workspacesRoot);
  if (!repoPath) return { status: 'failed', sha: null, dir: null };
  const abs = path.resolve(repoPath);
  const sha = currentRevision(abs);
  if (!sha) return { status: 'failed', sha: null, dir: null };
  const dir = mapDirFor({ repoPath: abs, workspacesRoot: root, sha });
  return { status: isBuilt(dir) ? 'ready' : 'missing', sha, dir };
}

module.exports = { buildMap, renderMap, mapStatus };
