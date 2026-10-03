'use strict';

// Verification verdicts as a FACT on disk (#112).
//
// «Проверено» is the easiest stage to fake: a chat message, a plausible claim,
// a green CI. So this stage never produces a verdict of its own — it only reads
// what engineering_verify (#113) recorded, and it judges freshness itself:
// a record for a different commit or a different revision of the requirements
// is `not_satisfied: stale`, not `satisfied` and not `unknown`.
//
// Record shape (written by #113, read here):
//   { schemaVersion, principal, repositoryId, changeKey, change:{kind,…},
//     verdict, commit, requirements_ref, requirements_revision, verified_at,
//     source, evidence[] }
//
// The key is owner+repo+change, exactly like bindings: one profile's verdict is
// invisible to another, and another profile cannot overwrite it.

const path = require('path');
const store = require('../workspace/store');
const { resolveRoot } = require('../change-find/local');

function verificationKey(principal, repositoryId, changeKey) {
  return `${principal}\0${repositoryId}\0${String(changeKey || '').toLowerCase()}`;
}

/**
 * Candidate keys for one change, most specific first. A PR #115 may have been
 * verified as `pr:115`, but also as the branch or the commit it carried — all
 * three are the same change from the caller's point of view, and the most
 * specific record wins.
 */
function candidateKeys(kind, { number, sha, branch, url } = {}) {
  const keys = [];
  if (kind === 'pull' && number) keys.push(`pr:${number}`);
  if (sha) keys.push(`commit:${sha.toLowerCase()}`, `sha:${sha.toLowerCase()}`);
  if (branch) keys.push(`branch:${branch}`);
  if (url) {
    const m = String(url).match(/\/pull\/(\d+)/);
    if (m) keys.push(`pr:${m[1]}`);
  }
  const seen = new Set();
  return keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
}

function readOne({ workspaceRoot, principal, repositoryId, changeKey }) {
  if (!principal) return null;
  const root = resolveRoot(workspaceRoot);
  const rec = store.readJsonSafe(store.verificationFile(root, verificationKey(principal, repositoryId, changeKey)));
  return rec && rec.principal === principal ? rec : null;
}

/**
 * @returns {{found:boolean, record?:object, key?:string, source?:string,
 *            requirements_ref?:string, note?:string}}
 */
function readVerification({ workspaceRoot, principal, repositoryId, kind, change = {}, requirementsRef = null }) {
  const keys = candidateKeys(kind, change);
  for (const key of keys) {
    const rec = readOne({ workspaceRoot, principal, repositoryId, changeKey: key });
    if (rec) return { found: true, record: rec, key, source: rec.source || 'verification-store', requirements_ref: requirementsRef || null };
  }
  return {
    found: false,
    requirements_ref: requirementsRef || null,
    note: keys.length
      ? `в хранилище этого профиля нет записи верификации для ${keys.join(', ')}`
      : 'не удалось построить ключ изменения для поиска записи верификации',
  };
}

/** Key helper exported so #113 writes into exactly this slot. */
function verificationSlot({ workspaceRoot, principal, repositoryId, kind, change = {} }) {
  const keys = candidateKeys(kind, change);
  if (!keys.length) return null;
  const root = resolveRoot(workspaceRoot);
  return { root, dir: store.storeDirs(root).verifications, file: store.verificationFile(root, verificationKey(principal, repositoryId, keys[0])), changeKey: keys[0] };
}

module.exports = { verificationKey, candidateKeys, readVerification, readOne, verificationSlot, resolveRoot: p => path.resolve(p) };