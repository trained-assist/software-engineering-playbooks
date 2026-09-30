'use strict';
// Profile path resolver for the engineering domain — same env contract as
// trained-assist-agent's src/data-paths.js (USERS_DIR / AGENT_TOKENS_DIR /
// AGENT_DATA_DIR, home-relative defaults), so the skill reads the same files
// core does. Required by src/credential-store.js (trained-assist-agent#1939).
const os = require('os');
const path = require('path');

const home = () => process.env.HOME || os.homedir();
const usersRoot = () => process.env.USERS_DIR || path.join(home(), 'users');
const tokensRoot = () => process.env.AGENT_TOKENS_DIR || process.env.AGENT_TOKENS_ROOT || path.join(home(), 'agent-tokens');
const dataRoot = () => process.env.AGENT_DATA_DIR || path.join(home(), 'agent-data');
const userWorkDir = (username) => path.join(usersRoot(), String(username));

module.exports = { usersRoot, tokensRoot, dataRoot, userWorkDir };
