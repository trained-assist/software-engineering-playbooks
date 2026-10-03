'use strict';

const { findRepos } = require('./find');
const { buildCatalog, clearCache, listPath } = require('./catalog');
const { scoreRepo, splitTokens, normalize } = require('./match');

module.exports = { findRepos, buildCatalog, clearCache, listPath, scoreRepo, splitTokens, normalize };
