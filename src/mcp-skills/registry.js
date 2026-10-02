'use strict';

const fs = require('fs');
const path = require('path');

// Two module shapes live in tools/:
//   - engineering-native: one tool `{ name, description, inputSchema, handler }` or an array of them;
//   - core-shaped (moved from trained-assist-agent, #1631): `{ isReady(), setupTools, tools: { name: {…} } }`.
//     isReady() false → only setupTools are registered (e.g. github_* without a GitHub token).
//
// Profile skills (trained-assist-agent #1537): core writes the resolved plan and passes
// SKILLS_RESOLVED; modules of switched-off catalog sections are listed there as
// 'engineering-skills/<file>' and are not registered. Unset/unreadable → nothing hidden.
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
    const ready = typeof mod.isReady === 'function' ? mod.isReady() : true;
    const setup = new Set(mod.setupTools || []);
    return Object.entries(mod.tools).map(([name, t]) => ({ name, ...t, gated: !ready && !setup.has(name) }));
  }
  return (Array.isArray(mod) ? mod : [mod]).map(t => ({ ...t, gated: false }));
}

const hidden = hiddenModules(process.env.SKILLS_RESOLVED);
const tools = [];
// Every declared tool regardless of isReady(): core's headless transport and cron gate
// tool names on this static catalog (trained-assist-agent#1530).
const allTools = [];
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const off = hidden.has(`${SERVER_ID}/${file}`);
  for (const tool of moduleTools(require(path.join(toolsDir, file)))) {
    if (allTools.some(t => t.name === tool.name)) {
      console.error(`[registry] duplicate tool name: ${tool.name} in ${file}`);
      continue;
    }
    allTools.push(tool);
    if (!off && !tool.gated) tools.push(tool);
  }
}

const defOf = t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } });

function listTools() {
  return tools.map(defOf);
}

function listAllTools() {
  return allTools.map(defOf);
}

// `context` — trusted envelope от хоста (profile/userTask/run/gtd/operation/bindings).
// Не переданные значения остаются undefined: фасад сам решает, что с ними делать
// (обычно это blocked, а не выдуманный профиль). Старые двухаргументные вызовы
// (core, cron) продолжают работать как раньше.
async function callTool(name, args, context = {}) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args || {}, { userId: process.env.USER_ID, ...context });
}

module.exports = { listTools, listAllTools, callTool };
