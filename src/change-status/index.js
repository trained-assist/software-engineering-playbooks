'use strict';

const { changeStatus } = require('./status');
const { evaluateStages, nextMissingActions, summarize, STAGE_ORDER, STATUSES } = require('./stages');
const local = require('./local');
const github = require('./github');
const verification = require('./verification');

module.exports = {
  changeStatus,
  evaluateStages,
  nextMissingActions,
  summarize,
  candidateKeys: verification.candidateKeys,
  verificationKey: verification.verificationKey,
  readVerification: verification.readVerification,
  verificationSlot: verification.verificationSlot,
  localFacts: local.localFacts,
  collectPr: github.collectPr,
  collectBranch: github.collectBranch,
  collectCommit: github.collectCommit,
  collectIssue: github.collectIssue,
  accessProbe: github.accessProbe,
  STAGE_ORDER,
  STATUSES,
};