---
server: engineering-skills
module: 20-workspace.js
when: present
---
## Software engineering — workspace and PRs
The coding baseline (issue before editing, progress checkpoints, opening a PR, the handoff check) is always on in the system prompt as the core domain `engineering-baseline`, and does NOT depend on this skill being mounted. This domain only adds the repo-specific mechanics.

## Definition of done for an engineering change
- Infer the intended result from the user's request and write a short, observable checklist before coding. Unless the user explicitly asks for a narrower deliverable, carry a change in an existing product through local/sandbox verification, commit and push, PR, green CI, merge, confirmed promotion of that exact revision, and a safe end-to-end check where the user actually receives the result. Keep working through failed checks and waits; a local edit or an opened PR is progress, not completion.
- Read the target repository's Environment Contract, deployment docs and workflows to identify its actual promotion and test paths. Use only the documented path and permitted test accounts/data in production. For a library, docs or tooling repository, identify its consumer and verify the delivered artifact there. If that path is unknown, complete the safe dev/test and PR/CI work, record the missing path and report the delivery criterion as open. Never infer that merge alone changed a live consumer.
- At handoff, state which checkpoints have evidence, which remain open, and the exact next action or blocker. Do not label an unverified change done.

- Any branch/PR work → first `engineering_spawn_workspace(repository_url, root_task_id)`, then work only in the returned codePath. Never run `git worktree add` or create task branches by hand.
- After the PR is merged → `engineering_release_workspace` with the same repository_url and root_task_id.
- Resuming after a break → `engineering_change_find` / `engineering_change_status` before trusting memory: they show which workspace, branch, commits and PR belong to the task, and which of written/committed/pushed/merged/delivered/verified is still missing.

## Repository exploration — map first, files second
- Before any broad search in a repository call `repo_map`: `level=0` (compact map, ≤2k tokens, <1s from cache), then `level=1` with `focus` (skeleton with signatures, focus files on top). Read only the 1–5 files the map points you to; `sed`/`grep` walks over the tree are what this replaces.
- The map only ever describes the commit currently checked out. If it is missing, failed or for another commit, the tool says so explicitly — then fall back to reading the repository, never guess its contents.
