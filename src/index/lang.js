'use strict';

const path = require('path');

// Deterministic, dependency-free language detection + symbol scan.
// JavaScript is scanned through a real parser (vendored acorn — no npm install
// at deploy time), every other language through a lightweight regex pass: the
// index is an acceleration layer, and `raw-repo` remains the correctness
// fallback. Both paths must stay byte-stable for a fixed file content.

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
    // Fallback for sources acorn refuses to parse: the spread CJS export that
    // the plain `exports.x =` pattern misses, and class members.
    { kind: 'export', re: /^\s*(?:module\.)?exports\s*=\s*\{([^}]*)/, split: ',' },
    { kind: 'method', re: /^(\s+)(?!if\b|for\b|while\b|switch\b|catch\b|return\b|new\b|function\b|else\b|do\b)(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:[{=]|$)/, method: true },
  ],
  typescript: [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/ },
    // CommonJS spread export: `module.exports = { a, b }` — one symbol per name.
    { kind: 'export', re: /^\s*(?:module\.)?exports\s*=\s*\{([^}]*)/, split: ',' },
    { kind: 'export', re: /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/ },
    // Class members: an indented call-like header while inside a class body.
    { kind: 'method', re: /^(\s+)(?!if\b|for\b|while\b|switch\b|catch\b|return\b|new\b|function\b|else\b|do\b)(?:static\s+|async\s+|get\s+|set\s+|readonly\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:[:;{=<]|$)/, method: true },
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
  const language = languageFor(file);
  if (language === 'javascript') {
    const parsed = extractSymbolsJs(content, { maxSymbols });
    if (parsed) return parsed;
    // fall through: unparsable source (syntax the vendored parser rejects) →
    // the deterministic regex scan still has to answer.
  }
  return extractSymbolsRegex(language, content, { maxSymbols });
}

function extractSymbolsRegex(language, content, { maxSymbols = 200 } = {}) {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return [];
  const out = [];
  const seen = new Set();
  const push = (name, kind, line) => {
    if (!name || seen.has(name) || out.length >= maxSymbols) return;
    seen.add(name);
    out.push({ name, kind, line, text: String(lines[line - 1] || '').trim().slice(0, 200) });
  };
  const lines = String(content).split(/\r?\n/);
  let classDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < lines.length && out.length < maxSymbols; i++) {
    const text = lines[i];
    if (!text || text.length > 400) continue;
    for (const pattern of patterns) {
      const m = pattern.re.exec(text);
      if (!m || !m[1]) continue;
      if (pattern.method) {
        if (!classDepth || braceDepth <= 0) continue;
        push(m[2], 'method', i + 1);
        break;
      }
      if (pattern.split) {
        let any = false;
        for (const part of m[1].split(pattern.split)) {
          const name = part.trim().replace(/^[A-Za-z_$][\w$]*\s*:\s*/, '').replace(/[,(].*$/, '').trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) { push(name, pattern.kind, i + 1); any = true; }
        }
        if (any) break;
        continue;
      }
      push(m[1], pattern.kind, i + 1);
      break;
    }
    if (/\bclass\s+[A-Za-z_$]/.test(text)) classDepth = 1;
    if (classDepth) {
      for (const ch of text) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      }
      if (braceDepth === 0) classDepth = 0;
    }
  }
  return out;
}

// Real parse for JavaScript: keeps class methods, spread CJS exports and
// nested declarations honest where a line-based scan cannot. Returns null when
// the source does not parse, so callers can fall back instead of losing the
// file.
function extractSymbolsJs(content, { maxSymbols = 200 } = {}) {
  const acorn = loadAcorn();
  if (!acorn) return null;
  let ast = null;
  for (const sourceType of ['script', 'module']) {
    try {
      ast = acorn.parse(String(content), { ecmaVersion: 'latest', sourceType, locations: true });
      break;
    } catch { /* try the other module system, then give up */ }
  }
  if (!ast) return null;

  const lines = String(content).split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const push = (name, kind, node) => {
    if (!name || seen.has(name) || out.length >= maxSymbols) return;
    seen.add(name);
    const line = node && node.loc ? node.loc.start.line : 1;
    out.push({ name, kind, line, text: String(lines[line - 1] || '').trim().slice(0, 200) });
  };
  const nameOf = (node) => (node && node.type === 'Identifier' ? node.name
    : node && (node.type === 'Literal' || node.type === 'StringLiteral') ? String(node.value)
      : null);

  function pushExportKeys(right, node) {
    if (!right) return;
    if (right.type === 'ObjectExpression') {
      for (const prop of right.properties) {
        if (prop.type === 'SpreadElement') continue;
        push(nameOf(prop.key) || (prop.value && prop.value.name), 'export', node);
      }
      return;
    }
    if (right.type === 'Identifier') push(right.name, 'export', node);
  }

  function visitClass(node, fallbackName) {
    const name = node.id ? node.id.name : fallbackName;
    if (node.id) push(name, 'class', node);
    if (node.superClass) visit(node.superClass, null);
    for (const element of node.body && node.body.body ? node.body.body : []) {
      if (element.type !== 'MethodDefinition' && element.type !== 'PropertyDefinition') continue;
      const key = nameOf(element.key);
      if (key === 'constructor' && !name) continue;
      push(name ? `${name}.${key}` : key, 'method', element);
      if (element.value) visit(element.value, name);
      if (element.value && element.value.body) visit(element.value.body, name);
    }
  }

  function visit(node, className) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child, className); return; }
    if (typeof node.type !== 'string') return;

    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitClass(node, className);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.id) push(node.id.name, 'function', node);
        break;
      case 'VariableDeclarator':
        if (node.id && node.id.type === 'Identifier'
          && node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')) {
          push(node.id.name, 'const', node);
        }
        break;
      case 'AssignmentExpression': {
        const left = node.left;
        if (left && left.type === 'MemberExpression' && !left.computed) {
          const obj = left.object && left.object.type === 'Identifier' ? left.object.name : null;
          const prop = nameOf(left.property);
          const nested = left.object && left.object.type === 'MemberExpression'
            && left.object.object && left.object.object.type === 'Identifier'
            && left.object.object.name === 'module'
            && nameOf(left.object.property) === 'exports';
          if (obj === 'module' && prop === 'exports') pushExportKeys(node.right, node);
          else if (nested) push(prop, 'export', node);
          else if (obj === 'exports' && prop) push(prop, 'export', node);
        }
        break;
      }
      case 'ExportNamedDeclaration':
        if (node.specifiers && node.specifiers.length) {
          for (const spec of node.specifiers) push(nameOf(spec.local), 'export', node);
        }
        if (node.declaration) visit(node.declaration, className);
        return;
      case 'ExportDefaultDeclaration': {
        const decl = node.declaration;
        push((decl && decl.id && decl.id.name) || (decl && decl.name) || 'default', 'export', node);
        if (decl) visit(decl, className);
        break;
      }
      default:
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'parent') continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value, className);
    }
  }

  visit(ast, null);
  out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return out;
}

let acornModule;
function loadAcorn() {
  if (acornModule !== undefined) return acornModule;
  try {
    // Vendored: the agent server deploys without npm install, so the parser
    // ships inside the repository (vendor/acorn, MIT — see its README).
    acornModule = require(path.join(__dirname, '..', '..', 'vendor', 'acorn', 'acorn.js'));
  } catch {
    acornModule = null;
  }
  return acornModule;
}

module.exports = {
  EXT_LANGUAGE,
  languageFor,
  isBinaryFile,
  isScannable,
  extractSymbols,
  firstNonEmptyLine,
};
