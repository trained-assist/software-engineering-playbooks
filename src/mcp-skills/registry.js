'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ID = 'engineering-skills';
const toolsDir = path.join(__dirname, 'tools');

function hiddenModules(file) {
  if (!file) return new Set();
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8')).hidden || {};
    return new Set((Array.isArray(h.modules) ? h.modules : []).filter(m => typeof m === 'string'));
  } catch (e) {
    console.error(`[skills] SKILLS_RESOLVED=${file}: ${e.message} — no filter`);
    return new Set();
  }
}

function moduleTools(mod) {
  if (mod && mod.tools && !Array.isArray(mod.tools) && typeof mod.tools === 'object') {
    // core-shaped module: { isReady, setupTools, tools: { name: {...} } }
    const isReadyFn = typeof mod.isReady === 'function' ? mod.isReady : () => true;
    const setup = new Set(mod.setupTools || []);
    const notReadyError = mod.notReadyError || null;
    return Object.entries(mod.tools).map(([name, t]) => ({
      name,
      ...t,
      isReadyFn,
      setup,
      notReadyError,
      gated: !isReadyFn() && !setup.has(name)
    }));
  }
  return (Array.isArray(mod) ? mod : [mod]).map(t => ({ ...t, isReadyFn: () => true, setup: new Set(), notReadyError: null, gated: false }));
}

const hidden = hiddenModules(process.env.SKILLS_RESOLVED);
const allTools = [];
const tools = [];

for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const off = hidden.has(`${SERVER_ID}/${file}`);
  for (const tool of moduleTools(require(path.join(toolsDir, file)))) {
    if (allTools.some(t => t.name === tool.name)) {
      console.error(`[registry] duplicate tool name: ${tool.name} in ${file}`);
      continue;
    }
    allTools.push(tool);
    if (!off) tools.push(tool);
  }
}

const defOf = t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } });

function listTools() {
  return tools.map(defOf);
}

function listAllTools() {
  return allTools.map(defOf);
}

function notReadyError(tool, name) {
  const msg = typeof tool.notReadyError === 'function'
    ? tool.notReadyError(name)
    : (tool.notReadyError || `Tool ${name} requires authentication that is not configured.`);
  return new Error(`NOT_READY: ${msg}`);
}

async function callTool(name, args, context = {}) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.gated && !tool.isReadyFn()) {
    throw notReadyError(tool, name);
  }
  return tool.handler(args || {}, { userId: process.env.USER_ID, ...context });
}

module.exports = { listTools, listAllTools, callTool };
