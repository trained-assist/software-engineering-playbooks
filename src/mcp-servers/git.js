'use strict';

// The little bit of git the composition check needs: what revision is this
// checkout actually running, is it clean, and which repository is it.
//
// The host used to start the engineering MCP servers straight from a working
// tree with uncommitted changes — the running server was then a state that
// exists nowhere else and cannot be reproduced. "Pinned revision" means exactly
// this: HEAD is a known commit and the tree is clean.

const { execFileSync } = require('child_process');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// "https://github.com/org/repo.git" → "org/repo"; a local path → null.
function normalizeRepository(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match ? match[1] : null;
}

// The state of a checkout: HEAD, cleanliness, origin. Never throws.
function checkoutState(root) {
  const state = { root, head: null, clean: null, origin: null, repository: null, error: null };
  try {
    state.head = git(root, ['rev-parse', 'HEAD']);
    state.clean = git(root, ['status', '--porcelain']).length === 0;
    try { state.origin = git(root, ['remote', 'get-url', 'origin']); } catch { state.origin = null; }
    state.repository = normalizeRepository(state.origin);
  } catch (error) {
    state.error = error.message;
  }
  return state;
}

// Resolve a tag or a sha to a commit sha inside the checkout. Returns null when
// the ref is unknown (a tag that was never fetched, a typo in a sha).
function resolveRef(root, ref) {
  if (!ref) return null;
  try {
    return git(root, ['rev-parse', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

module.exports = { checkoutState, resolveRef, normalizeRepository };
