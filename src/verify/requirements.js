'use strict';

// Accepted requirements for engineering_verify (#113).
//
// Everything here runs BEFORE any model is called: the requirements are frozen
// into a canonical item list with a content hash, and the hash travels into the
// receipt. A judge that answers «satisfied» cannot rewrite what was asked —
// its output is matched by id against this list, and any id or text it invents
// is dropped (AC #113: «модель-судья не имеет права обновлять accepted
// requirements ради pass»).
//
// Two sources, one shape:
//   - explicit: the caller passes the requirements; the generated ref is
//     `explicit@<hash>` so a later call with different wording is a different
//     revision and the old receipt reads as stale;
//   - issue#N[@rev] / file:<path>[@rev]: the service reads the source itself.
//     The model is never the source of what is verified.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 50;
const MAX_TEXT = 1500;

function fail(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details) e.details = details;
  return e;
}

/** Content hash of the frozen list — the receipt's binding to the wording. */
function hashRequirements(items) {
  return crypto.createHash('sha256')
    .update(items.map((i) => `${i.id}\u0000${i.required ? 1 : 0}\u0000${i.text}`).join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function normalizeChecks(raw, where) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw fail('INVALID_CHECKS', `${where}: checks must be an array`);
  return raw.map((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.kind !== 'string' || !c.kind.trim()) {
      throw fail('INVALID_CHECKS', `${where}: checks[${i}] must be an object with a string kind`);
    }
    const out = { ...c, kind: c.kind.trim() };
    if (out.kind === 'command' && typeof out.command === 'string' && out.command.trim()) {
      out.command = out.command.trim();
    } else if (out.kind === 'command') {
      throw fail('INVALID_CHECKS', `${where}: checks[${i}] of kind "command" needs a command string`);
    }
    if ((out.kind === 'workspace_file' || out.kind === 'file_at_commit') && typeof out.path !== 'string') {
      throw fail('INVALID_CHECKS', `${where}: checks[${i}] of kind "${out.kind}" needs a path`);
    }
    return out;
  });
}

function evidenceFor(checks, declared) {
  if (declared === 'receipt' || declared === 'output' || declared === 'existence') return declared;
  if (!checks.length) return 'receipt';
  // A check that runs a command demands output; a requirement built purely out
  // of local file presence really is about presence. Everything else defaults
  // to «a typed tool receipt» — bare existence never closes it (AC #113).
  if (checks.some((c) => c.kind === 'command')) return 'output';
  if (checks.every((c) => c.kind === 'workspace_file')) return 'existence';
  return 'receipt';
}

function normalizeItem(raw, index, explicit) {
  const where = `requirements[${index}]`;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) throw fail('INVALID_REQUIREMENTS', `${where}: empty requirement text`);
    return { id: `R${index + 1}`, text: text.slice(0, MAX_TEXT), required: true, evidence: 'receipt', checks: [] };
  }
  if (!raw || typeof raw !== 'object') {
    throw fail('INVALID_REQUIREMENTS', `${where}: a requirement is a string or an object {text, id?, required?, evidence?, checks?}`);
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) throw fail('INVALID_REQUIREMENTS', `${where}: text is required`);
  if (explicit && typeof raw.id === 'string' && raw.id.trim()) {
    // ids must be unique — the judge addresses items by id.
    raw.id = raw.id.trim();
  }
  const checks = normalizeChecks(raw.checks, where);
  return {
    id: (typeof raw.id === 'string' && raw.id.trim()) || `R${index + 1}`,
    text: text.slice(0, MAX_TEXT),
    required: raw.required !== false,
    evidence: evidenceFor(checks, raw.evidence),
    checks,
  };
}

function assertUniqueIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw fail('INVALID_REQUIREMENTS', `duplicate requirement id "${item.id}" — the judge addresses items by id`);
    seen.add(item.id);
  }
}

function normalizeExplicit(list) {
  if (!Array.isArray(list) || !list.length) {
    throw fail('INVALID_REQUIREMENTS', 'requirements must be a non-empty array (or pass requirements_ref instead)');
  }
  if (list.length > MAX_ITEMS) throw fail('INVALID_REQUIREMENTS', `requirements is capped at ${MAX_ITEMS} items, got ${list.length}`);
  const items = list.map((raw, i) => normalizeItem(raw, i, true));
  assertUniqueIds(items);
  return items;
}

// issue#112 · issue#112@3 · file:docs/req.md · file:docs/req.md@2026-10-03
const ISSUE_RE = /^issue#(\d+)(?:@(.{1,80}))?$/i;
const FILE_RE = /^file:(.+?)(?:@(.{1,80}))?$/i;

function parseRequirementsRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw fail('INVALID_REQUIREMENTS_REF', 'requirements_ref is required, e.g. «issue#113» or «file:docs/req.md@rev»');
  const issue = raw.match(ISSUE_RE);
  if (issue) return { source: 'issue', number: Number(issue[1]), revision: issue[2] || null, raw };
  const file = raw.match(FILE_RE);
  if (file) return { source: 'file', path: file[1].trim(), revision: file[2] || null, raw };
  throw fail('UNSUPPORTED_REQUIREMENTS_REF',
    `unsupported requirements_ref «${raw}» — use «issue#<n>[@<rev>]» or «file:<path>[@<rev>]»`);
}

/** Markdown list items become requirements; a body without lists is one item. */
function itemsFromIssueBody(body) {
  const text = String(body || '').replace(/\r/g, '').trim();
  if (!text) return [];
  const withoutCode = text.replace(/```[\s\S]*?```/g, '');
  const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
  const lines = withoutCode.split('\n');
  const listTexts = lines
    .filter((l) => LIST_RE.test(l))
    .map((l) => l.replace(LIST_RE, '').trim());
  const chosen = listTexts.length ? listTexts : [withoutCode.trim()];
  const uniq = [];
  const seen = new Set();
  for (const line of chosen) {
    const t = line.trim().slice(0, MAX_TEXT);
    if (t.length < 8 || seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }
  return uniq.slice(0, MAX_ITEMS);
}

/**
 * Resolve the requirements into the frozen item list.
 * @returns {{items, requirements_ref, source, source_revision, revision}}
 *   `revision` is what the receipt stores and what change_status compares
 *   against: the caller's ref verbatim, or the generated `explicit@<hash>`.
 */
async function resolveRequirements(input = {}, deps = {}) {
  const ghFetch = deps.ghFetch;
  const explicit = input.requirements;

  if (explicit !== undefined && explicit !== null && input.requirements_ref) {
    throw fail('INVALID_REQUIREMENTS', 'pass either requirements or requirements_ref, not both');
  }

  if (explicit !== undefined && explicit !== null) {
    const items = normalizeExplicit(explicit);
    const hash = hashRequirements(items);
    return { items, requirements_ref: `explicit@${hash}`, source: 'explicit', source_revision: hash, revision: `explicit@${hash}` };
  }

  const parsed = parseRequirementsRef(input.requirements_ref);
  let body = null;
  let sourceRevision = parsed.revision;

  if (parsed.source === 'issue') {
    if (!input.repo) throw fail('INVALID_REPO', 'repo is required with an issue# requirements_ref: pass repo="owner/name"');
    if (typeof ghFetch !== 'function') throw fail('INVALID_DEPS', 'ghFetch is required to read an issue requirements source');
    let issue;
    try {
      issue = await ghFetch(`/repos/${input.repo}/issues/${parsed.number}`);
    } catch (e) {
      // Access problems are not «the requirements do not exist»: they fail
      // honestly with their own code, never as an empty requirement set.
      const err = fail('REQUIREMENTS_SOURCE_UNREADABLE',
        `requirements source ${parsed.raw} could not be read: ${e && e.message ? e.message : e}`);
      err.cause = e;
      throw err;
    }
    body = issue.body;
    if (!sourceRevision) sourceRevision = issue.updated_at || null;
  } else {
    const file = path.resolve(parsed.path);
    if (!fs.existsSync(file)) throw fail('REQUIREMENTS_SOURCE_UNREADABLE', `requirements file not found: ${file}`);
    body = fs.readFileSync(file, 'utf8');
  }

  const lines = itemsFromIssueBody(body);
  if (!lines.length) throw fail('EMPTY_REQUIREMENTS', `requirements source ${parsed.raw} contains no requirement text`);
  const items = normalizeExplicit(lines);
  return {
    items,
    requirements_ref: parsed.raw,
    source: parsed.source,
    source_revision: sourceRevision,
    revision: parsed.raw,
  };
}

module.exports = {
  MAX_ITEMS,
  resolveRequirements,
  normalizeExplicit,
  parseRequirementsRef,
  itemsFromIssueBody,
  hashRequirements,
};
