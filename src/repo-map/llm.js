'use strict';

// One-line module descriptions for L0 — the only place a model is used, and
// only ever as a refinement: without a key, without network, or after any
// error the map simply renders structure. The key is read at call time (never
// cached at load), the result is cached per module content hash so a merge that
// touches one module only re-describes that module.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_MODEL_CHARS = 140;
const CONCURRENCY = 4;
const TIMEOUT_MS = 8000;

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

function moduleNameOf(file) {
  const i = file.indexOf('/');
  return i === -1 ? '(root)' : file.slice(0, i);
}

function moduleHash(files) {
  const digest = crypto.createHash('sha1');
  for (const file of files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(`${file.path}:${file.size}:${file.head}\n`);
  }
  return digest.digest('hex').slice(0, 20);
}

function readCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cacheFile, cache) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(tmp, cacheFile);
}

function promptFor(moduleName, repoName, files) {
  const evidence = files.slice(0, 6)
    .map((f) => `${f.path}${f.head ? ` — ${f.head.slice(0, 90)}` : ''}`)
    .join('\n');
  return [
    `Repository: ${repoName}. Module directory: ${moduleName}/.`,
    'Answer with ONE line, max 120 characters, in Russian, no quotes and no trailing period:',
    'what this module is responsible for.',
    evidence,
  ].join('\n');
}

async function callModel(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: process.env.REPO_MAP_LLM_MODEL || 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 160,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) return null;
    const line = content.trim().split('\n')[0].replace(/^["'`\s]+|["'`\s]+$/g, '');
    return line.slice(0, MAX_MODEL_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { descriptions: {moduleName: line}, available: boolean }.
// `available` is true only when a description actually exists for at least one
// module — that is what the L0 header reports.
async function describeModules({ index, cacheFile }) {
  const descriptions = {};
  const key = apiKey();
  if (!key) return { descriptions, available: false };

  const byModule = new Map();
  for (const file of index.files || []) {
    const mod = moduleNameOf(file.path);
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push(file);
  }

  const cache = readCache(cacheFile);
  const repoName = (index.meta.repository && index.meta.repository.name) || 'repository';
  const pending = [];
  for (const [mod, files] of byModule) {
    const hash = moduleHash(files);
    const cached = cache[mod];
    if (cached && cached.hash === hash && cached.text) {
      descriptions[mod] = cached.text;
      continue;
    }
    pending.push({ mod, files, hash });
  }

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => ({ item, text: await callModel(promptFor(item.mod, repoName, item.files)) })),
    );
    for (const { item, text } of results) {
      if (!text) continue;
      descriptions[item.mod] = text;
      cache[item.mod] = { hash: item.hash, text };
    }
  }

  if (pending.length) {
    try { writeCache(cacheFile, cache); } catch { /* cache is an optimisation only */ }
  }
  return { descriptions, available: Object.keys(descriptions).length > 0 };
}

module.exports = { describeModules, moduleHash, apiKey };
