'use strict';
const crypto = require('node:crypto');
const { fail } = require('./errors');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const Z01 = 'https://github.com/trained-assist/trained-agent-architecture/issues/37';

async function constructionTasks({ tableBytes, tasks, reviewed, apply = false, github, onReceipt = () => {} }) {
  const digest = sha256(tableBytes);
  if (!apply) return { applied: false, table_sha256: digest, tasks };
  if (!reviewed || reviewed.approved !== true || reviewed.table_sha256 !== digest
      || reviewed.source !== Z01 || !Array.isArray(reviewed.tasks)) {
    fail('REVIEW_REQUIRED', 'apply requires an approved owner-bound list for this exact coverage table');
  }
  const expected = new Map(tasks.map(t => [`${t.repo}:${t.kind}`, t]));
  const seen = new Set();
  // Validate the entire list before the first API call; omitted gaps are an error.
  for (const t of reviewed.tasks) {
    const key = `${t.repo}:${t.kind}`;
    const original = expected.get(key);
    if (!original || seen.has(key) || t.owner !== t.repo
      || JSON.stringify(t.task) !== JSON.stringify(original)) fail('REVIEW_REQUIRED', `invalid review entry ${key}`);
    seen.add(key);
  }
  if (seen.size !== expected.size) fail('REVIEW_REQUIRED', 'every generated gap must have a reviewed owner');
  const receipts = [];
  const issueCache = new Map();
  for (const t of reviewed.tasks) {
    if (!issueCache.has(t.repo)) {
      const issues = [];
      for (let page = 1; ; page++) {
        const r = await github.ghFetch('GET', `/repos/${t.repo}/issues?state=all&per_page=100&page=${page}`);
        if (!r.ok || !Array.isArray(r.data)) fail('ISSUE_READ_FAILED', `cannot check existing tasks in ${t.repo}`);
        issues.push(...r.data.filter(x => !x.pull_request));
        if (r.data.length < 100) break;
      }
      issueCache.set(t.repo, issues);
    }
    const marker = `<!-- Z01-construction:${t.repo}:${t.kind} -->`;
    let issue = issueCache.get(t.repo).find(x => x.body?.includes(marker));
    const created = !issue;
    if (!issue) {
      const body = `${marker}\nOwner: ${t.owner}\n\n${t.task.detail}\n\nAcceptance: ${t.task.refs.join(', ')}. Add executable evidence before closure.\n\nCoverage review SHA-256: ${digest}\n\nRefs ${Z01}\nAC-20 / AC-21: https://github.com/trained-assist/trained-agent-architecture/blob/main/ACCEPTANCE-CHECKLIST.md\n`;
      const r = await github.ghFetch('POST', `/repos/${t.repo}/issues`, { title: `[Z01] ${t.task.title}`, body });
      if (!r.ok || !r.data?.html_url) fail('ISSUE_WRITE_FAILED', `could not create task in ${t.repo}; rerun checks marker before creating`);
      issue = r.data; issueCache.get(t.repo).push(issue);
    }
    const receipt = { repo: t.repo, kind: t.kind, owner: t.owner, url: issue.html_url, created };
    onReceipt(receipt); receipts.push(receipt);
  }
  return { applied: true, table_sha256: digest, receipts };
}
module.exports = { constructionTasks, sha256, Z01 };
