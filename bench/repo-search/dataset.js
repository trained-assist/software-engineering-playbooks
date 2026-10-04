'use strict';

// Labeled retrieval benchmark, 34 queries against a REAL checkout
// (trained-assist-agent). Four classes, because they fail differently:
//   exact    — the identifier itself; string equality should win
//   ru_en    — Russian question, English identifiers (the cross-lingual case)
//   behavior — "where does X happen", no identifier in the query
//   absent   — a mechanism the repository does NOT have; expected behaviour is
//              an honest empty answer, never a confident "not implemented"
//
// Every expectation is machine-verifiable: `contains` must occur inside the
// expected file, and every `absent_token` must occur NOWHERE in the repo.
// A dataset whose labels rot is worse than no dataset — `npm run bench:repo-search
// -- --integrity` fails instead of reporting fake numbers.

const TARGET_REPO = 'trained-assist-agent';

const DATASET = [
  // exact identifiers (16)
  { id: 'exact-01', cls: 'exact', query: 'atomicJson', expect: [{ path: 'src/atomic-json.js', contains: 'function atomicJson' }] },
  { id: 'exact-02', cls: 'exact', query: 'deriveIdempotencyKey', expect: [{ path: 'src/mcp-action-broker.js', contains: 'deriveIdempotencyKey' }] },
  { id: 'exact-03', cls: 'exact', query: 'isZeroCredsPreflight', expect: [{ path: 'src/zerocreds-preflight.js', contains: 'isZeroCredsPreflight' }] },
  { id: 'exact-04', cls: 'exact', query: 'withDedupLock', expect: [{ path: 'src/request-dedup-lock.js', contains: 'withDedupLock' }] },
  { id: 'exact-05', cls: 'exact', query: 'canonicalizePublicLinks', expect: [{ path: 'src/public-links.js', contains: 'canonicalizePublicLinks' }] },
  { id: 'exact-06', cls: 'exact', query: 'renderDomainView', expect: [{ path: 'src/domain-surface.js', contains: 'renderDomainView' }] },
  { id: 'exact-07', cls: 'exact', query: 'checkCompleteness', expect: [{ path: 'src/intake-gate.js', contains: 'checkCompleteness' }] },
  { id: 'exact-08', cls: 'exact', query: 'recordUsage', expect: [{ path: 'src/usage-store.js', contains: 'recordUsage' }] },
  { id: 'exact-09', cls: 'exact', query: 'criterionIdForItem', expect: [{ path: 'src/durable-task-plan.js', contains: 'criterionIdForItem' }] },
  { id: 'exact-10', cls: 'exact', query: 'computeMaxIterations', expect: [{ path: 'src/gtd-controller.js', contains: 'computeMaxIterations' }] },
  { id: 'exact-11', cls: 'exact', query: 'buildClarifyBlock', expect: [{ path: 'src/answer-router.js', contains: 'buildClarifyBlock' }] },
  { id: 'exact-12', cls: 'exact', query: 'TG_MAX_LEN', expect: [{ path: 'src/tg-format.js', contains: 'TG_MAX_LEN' }] },
  { id: 'exact-13', cls: 'exact', query: 'backoffFor', expect: [{ path: 'src/model-health.js', contains: 'backoffFor' }] },
  { id: 'exact-14', cls: 'exact', query: 'resolveStepExecution', expect: [{ path: 'src/playbook-executor.js', contains: 'resolveStepExecution' }] },
  { id: 'exact-15', cls: 'exact', query: 'archiveSessions', expect: [{ path: 'src/session-store.js', contains: 'archiveSessions' }] },
  { id: 'exact-16', cls: 'exact', query: 'parseTypedName', expect: [{ path: 'src/projects.js', contains: 'parseTypedName' }] },

  // RU question → English identifier (6)
  { id: 'ru-01', cls: 'ru_en', query: 'где блокируется запуск задачи, если она уже выполняется', expect: [{ path: 'src/execution-owner-lock.js' }] },
  { id: 'ru-02', cls: 'ru_en', query: 'где чистится формат сообщений Telegram и лимит длины', expect: [{ path: 'src/tg-format.js' }] },
  { id: 'ru-03', cls: 'ru_en', query: 'где хранятся токены пользователя для внешних сервисов', expect: [{ path: 'src/user-tokens.js' }] },
  { id: 'ru-04', cls: 'ru_en', query: 'где считается, что проект соответствует типу', expect: [{ path: 'src/project-match.js' }] },
  { id: 'ru-05', cls: 'ru_en', query: 'где собирается краткая сводка сессии', expect: [{ path: 'src/session-summary.js' }] },
  { id: 'ru-06', cls: 'ru_en', query: 'где определяется готовность окружения к запуску', expect: [{ path: 'src/readiness.js' }] },

  // behaviors, no identifier in the query (6)
  { id: 'behavior-01', cls: 'behavior', query: 'движок упал почти без вывода — это терминальный краш или пробуем другого провайдера', expect: [{ path: 'src/engine-crash-policy.js' }] },
  { id: 'behavior-02', cls: 'behavior', query: 'как определяется класс сбоя движка и какие сбои можно повторять', expect: [{ path: 'src/failure-classifier.js' }, { path: 'src/failure-taxonomy.js' }] },
  { id: 'behavior-03', cls: 'behavior', query: 'как восстанавливается переписка прошлых сессий того же чата и топика', expect: [{ path: 'src/chat-history.js' }] },
  { id: 'behavior-04', cls: 'behavior', query: 'где вычисляются пути профиля: users, agent-data и токены', expect: [{ path: 'src/data-paths.js' }] },
  { id: 'behavior-05', cls: 'behavior', query: 'где хранится durable-задача и статусы её пунктов', expect: [{ path: 'src/durable-task-store.js' }] },
  { id: 'behavior-06', cls: 'behavior', query: 'где удаляются старые медиафайлы из папки приёма по TTL', expect: [{ path: 'src/intake-media-retention.js' }] },

  // absent mechanisms (6) — an honest empty answer is the correct one
  { id: 'absent-01', cls: 'absent', query: 'где хранится история платежей и подписок Stripe', expectNoMatch: true, absent_token: 'stripe' },
  { id: 'absent-02', cls: 'absent', query: 'где настроена отправка метрик в Datadog', expectNoMatch: true, absent_token: 'datadog' },
  { id: 'absent-03', cls: 'absent', query: 'где обучается модель на фидбеке пользователя', expectNoMatch: true, absent_token: 'finetune' },
  { id: 'absent-04', cls: 'absent', query: 'где реализована запись экрана пользователя', expectNoMatch: true, absent_token: 'screen_recording' },
  { id: 'absent-05', cls: 'absent', query: 'где хранится граф знаний о пользователе', expectNoMatch: true, absent_token: 'knowledge_graph' },
  { id: 'absent-06', cls: 'absent', query: 'где реализован векторный поиск по эмбеддингам в коде агента', expectNoMatch: true, absent_token: 'embeddings' },
];

module.exports = { TARGET_REPO, DATASET, CLASSES: ['exact', 'ru_en', 'behavior', 'absent'] };