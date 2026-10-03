'use strict';

// Checklist = VIEW над выбранным planId, а не отдельный источник истины
// (границы §2/§11: «Checklist не требует ещё одного ID — это view выбранного planId»).
//
// Проверяемое свойство: view ничего не меняет. Плана-источника после чтения
// checklist'а побайтово столько же, сколько было; checklist нельзя использовать
// для «отметить шаг сделанным» — за состояние отвечает runtime, а view только
// показывает его вместе с evidence и признаком «доказательство протухло».

const crypto = require('crypto');

function fingerprint(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object} plan скомпилированный план с stepStates/stepEvidence
 * @param {object} [options]
 * @param {Date} [options.acceptanceOpenedAt] с этого момента evidence считается свежим
 */
function viewChecklist(plan, { acceptanceOpenedAt = null, staleAfterMs = 0, now = new Date() } = {}) {
  const rows = plan.steps.map(step => {
    const state = plan.stepStates[step.stepId];
    const evidence = (plan.stepEvidence && plan.stepEvidence[step.stepId]) || null;
    const evidenceAt = evidence ? new Date(evidence.at) : null;
    const stale = acceptanceOpenedAt && evidenceAt ? now.getTime() - evidenceAt.getTime() > staleAfterMs : false;
    return {
      stepId: step.stepId,
      stepKey: step.stepKey,
      stageId: step.stageId,
      title: step.title,
      stepType: step.stepType,
      executionKind: step.executionKind,
      gateRequired: step.gate.required,
      validators: step.gate.validators.map(v => v.name),
      wait: step.wait ? step.wait.kind : null,
      state,
      attempt: (plan.stepAttempts && plan.stepAttempts[step.stepId]) || 0,
      evidence: evidence ? evidence.evidence || [] : [],
      evidenceAt: evidence ? evidence.at : null,
      evidenceStale: stale,
      externalOperationRef: (plan.stepExternalOps && plan.stepExternalOps[step.stepId] && plan.stepExternalOps[step.stepId].externalRef) || null,
    };
  });

  const required = rows.filter(row => row.gateRequired);
  return {
    // view ссылается на план, а не живёт своей жизнью
    planId: plan.planId,
    compiledPlanRevision: plan.compiledPlanRevision,
    pinnedArtifact: { playbookRef: plan.playbook.playbookRef, artifactHash: plan.playbook.artifactHash, playbookVersion: plan.playbook.playbookVersion },
    gtdId: plan.gtdId ?? null,
    continuationOwner: plan.continuationOwner,
    status: plan.status,
    rows,
    progress: {
      total: rows.length,
      required: required.length,
      passed: rows.filter(row => row.state === 'passed').length,
      requiredPassed: required.filter(row => row.state === 'passed').length,
      awaiting: rows.filter(row => row.state === 'awaiting_user_input' || row.state === 'awaiting_condition').map(row => row.stepKey),
      unknown: rows.filter(row => row.state === 'unknown').map(row => row.stepKey),
      staleEvidence: rows.filter(row => row.evidenceStale).map(row => row.stepKey),
    },
    // Отпечаток view: если план не менялся, меняется только этот хеш вместе с
    // параметрами отображения — но сам planId/states остаются теми же.
    viewFingerprint: fingerprint(rows.map(row => [row.stepId, row.state])),
    sourceOfTruth: 'execution_plan',
  };
}

module.exports = { fingerprint, viewChecklist };