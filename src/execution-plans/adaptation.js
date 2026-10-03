'use strict';

// Адаптация плана: engineering feature/integration split + migration dependency
// (работа P24; границы §«Agent может адаптировать playbook к новой фиче»).
//
// Что именно делает адаптация:
//
//   1. Split. Широкий план «фича» смешивает доставку изменения и интеграцию в
//      реальное окружение (PR-05 / P1 §9: «broad plan mixes delivery and ongoing
//      workflow»). Разделение — на границе `merged`: план фичи заканчивается
//      мержем PR, отдельный план интеграции начинается с деплоя и ведёт
//      verify-real / observe / archive. У интеграционного плана явная
//      зависимость от шага другого плана, а не «продолжим когда-нибудь».
//   2. Migration dependency. Если фича меняет схему/данные, миграция становится
//      отдельным узлом ПОСЛЕ деплоя и ДО проверки реального сценария: без её
//      receipt'а `verify-real` не начинается.
//
// Инварианты (AC-143 «правки не меняют running step IDs»):
//   * шаги, перенесённые из базового плана, сохраняют свои stepId один в один —
//     адаптация меняет состав плана, а не идентичность уже существующих шагов;
//   * шаг, которого нет в definition'а (узел миграции), помечен synthetic и не
//     притворяется скомпилированным из артефакта;
//   * оба плана сохраняют profileId / userTaskId / gtdId / continuationOwner:
//     это та же пользовательская цель, поэтому запись контроля не дублируется;
//   * compiledPlanRevision увеличивается, derivedFrom указывает на исходную
//     ревизию — «откат адаптации» это просто другая ревизия, а не правка назад.

const crypto = require('crypto');

const { PlanError } = require('./errors');
const { planIdFor } = require('./compiler');
const { findStep } = require('./step-identity');

const DEFAULT_SPLIT_AFTER = 'merged';

function migrationStepId({ planId, migrationId }) {
  return `stp_${crypto.createHash('sha256').update(`${planId}|migration|${migrationId}`).digest('hex').slice(0, 12)}`;
}

/**
 * @param {object} basePlan скомпилированный план (revision 1)
 * @param {object} options
 * @param {string} [options.splitAfterStepType] тип шага-границы (по умолчанию merged)
 * @param {{migrationId: string, description?: string}} [options.migration]
 * @param {() => Date} [options.clock]
 * @returns {{featurePlan: object, integrationPlan: object, adaptation: object}}
 */
function adaptFeatureIntegrationSplit(basePlan, { splitAfterStepType = DEFAULT_SPLIT_AFTER, migration = null, clock = () => new Date(), integrationPlanId, featurePlanId } = {}) {
  const steps = basePlan.steps || [];
  const splitIndex = steps.findIndex(step => step.stepType === splitAfterStepType);
  if (splitIndex === -1) {
    throw new PlanError('SPLIT_POINT_NOT_FOUND', `plan ${basePlan.planId} has no step of type "${splitAfterStepType}" to split after`, {
      planId: basePlan.planId,
      splitAfterStepType,
      availableStepTypes: [...new Set(steps.map(step => step.stepType))],
    });
  }

  const featureSteps = steps.slice(0, splitIndex + 1);
  const integrationSteps = steps.slice(splitIndex + 1);
  if (integrationSteps.length === 0) {
    throw new PlanError('SPLIT_POINT_NOT_FOUND', `splitting after "${splitAfterStepType}" would leave the integration plan empty`, { planId: basePlan.planId, splitAfterStepType });
  }

  const resolvedFeaturePlanId = featurePlanId || basePlan.planId;
  const resolvedIntegrationPlanId = integrationPlanId || planIdFor({
    profileId: basePlan.profileId,
    userTaskId: basePlan.userTaskId,
    playbookId: basePlan.playbook.playbookId,
    artifactHash: basePlan.playbook.artifactHash,
    compiledPlanRevision: basePlan.compiledPlanRevision + 1,
    discriminator: 'integration',
  });

  const changes = [
    {
      kind: 'feature_integration_split',
      reason: 'delivery of the change and integration in the real environment are separate goals with separate completion criteria',
      splitAfterStepKey: steps[splitIndex].stepKey,
      movedStepKeys: integrationSteps.map(step => step.stepKey),
    },
  ];

  let migratedSteps = integrationSteps.map(step => ({ ...step, dependsOn: [...step.dependsOn] }));
  let migrationNode = null;

  if (migration) {
    if (!migration.migrationId) {
      throw new PlanError('MIGRATION_DEPENDENCY_INVALID', 'migration dependency requires an explicit migrationId; an anonymous migration cannot be a dependency', { planId: basePlan.planId });
    }
    const deployedIndex = migratedSteps.findIndex(step => step.stepType === 'deployed');
    if (deployedIndex === -1) {
      throw new PlanError('MIGRATION_DEPENDENCY_INVALID', `integration plan of ${basePlan.playbook.playbookId} has no "deployed" step to apply the migration after`, { planId: basePlan.planId, migrationId: migration.migrationId });
    }
    const deployedStep = migratedSteps[deployedIndex];
    const verifyIndex = migratedSteps.findIndex(step => step.stepType === 'verify-real');
    const stepId = migrationStepId({ planId: resolvedIntegrationPlanId, migrationId: migration.migrationId });
    migrationNode = {
      stepId,
      stepKey: `migration#${migration.migrationId}`,
      stageId: 'migration',
      ordinal: migratedSteps[deployedIndex].ordinal,
      title: `Миграция данных/схемы: ${migration.migrationId}`,
      stepType: 'migration',
      executionKind: 'programmatic',
      executorRole: null,
      minimumModelLevel: null,
      contextBudget: null,
      instructionsRef: null,
      adapter: { compiledFrom: null, synthetic: 'migration_node', migrationId: migration.migrationId },
      gate: {
        required: true,
        validators: [{ name: 'migration_applied', resolved: true }],
        alreadyDone: [],
        enforcement: 'enforced',
      },
      wait: null,
      deadlines: { runDeadlineSec: null, waitDeadlineSec: null, taskDeadlineSec: null },
      maxAttempts: 1,
      dependsOn: [deployedStep.stepId],
      // Узел миграции — источник внешнего эффекта: его receipt обязателен.
      externalOperation: { kind: 'schema_migration', provider: 'target', required: true, ref: null, migrationId: migration.migrationId },
      hooks: { onComplete: [], onFail: [] },
      workspaceRefRequired: false,
      dependencyKind: 'requires_migration',
    };
    // verify-real больше не зависит только от деплоя: сначала миграция и её receipt.
    if (verifyIndex !== -1) {
      migratedSteps = migratedSteps.map(step => (step.stepId === migratedSteps[verifyIndex].stepId ? { ...step, dependsOn: [stepId] } : step));
    }
    migratedSteps = [...migratedSteps.slice(0, deployedIndex + 1), migrationNode, ...migratedSteps.slice(deployedIndex + 1)];
    changes.push({
      kind: 'migration_dependency_added',
      reason: 'a schema/data change must be applied and receipted before the real scenario is verified',
      migrationId: migration.migrationId,
      dependsOn: [deployedStep.stepKey],
      gatesStep: verifyIndex === -1 ? null : migratedSteps[verifyIndex].stepKey,
      syntheticStepId: stepId,
    });
  }

  const derivedFrom = { planId: basePlan.planId, compiledPlanRevision: basePlan.compiledPlanRevision };
  const revision = basePlan.compiledPlanRevision + 1;
  const shared = {
    compiledPlanRevision: revision,
    derivedFrom,
    adaptation: { kind: 'feature_integration_split', changes, pinned: { playbookRef: basePlan.playbook.playbookRef, artifactHash: basePlan.playbook.artifactHash }, adaptedAt: clock().toISOString() },
  };
  const correlation = {
    profileId: basePlan.profileId,
    userTaskId: basePlan.userTaskId,
    gtdId: basePlan.gtdId,
    continuationOwner: basePlan.continuationOwner,
    playbook: basePlan.playbook,
    goalDigest: basePlan.goalDigest,
    inputs: basePlan.inputs,
    bindings: basePlan.bindings,
    completionPolicy: basePlan.completionPolicy,
    definitionBytes: basePlan.definitionBytes,
    definitionBytesHash: basePlan.definitionBytesHash,
  };

  const featurePlan = {
    ...basePlan,
    ...shared,
    planId: resolvedFeaturePlanId,
    steps: featureSteps,
    stages: basePlan.stages.map(stage => ({ ...stage, stepIds: stage.stepIds.filter(id => featureSteps.some(step => step.stepId === id)) })).filter(stage => stage.stepIds.length > 0),
    stepStates: Object.fromEntries(featureSteps.map(step => [step.stepId, 'pending'])),
    stepEvidence: {},
    planDependencies: [],
    readiness: {
      ...basePlan.readiness,
      unresolvedValidators: featureSteps.flatMap(step => step.gate.validators.filter(v => !v.resolved).map(v => ({ stepId: step.stepId, validator: v.name }))),
    },
    migration: migration ? { migrationId: migration.migrationId, appliedInPlanId: resolvedIntegrationPlanId, appliedByStepId: migrationNode.stepId } : null,
  };

  const integrationPlan = {
    ...basePlan,
    ...shared,
    planId: resolvedIntegrationPlanId,
    steps: migratedSteps,
    stages: buildIntegrationStages(migratedSteps),
    stepStates: Object.fromEntries(migratedSteps.map(step => [step.stepId, 'pending'])),
    stepEvidence: {},
    // Явная зависимость от плана фичи: интеграция начинается после доказанного
    // merge, а не «когда получится».
    planDependencies: [{ kind: 'requires_plan_step', planId: resolvedFeaturePlanId, stepId: steps[splitIndex].stepId, when: 'passed' }],
    readiness: {
      ...basePlan.readiness,
      unresolvedValidators: migratedSteps.flatMap(step => step.gate.validators.filter(v => !v.resolved).map(v => ({ stepId: step.stepId, validator: v.name }))),
      externalOperationRefs: migratedSteps.filter(step => step.externalOperation).map(step => ({ stepId: step.stepId, kind: step.externalOperation.kind, required: step.externalOperation.required })),
      durableWaits: migratedSteps.filter(step => step.wait && step.wait.requiresDurableRecord).map(step => ({ stepId: step.stepId, kind: step.wait.kind })),
    },
    migration: migration ? { migrationId: migration.migrationId, stepId: migrationNode.stepId, dependsOn: migrationNode.dependsOn } : null,
  };

  return { featurePlan, integrationPlan, adaptation: featurePlan.adaptation };
}

function buildIntegrationStages(steps) {
  const byStage = new Map();
  for (const step of steps) {
    if (!byStage.has(step.stageId)) byStage.set(step.stageId, []);
    byStage.get(step.stageId).push(step.stepId);
  }
  return [...byStage.entries()].map(([id, stepIds]) => ({ id, title: id, stepIds }));
}

/** Все планы адаптации, которые этот runtime держит открытыми (для UI/GTD). */
function planSetOf(adaptationResult) {
  return [
    { planId: adaptationResult.featurePlan.planId, role: 'feature', stepIds: adaptationResult.featurePlan.steps.map(step => step.stepId) },
    { planId: adaptationResult.integrationPlan.planId, role: 'integration', stepIds: adaptationResult.integrationPlan.steps.map(step => step.stepId), dependsOn: adaptationResult.integrationPlan.planDependencies },
  ];
}

module.exports = { DEFAULT_SPLIT_AFTER, adaptFeatureIntegrationSplit, buildIntegrationStages, migrationStepId, planSetOf, findStep };