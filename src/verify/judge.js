'use strict';

// Semantic judge for engineering_verify (#113) — the SECOND source of a
// verdict, never the first and never the only one available to it.
//
// Contract:
//   - the judge only ever classifies the requirements it is handed: it returns
//     {id, verdict, rationale} per id and nothing else. Whatever it writes into
//     `text` / `requirement` / invented ids is dropped here, so a model cannot
//     rewrite accepted requirements to make them pass (AC #113);
//   - «неизвестно» — честный ответ модели: если evidence не позволяет
//     судить, модель отвечает unknown, а не «satisfied» по духу;
//   - любой сбой (нет ключа, таймаут, HTTP-ошибка, не разобранный JSON) —
//     available:false с кодом. Это inconclusive сверху, а не fail и не pass:
//     сбой судьи ≠ провал требования (#122).

const DEFAULT_MODEL = process.env.VERIFY_JUDGE_MODEL || 'google/gemini-2.5-flash';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 20_000;
const VERDICTS = new Set(['satisfied', 'not_satisfied', 'unknown']);

function key() {
  const k = process.env.OPENROUTER_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

function systemPrompt() {
  return [
    'You are a verification judge. You are given ACCEPTED REQUIREMENTS and EVIDENCE collected by deterministic checks.',
    'The requirements are READ-ONLY: never reword, merge, split, add or drop them, even if they seem wrong. Answer only about the ids you were given.',
    'Verdicts: "satisfied" — the evidence proves this requirement at the pinned revision; "not_satisfied" — the evidence proves it is not implemented; "unknown" — the evidence does not decide it (missing, inaccessible, ambiguous).',
    'Absence of evidence is never "satisfied" and never "not_satisfied".',
    'Reply with ONLY a JSON array, no prose, no code fences:',
    '[{"id":"R1","verdict":"satisfied|not_satisfied|unknown","rationale":"one short sentence with the evidence you used"}]',
  ].join('\n');
}

function userPrompt({ items, evidenceText, targetText, scope }) {
  return [
    `Scope: ${scope}`,
    `Pinned target: ${targetText}`,
    '',
    'Requirements (read-only):',
    ...items.map((i) => `${i.id}${i.required ? '' : ' (optional)'}: ${i.text}`),
    '',
    'Evidence:',
    evidenceText || '(no deterministic evidence was collected)',
  ].join('\n');
}

function extractJsonArray(raw) {
  const text = String(raw || '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{available:true, model, results:Object}|{available:false, reason}>}
 */
async function judge({ items, evidenceText = '', targetText = '', scope = 'implementation', model = null, fetchImpl = null, apiKey = null, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Array.isArray(items) || !items.length) return { available: false, reason: 'judge-unavailable:NO_REQUIREMENTS' };
  const token = apiKey !== null ? apiKey : key();
  if (!token) return { available: false, reason: 'judge-unavailable:NO_API_KEY' };
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') return { available: false, reason: 'judge-unavailable:NO_FETCH' };

  const chosen = model || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let raw;
  try {
    const res = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: chosen,
        temperature: 0,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt({ items, evidenceText, targetText, scope }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      return { available: false, reason: `judge-unavailable:HTTP_${res ? res.status : 'NO_RESPONSE'}` };
    }
    const body = await res.json();
    raw = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null;
  } catch (e) {
    return { available: false, reason: `judge-unavailable:${e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'}` };
  } finally {
    clearTimeout(timer);
  }

  const parsed = extractJsonArray(raw);
  if (!parsed) return { available: false, reason: 'judge-unavailable:UNPARSEABLE_OUTPUT' };

  const known = new Set(items.map((i) => i.id));
  const results = {};
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!known.has(id) || results[id]) continue; // invented or duplicate ids are dropped
    const verdict = VERDICTS.has(row.verdict) ? row.verdict : 'unknown';
    results[id] = {
      verdict,
      rationale: typeof row.rationale === 'string' ? row.rationale.slice(0, 400) : '',
      // deliberate: any `text` / `requirement` the model echoes back is NOT stored
    };
  }
  return { available: true, model: chosen, results };
}

module.exports = { judge, extractJsonArray, DEFAULT_MODEL, VERDICTS };
