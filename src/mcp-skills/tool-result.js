// Empty tools/call result guard.
// Mirrors trained-assist-agent src/mcp-tool-result.js (PR #1482, issue #1481) —
// keep the two in sync. An empty tools/call text makes the model invent content;
// instead we hand it an explicit "empty result" marker.
'use strict';
function isEmptyToolResult(result) {
  if (result === undefined || result === null) return true;
  if (typeof result === 'string') return !result.trim();
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === 'object') return Object.keys(result).length === 0;
  return false;
}
function emptyToolResultText(name) {
  return `⚠️ Инструмент ${name} вернул пустой результат (нет данных). Не додумывай содержимое: скажи пользователю, что инструмент ничего не вернул.`;
}
function toolResultText(name, result, { pretty = true } = {}) {
  if (isEmptyToolResult(result)) {
    console.error(`[mcp] tool ${name} returned an empty result`);
    return emptyToolResultText(name);
  }
  if (typeof result === 'string') return result;
  return pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}
module.exports = { isEmptyToolResult, emptyToolResultText, toolResultText };
