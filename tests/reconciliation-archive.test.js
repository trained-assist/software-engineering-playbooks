'use strict';

// #135 phase 2: the `archive` step is the runtime consumer of the reconciliation
// contract, and the acceptance criteria say an instruction alone is not enforcement —
// so these tests pin the STEP CONTRACT in both places the executor can read it:
// the library (source of truth) and the BUILT playbooks (what the agent resolves).
//
// Also pins the two #47 clarifications merged into the same change (no second archive
// step): the delta target is the one declared in propose-change, and docs edited after
// the branch merge go through a separate docs-only PR.
//
// Deliberately NOT asserting a passing gate: `living_docs_updated_and_plan_closed` is
// known to be absent from the agent's validator registry (owner decision 2026-10-03 —
// report first, PR #133/#134). The test below records that gap explicitly instead of
// pretending it is enforced, so neither a silent hard gate nor a silent "fixed" claim
// can land without this test changing with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'step-types.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'validation-keys.json'), 'utf8'));

const ARCHIVE = library.types.archive;

// Every playbook whose last step is `archive` — the consumers of this contract.
const PLAYBOOK_SRC_DIR = path.join(ROOT, 'playbooks-src');
const PLAYBOOK_OUT_DIR = path.join(ROOT, 'playbooks');

function archiveConsumers() {
  return fs.readdirSync(PLAYBOOK_SRC_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(id => {
      const built = path.join(PLAYBOOK_OUT_DIR, `${id}.json`);
      if (!fs.existsSync(built)) return false;
      const pb = JSON.parse(fs.readFileSync(built, 'utf8'));
      return (pb.stages || []).some(s => (s.steps || []).some(i => i.step_type === 'archive'));
    });
}

function builtArchiveInstructions(id) {
  const pb = JSON.parse(fs.readFileSync(path.join(PLAYBOOK_OUT_DIR, `${id}.json`), 'utf8'));
  const found = (pb.stages || []).flatMap(s => s.steps || []).filter(i => i.step_type === 'archive');
  assert.equal(found.length, 1, `${id}: ровно один шаг archive`);
  return found[0].instructions;
}

test('archive требует reconciliation receipt с проверяемой командой, а не только текст', () => {
  const text = ARCHIVE.substeps.join('\n');
  assert.ok(text.includes('contracts/reconciliation-receipt.schema.json'),
    'receipt обязан ссылаться на свой контракт');
  assert.ok(text.includes('npm run report:reconciliation'),
    'receipt обязан проверяться исполняемой командой (report:reconciliation), не на словах');
  assert.ok(text.includes('plan/шаг') && text.includes('revision'),
    'receipt обязан пинить план/шаг и принятую ревизию требований');
  assert.ok(text.includes('per-REQ refs') || text.includes('per-REQ'),
    'delta обязана нести per-REQ refs');
});

test('code_delivery и baseline — разные стадии; «baseline_updated» не заявляется до мержа docs', () => {
  const text = ARCHIVE.substeps.join('\n');
  assert.ok(text.includes('code_delivery') && text.includes('baseline'),
    'обе стадии названы явно');
  assert.ok(/pending/.test(text) && /applied/.test(text),
    'перечислены и честный pending, и applied');
  assert.ok(/до мержа docs-PR|до мержа docs/.test(text),
    'заявление «доки обновлены» привязано к мержу docs, а не к мержу кода');
  assert.ok(/missing_requirements|followup/.test(text),
    'не доеденное обязано уходить в missing/followup, а не в as-built');
});

test('delta: поведение → spec/contract, границы и решения → architecture/adr, TODO не в архитектуру', () => {
  const text = ARCHIVE.substeps.join('\n');
  assert.ok(/поведени\w* → target.kind spec или contract|изменение поведения → target.kind spec или contract/i.test(text),
    'изменение поведения идёт в спецификацию/контракт');
  assert.ok(/architecture или adr/.test(text),
    'границы/инварианты/решения идут в architecture/adr');
  assert.ok(/Всё TODO в архитектуру не превращай|TODO в архитектуру не превращай/.test(text),
    'отложенные идеи не выдаются за существующую систему');
});

test('#47: цель слияния дельты — объявленная в propose-change, docs/user-scenarios только дефолт', () => {
  const text = ARCHIVE.substeps.join('\n');
  assert.ok(/объявленн\w+ в propose-change|объявлена в propose-change/.test(text),
    'цель дельты берётся из propose-change');
  assert.ok(/#47/.test(text), 'изменение оформлено в рамках #47, без второго archive');
  assert.ok(/дефолт, но не единственный путь|не единственный путь/.test(text),
    'docs/user-scenarios назван дефолтом, а не единственной целью');
  assert.ok(/не создавай каталог ради шага/.test(text),
    'категорический запрет выдумывать каталог постфактум сохранён');
  assert.ok(/отдельный docs-only PR/.test(text),
    'правки после мержа ветки идут отдельным docs-only PR (#47, п.2)');
});

test('повтор не создаёт второй PR и не дублирует требования', () => {
  const text = ARCHIVE.substeps.join('\n');
  assert.ok(/Повтор шага не плодит второй PR/.test(text),
    'replay-guard присутствует (приёмка #135: «повтор не создаёт второй PR/дубли требований»)');
  assert.ok(/не создавай новый архивный PR ради того же/.test(text));
});

test('все потребители archive в BUILT-плейбуках несут receipt-контракт (runtime consumer)', () => {
  const consumers = archiveConsumers();
  assert.ok(consumers.length >= 5, `ожидалось ≥5 потребителей, найдено: ${consumers.length}`);
  for (const id of consumers) {
    const instructions = builtArchiveInstructions(id);
    assert.ok(instructions.includes('contracts/reconciliation-receipt.schema.json'),
      `${id}: в собранных инструкциях archive нет ссылки на контракт receipt'а`);
    assert.ok(instructions.includes('npm run report:reconciliation'),
      `${id}: в собранных инструкциях archive нет исполняемой проверки receipt'а`);
    assert.ok(instructions.includes('code_delivery') && instructions.includes('baseline'),
      `${id}: две стадии не разделены в собранных инструкциях`);
    assert.ok(instructions.includes('объявленн') && instructions.includes('propose-change'),
      `${id}: цель дельты из propose-change (#47) не дошла до собранных инструкций`);
  }
});

test('done_when требует receipt и запрещает applied без реальных paths', () => {
  assert.ok(/reconciliation receipt/.test(ARCHIVE.done_when),
    'done_when упоминает receipt');
  assert.ok(/code_delivery и baseline видны раздельно/.test(ARCHIVE.done_when),
    'done_when требует видимых раздельных стадий');
  assert.ok(/не заявлена applied без реальных paths/.test(ARCHIVE.done_when),
    'existence ≠ application закреплена в done_when');
});

test('гейт НЕ включён: validation archive = документированный gap, а не новый ключ', () => {
  const keys = Object.keys(ARCHIVE.validation || {});
  assert.deepEqual(keys, ['living_docs_updated_and_plan_closed'],
    'валидация шага не менялась: интеграция receipt’а не добавляет новых validation-ключей');
  assert.ok(!registry.keys.includes('living_docs_updated_and_plan_closed'),
    'ключ по-прежнему отсутствует в реестре агента → гейт inconclusive (report-only, решение 03.10). ' +
    'Если тест упал: либо ключ добавили в агентский реестр — тогда это уже решение владельца, ' +
    'обнови contracts/validation-keys.json и комментарий здесь; либо валидацию шага поменяли молча.');
});
