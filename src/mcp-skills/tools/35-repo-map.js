'use strict';

// repo_map — the compressed repository map (L0/L1), issue #49.
//
// First call of any exploration: L0 for orientation (<1s from cache, ≤2k
// tokens), then L1 with a focus to pick the exact files, then plain reading.
// The tool never returns an empty body (agent#1481): every failure path
// explains the status and points at reading the raw repository.

const { renderMap, mapStatus } = require('../../repo-map');

const DESCRIPTION = [
  'Compressed repository map: level 0 = module/entry-point overview in ≤2k tokens (<1s from cache),',
  'level 1 = file skeleton with signatures, optionally re-ranked by focus (symbol or path substrings).',
  'Call this BEFORE rummaging through files: L0 → L1(focus) → read the 1–5 files you actually need.',
  'Never returns an empty answer; a failed/missing map tells you to fall back to reading the repository.',
].join(' ');

const tool = {
  name: 'repo_map',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Path to the target repository checkout (worktree or clone).' },
      repo_path: { type: 'string', description: 'Alias of repo, for callers that use repo_path elsewhere.' },
      level: { type: ['number', 'integer'], description: '0 (default) = map, 1 = skeleton.' },
      focus: {
        description: 'Symbol names or path fragments that should float to the top of an L1 skeleton.',
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      sha: { type: 'string', description: 'Optional guard: only answer for this commit; otherwise you get an explicit mismatch status.' },
    },
  },
  handler: async ({ repo, repo_path, level, focus, sha } = {}) => {
    const result = await renderMap({
      repoPath: repo || repo_path,
      level: level === undefined || level === null ? 0 : level,
      focus,
      sha,
    });
    const short = result.sha ? String(result.sha).slice(0, 8) : 'n/a';
    const status = `repo_map status=${result.status} sha=${short} level=${Number(level || 0)}`;
    if (result.status !== 'ready') {
      return `${status}\n${result.text}`;
    }
    const extra = mapStatus({ repoPath: repo || repo_path });
    const cached = extra && extra.status === 'ready' ? 'cache=hit' : 'cache=built';
    return `${status} ${cached}\n${result.text}`;
  },
};

module.exports = [tool];
