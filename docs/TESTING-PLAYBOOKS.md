# Playbook Testing Strategy

How we test engineering playbooks to catch bugs before they reach the VM.

## Philosophy

Playbooks are **code** — they define agent behavior, validation contracts, and
step ordering. Bugs in playbooks manifest as:
- Agent crashes mid-step (wrong role/level/budget)
- Validator never passes (non-deterministic key on a wait step)
- Hooks silently dropped (unknown event name)
- Schema drift (agent adds field, playbook doesn't know)

We test playbooks at **compile time** (does it build?) and **contract time**
(does it match the runtime's expectations?). Runtime behavior is tested separately
by the agent's offline e2e (`playbooks-offline-e2e.test.js`).

## Test Layers

### 1. Schema Validation (`tests/playbooks.test.js`)

Validates committed `playbooks/*.json` against `contracts/playbook.schema.json`
using an inline JSON-schema validator (zero deps).

Catches: wrong types, missing required fields, invalid enums, stale build output.

### 2. Build Freshness (`npm run check:playbooks`)

Ensures `playbooks/*.json` matches what `scripts/build-playbooks.js` produces
from `playbooks-src/*.json` + `library/step-types.json`.

Catches: forgetting to rebuild after editing sources.

### 3. Compile-Check Tests (`tests/compile-check.test.js`)

**The key innovation.** Vendored validation functions from `trained-assist-agent`
validate every compiled step against the runtime's own rules.

Catches what schema alone misses:
- Agent step missing `executor_role` / `minimum_model_level` / `context_budget`
- `wait` on a non-programmatic step
- Non-deterministic validator key on a wait step (e.g., `pr_opened` — needs LLM)
- Unknown hook events (e.g., `on_unknown`)
- Empty validator keys

### 4. Process Invariants (`tests/playbooks.test.js`)

Domain-specific ordering rules:
- sandbox before implement
- plan-declaration before implement
- ci-green before merged
- archive at end
- confirm-fixed after deployed (debugging)

### 5. Schema Sync (CI job)

Diffs `contracts/playbook.schema.json` against the agent's canonical copy.
If the agent adds a new field or enum value, CI catches it.

## File Layout

```
tests/
├── helpers/
│   ├── validate-item.js          # Vendored from agent: validateItem, ROLES, LEVELS, BUDGETS
│   ├── validate-hooks.js         # Vendored from agent: validateHooks, HOOK_TYPES, events
│   ├── validator-keys.js         # DETERMINISTIC_KEYS from playbook-validators.js
│   └── stub-registry-preload.cjs # MCP registry stub for tests
├── compile-check.test.js         # 18 tests: runtime contract validation
├── playbooks.test.js             # Schema + build freshness + invariants
├── contract.test.js              # MCP registry + provider manifest contracts
└── ...                           # Other test files
```

## Vendored Validators

We vendor minimal validation functions from `trained-assist-agent` instead of
importing the full agent (which would drag in all dependencies).

**What we vendor:**
| Function | Source | Lines | Dependencies |
|----------|--------|-------|-------------|
| `validateItem` | `src/durable-task-plan.js` | ~25 | none (pure) |
| `validateHooks` | `src/playbook-hooks.js` | ~30 | none (pure) |
| `DETERMINISTIC_KEYS` | `src/playbook-validators.js` | ~15 | none (constant) |

**How to keep in sync:**
1. Each vendored file has a `// Source: trained-assist-agent@<sha>` comment
2. The `schema-sync` CI job diffs the vendored schema against the agent
3. When the agent changes validation rules, update the vendored copies:
   ```bash
   # Copy from agent
   cp ~/Code/trained-assist-agent/src/durable-task-plan.js tests/helpers/validate-item.js
   # Strip to just the validation function + constants
   # Add header comment with source SHA
   ```

**Why not npm/git submodule:**
- Agent is not published to npm
- Submodules add merge complexity
- Full module import drags in deps the playbook repo doesn't need

## Running Tests

```bash
# All tests (119+)
npm test

# Just compile-check tests
node --test tests/compile-check.test.js

# Build freshness check
npm run check:playbooks

# Schema validation + invariants
node --test tests/playbooks.test.js
```

## CI Workflow

`.github/workflows/ci.yml` runs on push/PR to main:

1. **Syntax check** — `npm run check` (node --check on all src files)
2. **Tests** — `npm test` (all test files including compile-check)
3. **Manifest contract** — `npm run manifest:check`
4. **Build freshness** — `npm run check:playbooks`
5. **Schema sync** — clones agent, diffs vendored schema

## Adding a New Step Type

1. Add to `library/step-types.json` with `role`, `level`, `budget`, `done_when`
2. Run `npm run build:playbooks` to rebuild
3. Add to a playbook in `playbooks-src/`
4. `npm run check:playbooks` to verify freshness
5. `npm test` to verify compile-check passes
6. PR — CI validates everything

## Adding a New Validator Key

1. Add to agent's `src/playbook-validators.js` `createDefaultRegistry()`
2. Update `tests/helpers/validator-keys.js` with the new key
3. If deterministic: add to `DETERMINISTIC_KEYS`
4. If LLM-only: document in the key's comment (wait steps can't use it)
5. PR to both repos (agent + playbooks)

## Edge-Case Testing (on VM)

For testing runtime behavior with bad state, use the edge-case runner on the VM:

```bash
# Upload and run
cat edge-case-runner.js | ssh vova@136.65.7.197 'cat > /tmp/edge.js && node /tmp/edge.js'
```

This tests:
- Corrupt evidence_json
- Skip running/done items (defense-in-depth)
- Delete task with child items
- Concurrent claim races
- Massive evidence payloads
- Empty validator keys
- Negative positions
- Attempts > max_attempts
