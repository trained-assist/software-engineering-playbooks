'use strict';

// Pinned playbook artifact: получить definition как data/resource (P14, AC-116).
//
// Правила пина:
//   - definition читается из конкретного checkout'а (`playbooks/<id>.json`), а не из
//     «последней известной версии»: путь артефакта и его sha256 — часть ответа;
//   - запрошенная версия обязана совпасть с версией артефакта, иначе отказ
//     (ARTIFACT_VERSION_MISMATCH), а не «ближайшая доступная»;
//   - переданный ожидаемый хеш проверяется (ARTIFACT_HASH_MISMATCH) — артефакт,
//     изменившийся после пинa, не отдаётся молча;
//   - артефакт проверяется по vendored контракту Playbook v1
//     (contracts/playbook.schema.json): битый JSON не становится «инструкцией».
//
// Здесь нет ни плана, ни рана, ни очереди: модуль только читает и описывает файл.
// Templates (definitions) живут в playbooks/, MCP — в src/mcp-skills/tools/;
// этот модуль не знает про MCP вообще (см. docs/DOMAIN-TOOLS-AND-PLAYBOOK-ARTIFACTS.md).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CapabilityError } = require('./errors');

const PLAYBOOKS_DIR = 'playbooks';
const DOCS_DIR = path.join('docs', 'playbooks');

function defaultRoot() {
  // Корень checkout'а этого репозитория: playbooks/ лежит рядом с src/.
  return path.resolve(__dirname, '..', '..');
}

function resolveRoot(explicit) {
  return path.resolve(explicit || process.env.PLAYBOOK_ARTIFACTS_ROOT || defaultRoot());
}

function artifactPath(root, playbookId) {
  return path.join(resolveRoot(root), PLAYBOOKS_DIR, `${playbookId}.json`);
}

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

// Минимальный подмножество draft-07 (как в tests/playbooks.test.js): type, enum,
// required, properties, additionalProperties, items, minItems, pattern, minimum,
// maximum, $ref на #/$defs. Зависимостей нет — CI ставит только Node.
function validateAgainstSchema(value, schema, root = schema, at = '$', errors = []) {
  if (schema.$ref) {
    const target = schema.$ref
      .split('/')
      .slice(1)
      .reduce((node, key) => (node ? node[key] : undefined), root);
    if (!target) return errors.concat(`${at}: unresolved $ref ${schema.$ref}`);
    return validateAgainstSchema(value, target, root, at, errors);
  }
  const types = schema.type ? [].concat(schema.type) : null;
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types && !types.some(t => t === typeOf(value) || (t === 'number' && typeof value === 'number'))) {
    return errors.concat(`${at}: type ${typeOf(value)} not in ${types}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(item, schema.items, root, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) errors.push(`${at}: empty object`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && schema.properties[key]) {
        validateAgainstSchema(item, schema.properties[key], root, `${at}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property ${key}`);
      }
    }
  }
  return errors;
}

function loadSchema(root) {
  const file = path.join(resolveRoot(root), 'contracts', 'playbook.schema.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const stepsOf = playbook => (playbook.stages || []).flatMap(stage => stage.steps || []);

function describeArtifact(playbook, { artifactRef, artifactHash, sourceRevision, root }) {
  const docFile = path.join(resolveRoot(root), 'docs', 'playbooks', `${playbook.id}.md`);
  return {
    id: playbook.id,
    version: playbook.version,
    title: playbook.title,
    scope: playbook.scope,
    when_to_use: playbook.when_to_use || null,
    artifactRef,
    artifactHash,
    sourceRevision: sourceRevision || null,
    docRef: fs.existsSync(docFile) ? `${DOCS_DIR}/${playbook.id}.md` : null,
    stageCount: (playbook.stages || []).length,
    stepCount: stepsOf(playbook).length,
    stepTypes: [...new Set(stepsOf(playbook).map(step => step.step_type))],
    stages: (playbook.stages || []).map(stage => ({ id: stage.id, title: stage.title, stepCount: (stage.steps || []).length })),
    inputs: (playbook.inputs || []).map(input => ({
      name: input.name,
      required: input.required !== false,
      derive: input.derive || null,
    })),
    defaults: playbook.defaults || {},
  };
}

/**
 * Прочитать pinned definition. Ничего не запускает: возвращает descriptor артефакта
 * и (по `detail`) сам definition как данные.
 */
function resolvePinnedPlaybook({ root, playbookId, playbookVersion, expectedHash, detail = 'summary', sourceRevision } = {}) {
  const file = artifactPath(root, playbookId);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(playbookId || '')) || !fs.existsSync(file)) {
    throw new CapabilityError('PLAYBOOK_NOT_FOUND', `pinned playbook artifact "${playbookId}" is not in ${PLAYBOOKS_DIR}/ of this checkout`, {
      playbookId: String(playbookId || ''),
      expectedRef: `${PLAYBOOKS_DIR}/<id>.json`,
    });
  }

  const bytes = fs.readFileSync(file);
  const hash = sha256(bytes);
  if (expectedHash && expectedHash !== hash) {
    throw new CapabilityError('ARTIFACT_HASH_MISMATCH', `pinned artifact ${PLAYBOOKS_DIR}/${playbookId}.json has hash ${hash}, expected ${expectedHash}`, {
      playbookId,
      artifactHash: hash,
      expectedHash,
    });
  }

  let playbook;
  try {
    playbook = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new CapabilityError('ARTIFACT_SCHEMA_INVALID', `pinned artifact ${PLAYBOOKS_DIR}/${playbookId}.json is not valid JSON: ${e.message}`, { playbookId });
  }

  const schema = loadSchema(root);
  const errors = validateAgainstSchema(playbook, schema);
  if (errors.length > 0) {
    throw new CapabilityError('ARTIFACT_SCHEMA_INVALID', `pinned artifact ${PLAYBOOKS_DIR}/${playbookId}.json does not satisfy the Playbook v1 contract: ${errors[0]}`, {
      playbookId,
      errors: errors.slice(0, 5),
    });
  }
  if (playbook.id !== playbookId) {
    throw new CapabilityError('ARTIFACT_SCHEMA_INVALID', `pinned artifact declares id "${playbook.id}" but was resolved as "${playbookId}"`, { playbookId, declaredId: playbook.id });
  }
  if (playbookVersion !== undefined && playbookVersion !== null && Number(playbookVersion) !== playbook.version) {
    throw new CapabilityError('ARTIFACT_VERSION_MISMATCH', `playbook "${playbookId}" is pinned at version ${playbook.version}, requested ${playbookVersion}`, {
      playbookId,
      pinnedVersion: playbook.version,
      requestedVersion: Number(playbookVersion),
    });
  }

  const artifactRef = `${PLAYBOOKS_DIR}/${playbook.id}.json`;
  return {
    descriptor: describeArtifact(playbook, { artifactRef, artifactHash: hash, sourceRevision, root }),
    definition: detail === 'full' ? playbook : null,
    detail,
  };
}

/** Каталог pinned-артефактов этого checkout'а — данные, а не запуск чего-либо. */
function listPinnedPlaybooks({ root } = {}) {
  const dir = path.join(resolveRoot(root), PLAYBOOKS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => file.replace(/\.json$/, ''))
    .sort()
    .map(playbookId => {
      const { descriptor } = resolvePinnedPlaybook({ root, playbookId });
      return descriptor;
    });
}

module.exports = {
  PLAYBOOKS_DIR,
  defaultRoot,
  resolveRoot,
  artifactPath,
  sha256,
  validateAgainstSchema,
  describeArtifact,
  resolvePinnedPlaybook,
  listPinnedPlaybooks,
};
