'use strict';

const prepare = require('./tools/10-prepare-task');
const workspace = require('./tools/20-workspace');
const repoContext = require('./tools/30-repo-context');
const qaLogs = require('./tools/40-qa-logs');
const prAutofix = require('./tools/50-pr-autofix');
const tools = [prepare, ...workspace, ...repoContext, ...qaLogs, ...prAutofix];

function listTools() {
  return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function callTool(name, args) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args || {});
}

module.exports = { listTools, callTool };
