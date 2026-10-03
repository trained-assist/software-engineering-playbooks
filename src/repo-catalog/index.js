'use strict';

const { findRepos } = require('./find');
const { buildCatalog, clearCache } = require('./catalog');
const { scoreRepo, splitTokens, normalize } = require('./match');

module.exports = { findRepos, buildCatalog, clearCache, scoreRepo, splitTokens, normalize };
