# Ownership boundaries

Engineering owns reusable task preparation, repository workspaces/context, verification, issue/PR/CI capabilities, playbook artifacts and adapters to independent autofix/merge services. It does not own end-user conversation state, product-domain logic, or the platform's durable task orchestration.

Product repositories own source/revisions and product-specific mechanics; GitHub owns issue/PR/CI status. Control plane owns generic continuation, waits and delivery. Domain repositories own HH/sales/freelance behavior. Credential acquisition/storage belongs to the broker; engineering uses explicit bindings.

A capability has one canonical business implementation behind thin adapters. Compatibility code is removed only after its consumers have a verified replacement. Migration tasks and parity evidence live in [issues](https://github.com/trained-assist/software-engineering-playbooks/issues), not in a second extraction roadmap.

Shared ownership: [platform architecture](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md).
