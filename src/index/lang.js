'use strict';

const path = require('path');

// Deterministic, dependency-free language detection + symbol scan.
// This is intentionally a lightweight regex pass, not a full parser: the index
// is an acceleration layer, and `raw-repo` remains the correctness fallback.

const EXT_LANGUAGE = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.md': 'markdown',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

const SYMBOL_PATTERNS = {
  javascript: [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/ },
    { kind: 'export', re: /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/ },
  ],
  typescript: [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/ },
  ],
  python: [
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
  ],
  ruby: [
    { kind: 'function', re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ },
    { kind: 'class', re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/ },
  ],
  rust: [
    { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: 'type', re: /^\s*(?:public|private|protected|final|abstract|static|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/ },
  ],
  kotlin: [
    { kind: 'function', re: /^\s*(?:public|private|internal|protected|\s)*fun\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:public|private|internal|protected|\s)*\s*(?:class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/ },
  ],
  csharp: [
    { kind: 'type', re: /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*\s*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/ },
  ],
  php: [
    { kind: 'function', re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^\s*(?:abstract|final|\s)*class\s+([A-Za-z_]\w*)/ },
  ],
};

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2',
  '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wasm', '.exe',
  '.dll', '.so', '.dylib', '.class', '.jar', '.o', '.a', '.pyc', '.node', '.bin',
  '.db', '.sqlite', '.lockb',
]);

function languageFor(file) {
  return EXT_LANGUAGE[path.extname(file).toLowerCase()] || 'text';
}

function isBinaryFile(file) {
  return BINARY_EXT.has(path.extname(file).toLowerCase());
}

function isScannable(language) {
  return Object.prototype.hasOwnProperty.call(SYMBOL_PATTERNS, language);
}

function firstNonEmptyLine(content) {
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return '';
}

function extractSymbols(file, content, { maxSymbols = 200 } = {}) {
  const patterns = SYMBOL_PATTERNS[languageFor(file)];
  if (!patterns) return [];
  const out = [];
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < maxSymbols; i++) {
    const text = lines[i];
    if (!text || text.length > 400) continue;
    for (const { kind, re } of patterns) {
      const m = re.exec(text);
      if (m && m[1]) {
        out.push({ name: m[1], kind, line: i + 1, text: text.trim().slice(0, 200) });
        break;
      }
    }
  }
  return out;
}

module.exports = {
  EXT_LANGUAGE,
  languageFor,
  isBinaryFile,
  isScannable,
  extractSymbols,
  firstNonEmptyLine,
};
