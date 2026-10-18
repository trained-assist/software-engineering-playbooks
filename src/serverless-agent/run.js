'use strict';

function configuration() {
  const baseUrl = process.env.SERVERLESS_AGENT_API_URL || process.env.SERVERLESS_AGENT_BASE_URL || '';
  const token = process.env.SERVERLESS_AGENT_API_KEY || process.env.SERVERLESS_AGENT_TOKEN || '';
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

function headersFor(config) {
  return {
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
}

function isValidRunId(runId) {
  return typeof runId === 'string' && /^run_[A-Za-z0-9_-]+$/.test(runId);
}

async function agentRunStart(args, deps) {
  const config = deps || {};
  const fetchImpl = config.fetch || global.fetch;
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const url = `${baseUrl}/v1/developer/runs`;
  const body = {
    prompt: args.task,
    model: args.connection_id ? { mode: 'byok', connectionId: args.connection_id } : { mode: 'managed' },
  };
  if (args.timeout_seconds) body.limits = { timeoutSeconds: args.timeout_seconds };
  const headers = { ...headersFor(config), 'idempotency-key': args.idempotency_key };
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    return {
      error: 'ADMISSION_UNKNOWN',
      summary: `Admission result unknown; retry with the same idempotency_key: ${args.idempotency_key}`,
      run_id: null,
    };
  }
  if (!response || !response.ok) {
    return {
      error: response ? `HTTP_${response.status}` : 'HTTP_ERROR',
      summary: 'Failed to start the remote run.',
      run_id: args.run_id || null,
    };
  }
  const data = await response.json();
  return {
    run_id: data.runId || data.run_id,
    deduplicated: Boolean(data.deduplicated),
  };
}

async function agentRunWait(args, deps) {
  const config = deps || {};
  if (!isValidRunId(args.run_id)) {
    return { state: 'invalid_request', run_id: args.run_id, outcome: 'pending' };
  }
  const fetchImpl = config.fetch || global.fetch;
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const statusUrl = `${baseUrl}/v1/developer/runs/${args.run_id}`;
  const resultUrl = `${statusUrl}/result`;
  const authHeaders = headersFor(config);
  const timeoutMs = (args.timeout_seconds || 300) * 1000;
  const intervalMs = (args.interval_seconds || 5) * 1000;
  const now = config.now || (() => Date.now());
  const sleep = config.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const signal = config.signal;
  const start = now();
  let state = 'running';

  while (true) {
    if (signal && signal.aborted) {
      return { state: 'cancelled', outcome: 'pending', run_id: args.run_id };
    }
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) {
      return { state: 'timed_out', outcome: 'pending', run_id: args.run_id };
    }
    try {
      const statusResponse = await fetchImpl(statusUrl, { headers: authHeaders });
      if (statusResponse && statusResponse.status === 401) {
        return { error: 'HTTP_401', run_id: args.run_id };
      }
      if (statusResponse && statusResponse.ok) {
        const statusBody = await statusResponse.json();
        if (statusBody && statusBody.state) state = statusBody.state;
      }
    } catch (error) {
      // transient; keep polling
    }

    if (state === 'succeeded') {
      try {
        const resultResponse = await fetchImpl(resultUrl, { headers: authHeaders });
        const resultBody = resultResponse && resultResponse.ok ? await resultResponse.json() : {};
        const artifacts = Array.isArray(resultBody.artifacts)
          ? resultBody.artifacts.map(item => ({
              path: item.path,
              name: item.name,
              mime: item.mime,
              size: item.size,
              download_url: item.downloadUrl || item.download_url,
              expires_at: item.expiresAt || item.expires_at,
            }))
          : [];
        return {
          state: 'succeeded',
          outcome: 'success',
          run_id: args.run_id,
          summary: resultBody.text || resultBody.summary || '',
          elapsed_seconds: Math.round((now() - start) / 1000),
          artifacts,
          artifacts_expire_at: resultBody.artifactExpiresAt || resultBody.artifacts_expire_at,
        };
      } catch (error) {
        // fall through to polling
      }
    }

    if (state === 'failed') {
      try {
        const resultResponse = await fetchImpl(resultUrl, { headers: authHeaders });
        const resultBody = resultResponse && resultResponse.ok ? await resultResponse.json() : {};
        return {
          state: 'failed',
          outcome: 'failure',
          run_id: args.run_id,
          summary: (resultBody.failure && resultBody.failure.safeSummary) || resultBody.summary || 'Execution failed',
          elapsed_seconds: Math.round((now() - start) / 1000),
        };
      } catch (error) {
        // fall through
      }
    }

    await sleep(intervalMs);
  }
}

module.exports = { agentRunStart, agentRunWait, configuration };
