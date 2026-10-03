'use strict';

// Lexical matching layer for engineering_repo_find (#108).
//
// Scope: name / alias / description retrieval over a small in-memory catalog.
// Issue #108 explicitly does NOT require a vector engine for initial
// name/alias retrieval — dense semantics belong to #110 (engineering_repo_search).
// Everything here is deterministic: no network, no LLM, no randomness, so
// contract/replay tests can assert exact scores and reasons.

// RU → EN term bridge: catalog metadata (descriptions, purposes) is written in
// English, while queries arrive in Russian. Deliberately small and explicit —
// a domain glossary, not a translation layer.
const TERM_MAP = {
  'инструменты': ['tools', 'tool'], 'инструмент': ['tools', 'tool'],
  'рекрутер': ['recruiting', 'recruiter', 'hh'], 'рекрутера': ['recruiting', 'recruiter', 'hh'],
  'рекрутеров': ['recruiting', 'recruiter'], 'рекрутинг': ['recruiting'], 'рекрутинга': ['recruiting'],
  'найм': ['recruiting', 'hiring'], 'найма': ['recruiting', 'hiring'],
  'вакансия': ['vacancy', 'hh'], 'вакансии': ['vacancy', 'hh'], 'вакансий': ['vacancy', 'hh'],
  'кандидат': ['candidate', 'hh'], 'кандидата': ['candidate', 'hh'], 'кандидатов': ['candidate', 'hh'],
  'резюме': ['resume', 'cv'],
  'продажи': ['sales'], 'продаж': ['sales'], 'продажам': ['sales'],
  'клиенты': ['sales', 'crm'], 'клиентов': ['sales', 'crm'], 'сделка': ['deal'], 'сделки': ['deal'],
  'фриланс': ['freelance'],
  'документы': ['documents', 'doc'], 'документов': ['documents', 'doc'], 'договор': ['contract', 'documents'],
  'выставка': ['expo', 'exhibition'], 'выставки': ['expo', 'exhibition'], 'выставок': ['expo', 'exhibition'],
  'экспо': ['expo'],
  'речь': ['speech'], 'голос': ['speech', 'voice'], 'озвучка': ['speech', 'audio'],
  'транскрибация': ['transcription', 'speech'], 'распознавание': ['recognition', 'speech'],
  'поиск': ['search'], 'шлюз': ['gateway'], 'бот': ['bot'], 'телеграм': ['telegram', 'tg'],
  'плейбук': ['playbook'], 'плейбуки': ['playbooks'], 'процесс': ['process', 'workflow'],
  'сайт': ['web', 'site', 'landing'], 'лендинг': ['landing'], 'страница': ['page', 'site'],
  'оценка': ['estimate', 'complexity'], 'спецификация': ['spec'], 'тз': ['spec'],
  'логи': ['logs'], 'логов': ['logs'], 'журнал': ['logs'],
  'миграция': ['migration'], 'безопасность': ['security'],
  'деплой': ['deploy', 'deployment'], 'тесты': ['tests'], 'тестирование': ['tests', 'testing'],
  'база': ['database', 'db'], 'данные': ['data'], 'модель': ['model', 'llm'],
};

function camelSplit(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function splitTokens(text) {
  if (text === undefined || text === null) return [];
  return camelSplit(String(text))
    .toLowerCase()
    .split(/[^0-9a-zа-яёіїєґ]+/)
    .filter(Boolean);
}

function normalize(text) {
  return splitTokens(text).join(' ');
}

function expandTokens(tokens) {
  const out = new Set(tokens);
  for (const token of tokens) {
    for (const extra of (TERM_MAP[token] || [])) out.add(extra);
  }
  return [...out];
}

function termMatch(queryTerm, targets) {
  for (const target of targets) {
    if (target === queryTerm) return true;
    if (target.length >= 3 && queryTerm.length >= 3
      && (target.startsWith(queryTerm) || queryTerm.startsWith(target))) return true;
  }
  return false;
}

function matchedTerms(queryTokens, targets) {
  return queryTokens.filter(qt => termMatch(qt, targets));
}

// Returns { score, reasons } or null when the entry does not match at all.
// Scoring is tiered so an exact name beats a description coincidence, and a
// "no meaningful overlap" pair never reaches the caller (no invented repos).
function scoreRepo(entry, query) {
  const baseTokens = splitTokens(query);
  if (!baseTokens.length) return null;
  const queryTokens = expandTokens(baseTokens);
  const qNorm = baseTokens.join(' ');
  const reasons = [];
  let score = 0;

  const nameNorm = normalize(entry.name);
  const fullNorm = normalize(entry.full_name);
  if (qNorm === nameNorm || qNorm === fullNorm) {
    score = 100;
    reasons.push({ field: 'name', kind: 'exact' });
  } else {
    const aliasHit = (entry.aliases || []).find(alias => normalize(alias) === qNorm);
    if (aliasHit) {
      score = 95;
      reasons.push({ field: 'alias', kind: 'exact', alias: aliasHit });
    }
  }

  if (!score) {
    // full_name tokens (owner + repo) — an org query like "trained assist"
    // must reach every repository of that owner, not only ones that repeat
    // the owner's name in their own part.
    const nameTokens = splitTokens(entry.full_name);
    const aliasTokens = (entry.aliases || []).flatMap(splitTokens);
    const descTokens = splitTokens(`${entry.description || ''} ${entry.purposeText || ''}`);

    const mName = matchedTerms(queryTokens, nameTokens);
    const mAlias = matchedTerms(queryTokens, aliasTokens);
    const mDesc = matchedTerms(queryTokens, descTokens);

    if (!mName.length && !mAlias.length && !mDesc.length) return null;

    if (mName.length) {
      const all = mName.length === queryTokens.length;
      score += all ? 70 : 20 + mName.length * 12;
      reasons.push({ field: 'name', kind: all ? 'all_terms' : 'terms', matched: mName });
    }
    if (mAlias.length) {
      const all = mAlias.length === queryTokens.length;
      score += all ? 65 : 18 + mAlias.length * 10;
      reasons.push({ field: 'alias', kind: all ? 'all_terms' : 'terms', matched: mAlias });
    }
    if (mDesc.length) {
      score += Math.min(6 + mDesc.length * 7, 30);
      reasons.push({ field: 'description', kind: 'terms', matched: mDesc });
    }
    if (score < 10) return null;
  }

  return { score, reasons };
}

module.exports = { TERM_MAP, splitTokens, normalize, expandTokens, scoreRepo };
