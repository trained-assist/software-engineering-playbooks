'use strict';

class PrAutofixError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrAutofixError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PrAutofixError(code, message, details);
}

module.exports = { PrAutofixError, fail };
