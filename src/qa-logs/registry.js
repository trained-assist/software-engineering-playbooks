'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('./errors');

// A per-profile JSON registry of *where logs live and how to read them* — never
// the log contents and never raw credentials (README: "Raw credentials must not
// enter Task Packets; repository indexes; prompts; project manifests; logs.").
//
// Layout: <root>/<profile>.json with { schemaVersion, profile, logs: [entry] }.
// Root defaults to ~/agent-data/qa-logs and can be overridden per host with
// ENGINEERING_QA_LOGS_ROOT (used by the MCP tools and by tests for isolation).

const SCHEMA_VERSION = 1;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization)\b\s*[:=]\s*\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
];

function defaultRoot() {
  return path.join(os.homedir(), 'agent-data', 'qa-logs');
}

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function sanitizeProfile(profile) {
  const cleaned = String(profile || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..') fail('INVALID_PROFILE', `invalid profile: ${profile}`);
  return cleaned;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'log';
}

function registryFile({ profile, root }) {
  return path.join(root || defaultRoot(), `${sanitizeProfile(profile)}.json`);
}

function emptyRegistry(profile) {
  return { schemaVersion: SCHEMA_VERSION, profile: sanitizeProfile(profile), logs: [] };
}

function readRegistry(file, profile) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyRegistry(profile);
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.logs)) return emptyRegistry(profile);
    return data;
  } catch {
    fail('CORRUPT_REGISTRY', `corrupt qa-log registry: ${file}`);
  }
}

function writeRegistry(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function assertString(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    fail('INVALID_ENTRY', `${label} is required`);
  }
  if (typeof value !== 'string') fail('INVALID_ENTRY', `${label} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) fail('INVALID_ENTRY', `${label} must not be blank`);
  return trimmed;
}

function normalizeFields(fields) {
  if (fields === undefined || fields === null) return [];
  const list = Array.isArray(fields) ? fields : [fields];
  return list.map((f) => assertString(f, 'fields[]')).slice(0, 100);
}

function normalizeTtl(ttl) {
  if (ttl === undefined || ttl === null || ttl === '') return null;
  if (typeof ttl === 'number') {
    if (!Number.isFinite(ttl) || ttl < 0) fail('INVALID_ENTRY', 'ttl must be a non-negative number');
    return ttl;
  }
  return assertString(ttl, 'ttl');
}

function assertNoCredentialMaterial(entry) {
  const values = [];
  const walk = (value, key) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') values.push(`${key}=${value}`);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') for (const k of Object.keys(value)) walk(value[k], k);
  };
  walk(entry, 'entry');
  for (const value of values) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        fail('CREDENTIAL_REJECTED', 'qa-log entries must not contain raw secrets/credentials; store only where the log is and how to read it');
      }
    }
  }
}

function buildEntry(input) {
  const name = assertString(input.name, 'name');
  const location = assertString(input.location, 'location');
  const howToRead = assertString(input.how_to_read, 'how_to_read');
  const entry = {
    id: `${slug(name)}-${hash(`${name}@@${location}`).slice(0, 8)}`,
    name,
    location,
    ttl: normalizeTtl(input.ttl),
    fields: normalizeFields(input.fields),
    how_to_read: howToRead,
    owner: assertString(input.owner, 'owner', { required: false }),
    source: assertString(input.source, 'source', { required: false }),
  };
  assertNoCredentialMaterial(entry);
  return entry;
}

function registerLog({ profile, root, entry } = {}) {
  if (!profile) fail('INVALID_PROFILE', 'profile is required');
  if (!entry || typeof entry !== 'object') fail('INVALID_ENTRY', 'entry is required');
  const file = registryFile({ profile, root });
  const data = readRegistry(file, profile);
  const now = new Date().toISOString();
  const next = buildEntry(entry);
  const existing = data.logs.find((log) => log.id === next.id);
  if (existing) {
    Object.assign(existing, next, { added_at: existing.added_at || now, updated_at: now });
    writeRegistry(file, data);
    return { profile: data.profile, log: existing, updated: true };
  }
  next.added_at = now;
  data.logs.push(next);
  data.logs.sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
  writeRegistry(file, data);
  return { profile: data.profile, log: next, updated: false };
}

function searchableText(entry) {
  return [
    entry.name,
    entry.location,
    entry.owner,
    entry.source,
    entry.how_to_read,
    ...(entry.fields || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function lookupLogs({ profile, root, query, maxResults = 50 } = {}) {
  if (!profile) fail('INVALID_PROFILE', 'profile is required');
  const q = assertString(query, 'query');
  const file = registryFile({ profile, root });
  const data = readRegistry(file, profile);
  const needle = q.toLowerCase();
  const matches = data.logs
    .filter((entry) => searchableText(entry).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location))
    .slice(0, Math.max(0, Number(maxResults) || 50));
  return { profile: data.profile, query: q, count: matches.length, logs: matches };
}

function listLogs({ profile, root } = {}) {
  if (!profile) fail('INVALID_PROFILE', 'profile is required');
  const file = registryFile({ profile, root });
  const data = readRegistry(file, profile);
  const logs = [...data.logs].sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
  return { profile: data.profile, count: logs.length, logs };
}

module.exports = {
  SCHEMA_VERSION,
  defaultRoot,
  registryFile,
  registerLog,
  lookupLogs,
  listLogs,
};
