const MAX_TEXT = 500;

const str = (value, max = MAX_TEXT) => typeof value === 'string' && value.length ? value.slice(0, max) : null;
const num = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function repoFields(payload) {
  const repo = payload?.repository;
  return {
    repository_id: num(repo?.id),
    repository_full_name: str(repo?.full_name),
    installation_id: num(payload?.installation?.id),
  };
}

function subjectFor(event, action, payload) {
  switch (event) {
    case 'check_run': {
      const check = payload.check_run || {};
      return {
        head_sha: str(check.head_sha, 64), check_run_id: num(check.id),
        check_suite_id: num(check.check_suite?.id), name: str(check.name),
        status: str(check.status, 40), conclusion: str(check.conclusion, 80),
        pull_request_numbers: Array.isArray(check.pull_requests)
          ? check.pull_requests.map(pr => num(pr.number)).filter(value => value !== null).slice(0, 100) : [],
        html_url: str(check.html_url, 2000),
      };
    }
    case 'check_suite': {
      const suite = payload.check_suite || {};
      return {
        head_sha: str(suite.head_sha, 64), check_suite_id: num(suite.id),
        status: str(suite.status, 40), conclusion: str(suite.conclusion, 80),
        pull_request_numbers: Array.isArray(suite.pull_requests)
          ? suite.pull_requests.map(pr => num(pr.number)).filter(value => value !== null).slice(0, 100) : [],
        html_url: str(suite.url, 2000),
      };
    }
    case 'workflow_run': {
      const run = payload.workflow_run || {};
      return {
        head_sha: str(run.head_sha, 64), workflow_run_id: num(run.id),
        run_attempt: num(run.run_attempt), workflow_id: num(run.workflow_id),
        name: str(run.name), status: str(run.status, 40), conclusion: str(run.conclusion, 80),
        event: str(run.event, 80), head_branch: str(run.head_branch),
        html_url: str(run.html_url, 2000),
      };
    }
    case 'workflow_job': {
      const job = payload.workflow_job || {};
      return {
        head_sha: str(job.head_sha, 64), job_id: num(job.id),
        workflow_run_id: num(job.run_id), run_attempt: num(job.run_attempt),
        name: str(job.name), status: str(job.status, 40), conclusion: str(job.conclusion, 80),
        html_url: str(job.html_url, 2000),
      };
    }
    case 'status': {
      const commit = payload.commit || {};
      return {
        head_sha: str(payload.sha, 64) || str(commit.sha, 64),
        state: str(payload.state, 40), context: str(payload.context),
        target_url: str(payload.target_url, 2000),
      };
    }
    case 'pull_request': {
      const pr = payload.pull_request || {};
      return {
        number: num(payload.number), action: str(action, 80),
        head_sha: str(pr.head?.sha, 64), base_sha: str(pr.base?.sha, 64),
        state: str(pr.state, 40), merged: typeof pr.merged === 'boolean' ? pr.merged : null,
        html_url: str(pr.html_url, 2000),
      };
    }
    default:
      return null;
  }
}

const SUPPORTED_EVENTS = new Set(['check_run', 'check_suite', 'workflow_run', 'workflow_job', 'status', 'pull_request']);

export function normalizeDelivery({ eventId, eventType, action, receivedAt, payload }) {
  if (!SUPPORTED_EVENTS.has(eventType)) return null;
  const repository = repoFields(payload);
  if (repository.repository_id === null || repository.repository_full_name === null) return null;
  const subject = subjectFor(eventType, action, payload);
  if (!subject) return null;
  return {
    schema_version: 1,
    event_id: `github:${eventId}`,
    source: 'github',
    app_id: num(payload?.installation?.app_id),
    ...repository,
    event_type: eventType,
    action: str(action, 80),
    received_at: receivedAt,
    subject,
  };
}

export function isSupportedEvent(eventType) {
  return SUPPORTED_EVENTS.has(eventType);
}
