'use strict';

// Shared GitHub API client for the github_* skill (60-github.js), the pr_status /
// issue_status core (pr-status-core.js) and the 62-pr-status registration module.
//
// Extracted from 60-github.js so the token reader and the REST/GraphQL transport
// exist exactly once (two copies would silently drift on permission/headers).
// The error message format `GitHub API <status>: <msg>` is part of the public
// contract: tests/github-pr-checks.test.js asserts on it, so it is preserved
// even though the thrown object is now a typed GitHubApiError.
//
// Token setup: connect({ service: "github" }) → agent-tokens/<userId>/github.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readTokenValue } = require('../token-value');

const GH_API = 'https://api.github.com';
const USER_ID = process.env.USER_ID || '';

class GitHubApiError extends Error {
  constructor(message, status, reqPath) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = typeof status === 'number' ? status : null;
    this.path = reqPath || null;
  }
}

function tokenFilePath() {
  return USER_ID ? path.join(os.homedir(), 'agent-tokens', USER_ID, 'github') : null;
}

function hasToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  const p = tokenFilePath();
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

function getToken() {
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) return tok;
  const p = tokenFilePath();
  if (p) {
    try {
      if (fs.existsSync(p)) return readTokenValue(fs.readFileSync(p, 'utf8'));
    } catch { /* fall through to the error below */ }
  }
  throw new GitHubApiError(
    'GitHub токен не задан. Вызови github_connect — получишь защищённую ссылку для ввода токена без отправки в чат.',
    null,
    'token'
  );
}

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'trained-assist-agent',
  };
}

// REST GET/POST/… — same message format as before, but typed so callers can
// branch on `err.status` instead of grepping strings.
async function ghFetch(pathOrUrl, opts = {}) {
  const token = getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GH_API}${pathOrUrl}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(token), ...opts.headers },
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || res.statusText;
    const e = new GitHubApiError(`GitHub API ${res.status}: ${msg}`, res.status, pathOrUrl);
    const reset = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('x-ratelimit-reset') : null;
    e.headers = { 'x-ratelimit-reset': reset || '' };
    throw e;
  }
  if (res.status === 204) return null;
  // Stubbed responses in tests expose only json(); real fetch exposes both.
  if (typeof res.text !== 'function') return res.json();
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// Same authenticated GET as ghFetch, but the body is TEXT: workflow/job logs are
// served as plain text (and fetch follows the redirect to a signed URL), so
// res.json() would throw on them. Used by ci_run_branch to tail failed-job logs.
async function ghText(pathOrUrl, opts = {}) {
  const token = getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GH_API}${pathOrUrl}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(token), 'Accept': 'application/vnd.github+json', ...opts.headers },
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub API ${res.status}: ${body.slice(0, 200) || res.statusText}`, res.status, pathOrUrl);
  }
  return res.text();
}

// GraphQL `errors[0].type` → HTTP-ish status so callers share one error path.
const GQL_STATUS = { FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMITED: 429, UNAUTHORIZED: 401 };

async function ghGraphql(query, variables) {
  const token = getToken();
  const res = await fetch(`${GH_API}/graphql`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify({ query, variables: variables || {} }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.message) || res.statusText;
    throw new GitHubApiError(`GitHub API ${res.status}: ${msg}`, res.status, '/graphql');
  }
  const gqlErr = body && Array.isArray(body.errors) && body.errors[0];
  if (gqlErr) {
    const status = GQL_STATUS[gqlErr.type] || 400;
    throw new GitHubApiError(`GitHub API ${status}: ${gqlErr.message || gqlErr.type}`, status, '/graphql');
  }
  return body;
}

// Error → typed code for pr_status/issue_status (design §2 "Клиент").
function classify(err) {
  const status = typeof err === 'object' && err && typeof err.status === 'number' ? err.status : null;
  if (status === 401) return { code: 'GITHUB_AUTH' };
  if (status === 403 || status === 429) {
    const out = { code: 'RATE_LIMITED' };
    const reset = err.headers && err.headers['x-ratelimit-reset'];
    if (reset) out.reset_at = Number(reset);
    return out;
  }
  if (status === 404) return { code: 'NOT_FOUND' };
  if (status === null && err && /токен не задан/.test(String(err.message))) return { code: 'GITHUB_AUTH' };
  return { code: 'GITHUB_ERROR' };
}

module.exports = {
  GH_API,
  GitHubApiError,
  hasToken,
  getToken,
  ghFetch,
  ghText,
  ghGraphql,
  classify,
};
