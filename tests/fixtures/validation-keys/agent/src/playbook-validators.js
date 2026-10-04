'use strict';
// Fixture stand-in for trained-assist-agent/src/playbook-validators.js — only the
// shape `extractAgentKeys` parses. Deliberately drifted from the contract on purpose:
// `new_agent_key` is missing there, and `pr_opened` is no longer here.
function createDefaultRegistry({ ghToken, ghFetch } = {}) {
  return {
    file_exists: () => {},
    command_exit_zero: () => {},
    new_agent_key: () => {},
  };
}
module.exports = { createDefaultRegistry };
