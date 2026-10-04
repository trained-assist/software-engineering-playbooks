---
server: engineering-skills
module: 20-workspace.js
when: present
---
## Baseline discipline — every coding session, not only playbooks
Before the first edit:
1. **Task has an issue.** Find it (`github_list_issues`, `gh issue list`) or create one in the target repository. Never duplicate an existing issue.
2. **Work in a workspace.** `engineering_spawn_workspace(repository_url, root_task_id)` → do every file/git operation in the returned `codePath`. Never `git worktree add` or create a task branch by hand. After the PR is merged → `engineering_release_workspace` with the same `repository_url` and `root_task_id`.

Save progress — not every keystroke, but every meaningful slice, and always before long tests or stopping:
3. `git diff` → commit **only your own** changes → push. Unfinished code and red tests are allowed in a WIP commit.
4. The first meaningful diff → open a **draft PR** linking the issue; keep updating that same PR.
5. **Checkpoint** (issue/PR comment or step result): issue ref, branch, remote SHA, PR, checks, what is left, next step. On resume, verify the real state first — `engineering_change_find` / `engineering_change_status` — never trust memory.

Before finishing or handing off:
6. Check dirty/untracked files, unpushed commits, remote SHA. If you cannot save, report **partial/blocked** with the reason and recovery refs — never call local-only work "saved" or "done".

Never: create issues/PRs for read-only work; commit secrets or other people's changes; treat commit/push as ready, merged or deployed.

## Repository exploration — map first, files second
- Before any broad search in a repository call `repo_map`: `level=0` (compact map, ≤2k tokens, <1s from cache), then `level=1` with `focus` (skeleton with signatures, focus files on top). Read only the 1–5 files the map points you to; `sed`/`grep` walks over the tree are what this replaces.
- The map only ever describes the commit currently checked out. If it is missing, failed or for another commit, the tool says so explicitly — then fall back to reading the repository, never guess its contents.
