import { isSupportedEvent, normalizeDelivery } from './normalize.mjs';

const MAX_BODY_BYTES = 1_048_576;
const DELIVERY_ID_RE = /^[0-9a-f-]{16,80}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function validSignature(secret, rawBody, signatureHeader) {
  const match = typeof signatureHeader === 'string' && signatureHeader.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match || typeof secret !== 'string' || secret.length < 32) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(match[1].match(/.{2}/g), byte => Number.parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, signature, rawBody);
}

export async function handleWebhook(request, env, now = () => new Date()) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.GITHUB_WEBHOOK_SECRET || env.GITHUB_WEBHOOK_SECRET.length < 32 || !env.GITHUB_EVENTS) {
    return json({ error: 'relay_misconfigured' }, 503);
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);

  if (!await validSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, request.headers.get('x-hub-signature-256'))) {
    return json({ error: 'invalid_signature' }, 401);
  }

  const eventId = request.headers.get('x-github-delivery') || '';
  const eventType = request.headers.get('x-github-event') || '';
  if (!DELIVERY_ID_RE.test(eventId)) return json({ error: 'invalid_delivery_id' }, 400);
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
  catch { return json({ error: 'invalid_json' }, 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json({ error: 'invalid_payload' }, 400);

  if (!isSupportedEvent(eventType)) return json({ accepted: true, ignored: true, reason: 'unsupported_event' }, 202);
  const envelope = normalizeDelivery({
    eventId,
    eventType,
    action: payload.action ?? payload.state ?? null,
    receivedAt: now().toISOString(),
    payload,
  });
  if (!envelope) return json({ error: 'invalid_event_scope' }, 422);

  try {
    await env.GITHUB_EVENTS.send(envelope, { contentType: 'json' });
  } catch {
    // GitHub retries because no durable queue acceptance was confirmed.
    return json({ error: 'queue_unavailable' }, 503);
  }
  return json({ accepted: true, event_id: envelope.event_id }, 202);
}

function validRepoName(value) {
  return typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
}

function authorized(request, env) {
  const token = env.MCP_EVENT_TOKEN;
  return typeof token === 'string' && token.length >= 32
    && request.headers.get('authorization') === `Bearer ${token}`;
}

function channelFor(repo, env) {
  const id = env.GITHUB_EVENT_CHANNELS.idFromName(repo.toLowerCase());
  return env.GITHUB_EVENT_CHANNELS.get(id);
}

export async function handleEventStream(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  if (!env.GITHUB_EVENT_CHANNELS) return json({ error: 'relay_misconfigured' }, 503);
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');
  if (!validRepoName(repo)) return json({ error: 'invalid_repo' }, 400);

  const response = await channelFor(repo, env).fetch('https://channel/subscribe', {
    headers: {
      upgrade: 'websocket',
      'x-repository': repo,
      ...(request.headers.get('last-event-id') ? { 'last-event-id': request.headers.get('last-event-id') } : {}),
    },
  });
  if (response.status !== 101 || !response.webSocket) return json({ error: 'event_channel_unavailable' }, 503);
  const socket = response.webSocket;
  const encoder = new TextEncoder();
  let heartbeat;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); }
        catch { clearInterval(heartbeat); }
      }, 25_000);
      socket.addEventListener('message', event => {
        try {
          const packet = JSON.parse(String(event.data));
          controller.enqueue(encoder.encode(`id: ${packet.cursor}\ndata: ${JSON.stringify(packet.event)}\n\n`));
        }
        catch { clearInterval(heartbeat); }
      });
      socket.addEventListener('close', () => {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* stream already cancelled */ }
      });
      socket.addEventListener('error', () => {
        clearInterval(heartbeat);
        try { controller.error(new Error('event_channel_closed')); } catch { /* stream already cancelled */ }
      });
      try {
        const cursor = request.headers.get('last-event-id');
        socket.send(JSON.stringify({ type: 'resume', after: cursor === null ? null : Number(cursor) }));
      } catch {
        clearInterval(heartbeat);
        try { controller.error(new Error('event_channel_resume_failed')); } catch { /* stream already cancelled */ }
      }
    },
    cancel() {
      clearInterval(heartbeat);
      try { socket.close(1000, 'subscriber disconnected'); } catch { /* already closed */ }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

export async function handleQueue(batch, env) {
  if (!env.GITHUB_EVENT_CHANNELS) throw new Error('event_channel_not_configured');
  await Promise.all(batch.messages.map(async message => {
    try {
      const repo = message.body?.repository_full_name;
      if (!validRepoName(repo)) throw new Error('invalid_repository');
      const response = await channelFor(repo, env).fetch('https://channel/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-repository': repo },
        body: JSON.stringify(message.body),
      });
      if (!response.ok) throw new Error(`channel_http_${response.status}`);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
      console.error(JSON.stringify({ event: 'github_event_fanout_retry', eventId: message.body?.event_id || null }));
    }
  }));
}

export class GitHubEventChannel {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS github_event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      received_at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS github_event_log_event_id ON github_event_log(event_id)');
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS github_event_log_received_at ON github_event_log(received_at)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/subscribe') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/publish' && request.method === 'POST') {
      const event = await request.json();
      const repo = request.headers.get('x-repository');
      if (!validRepoName(repo) || event.repository_full_name?.toLowerCase() !== repo.toLowerCase()) {
        return json({ error: 'repository_mismatch' }, 400);
      }
      const receivedAt = Date.now();
      const payload = JSON.stringify(event);
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO github_event_log(event_id, event_json, received_at) VALUES(?, ?, ?)',
        event.event_id,
        payload,
        receivedAt,
      );
      this.ctx.storage.sql.exec('DELETE FROM github_event_log WHERE received_at < ?', Date.now() - 24 * 60 * 60 * 1000);
      this.ctx.storage.sql.exec(`DELETE FROM github_event_log WHERE seq NOT IN (
        SELECT seq FROM github_event_log ORDER BY seq DESC LIMIT 5000
      )`);
      const stored = this.ctx.storage.sql.exec(
        'SELECT seq, event_json FROM github_event_log WHERE event_id = ?', event.event_id,
      ).toArray()[0];
      if (!stored) return json({ error: 'event_store_failed' }, 503);
      const packet = JSON.stringify({ cursor: stored.seq, event: JSON.parse(stored.event_json) });
      let sent = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(packet); sent += 1; }
        catch { try { socket.close(1011, 'delivery failed'); } catch { /* stale socket */ } }
      }
      return json({ accepted: true, cursor: stored.seq, subscribers: sent });
    }
    return json({ error: 'not_found' }, 404);
  }

  webSocketMessage(socket, message) {
    let command;
    try { command = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return; }
    if (command?.type !== 'resume') return;
    const latestCursor = this.ctx.storage.sql.exec('SELECT COALESCE(MAX(seq), 0) AS seq FROM github_event_log').toArray()[0]?.seq || 0;
    const parsed = command.after === null ? latestCursor : Number(command.after);
    const after = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : latestCursor;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const backlog = this.ctx.storage.sql.exec(
      'SELECT seq, event_json FROM github_event_log WHERE seq > ? AND received_at >= ? ORDER BY seq LIMIT 5000',
      after,
      cutoff,
    ).toArray();
    for (const row of backlog) {
      try { socket.send(JSON.stringify({ cursor: row.seq, event: JSON.parse(row.event_json) })); }
      catch { try { socket.close(1011, 'replay failed'); } catch { /* stale connection */ } return; }
    }
  }

}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ service: 'github-event-relay', status: 'healthy' });
    if (url.pathname === '/v1/events/stream' && request.method === 'GET') return handleEventStream(request, env);
    if (url.pathname !== '/github/webhook') return json({ error: 'not_found' }, 404);
    return handleWebhook(request, env);
  },
  async queue(batch, env) {
    return handleQueue(batch, env);
  },
};
