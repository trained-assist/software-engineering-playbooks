'use strict';

class QaLogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QaLogError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new QaLogError(code, message, details);
}

module.exports = { QaLogError, fail };
