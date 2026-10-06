# Repository instructions


## Sandbox-Driven Engineering

Останавливаться до безопасной dev/test-проверки или отказываться от неё из-за вероятности ошибки — вредно для инженерной работы. Не завершайте задачу одним чтением кода, если Environment Contract даёт безопасный путь исполнения. В заявленных изолированных local/dev/test/staging ресурсах самостоятельно запускайте/развёртывайте, подавайте реалистичный input, проверяйте output/logs/state, исправляйте ошибки и повторяйте сценарий. Ошибка в sandbox — evidence, а не повод закончить работу или попросить лишнее подтверждение. Production — отдельная защищённая граница; работайте с ним только по Promotion to Production path этого репозитория.


## Environment Contract

### Development / Test / Staging
**Resources:** local Node.js 22+ checkout; CI runs on GitHub Actions PR/push. This is a docs/playbook compiler and tooling repository, not a deployable service. No remote staging service is configured.

**Run:** `npm ci && npm run check:playbooks && npm test && npm run check:action-manifest`.
**Realistic input/output:** `playbooks-src/*.json` → generated `playbooks/*.json`; readable process docs are in `docs/playbooks/`. CI checks generated outputs on PR/push.
**Observe:** local command output and GitHub Actions run/artifact logs. No runtime environment or disposable external state to reset.
**Agent permissions:** freely edit/test locally and push branches/open PRs. Do not publish/sync a playbook into a live consumer manually; consumer path is the gap below.

### Production / Promotion
This repository has no production deployment workflow. README documents that trained-assist-agent resolves playbooks from a sibling checkout, but the exact deployed checkout/version/sync/revert procedure is not established in this repository. Merge to `main` updates sources only; it does not prove a production consumer changed. Direct mutation of any running plan/runtime is prohibited.

### Testability Contract
Run the commands above, inspect generated JSON and CI on the exact PR SHA, then validate through an explicitly isolated consumer once one is documented. Do not describe compiler/unit tests as runtime acceptance.

### Sandbox Gaps
- **Gap:** no pinned, isolated consumer acceptance path or verified production artifact/sync mechanism. **Impact:** cannot prove which playbook version is live or safely exercise delivery/revert. **Safe verification:** compiler, generated snapshots, unit tests and GitHub CI. **Owner/issue:** software-engineering-playbooks#149; cross-project rollout: trained-agent-architecture#185.

