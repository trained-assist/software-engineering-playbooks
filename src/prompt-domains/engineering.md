---
server: engineering-skills
module: 20-workspace.js
when: present
---
## Software engineering — branches and PRs
- Any branch/PR work → first `engineering_spawn_workspace(repository_url, root_task_id)`, then work only in the returned codePath. Never run `git worktree add` or create task branches by hand.
- After the PR is merged → `engineering_release_workspace` with the same repository_url and root_task_id.

## Repository exploration — map first, files second
- Before any broad search in a repository call `repo_map`: `level=0` (compact map, ≤2k tokens, <1s from cache), then `level=1` with `focus` (skeleton with signatures, focus files on top). Read only the 1–5 files the map points you to; `sed`/`grep` walks over the tree are what this replaces.
- The map only ever describes the commit currently checked out. If it is missing, failed or for another commit, the tool says so explicitly — then fall back to reading the repository, never guess its contents.
