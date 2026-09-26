'use strict';

const path = require('path');

// The index is a derived acceleration layer. Its on-disk contract is declared
// here so both the builder and the reader agree on the version and layout.
const INDEX_SCHEMA_VERSION = 1;
const INDEX_ROOT_DIRNAME = path.join('.engineering', 'index');
const INDEX_JSON_FILES = ['revision.json', 'files.json', 'modules.json', 'symbols.json', 'tests.json'];
const GENERATOR = 'deterministic-v1';

function indexRoot(repoPath) {
  return path.join(repoPath, INDEX_ROOT_DIRNAME);
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  INDEX_ROOT_DIRNAME,
  INDEX_JSON_FILES,
  GENERATOR,
  indexRoot,
};
