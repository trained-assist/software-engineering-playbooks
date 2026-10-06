# Repository instructions

Read [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and only the playbook/contract relevant to the task. This repository was formerly called trained-assist-engineering; new links use software-engineering-playbooks.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

Keep generated playbooks/manifests in sync with their source using existing package.json checks. Use isolated workspaces, explicit credentials, pushed checkpoints and feature PRs. GitHub owns issue/PR/CI state; engineering owns reusable policy and derived caches, not product task state. Do not change another session's deployment or branch.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
