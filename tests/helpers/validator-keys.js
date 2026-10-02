'use strict';

// Known deterministic validator keys from trained-assist-agent/src/playbook-validators.js
// createDefaultRegistry(). These are the keys the runtime can evaluate without an LLM.
// Source: trained-assist-agent@2d3d19b (2026-09-28)

const DETERMINISTIC_KEYS = [
  'ci_green',
  'ci_and_staging_green',
  'merged',
  'pr_merged',
  'merged_and_deployed',
  'pr_opened',
  'file_exists',
  'command_exit_zero',
  'credential_present',
  'http_ok',
  'task_done',
];

module.exports = { DETERMINISTIC_KEYS };
