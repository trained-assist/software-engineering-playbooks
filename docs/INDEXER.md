# Repository indexer

Status: **v1 implemented** (deterministic, no LLM required). The raw repository
remains the correctness fallback forever — the index is an optimization.

## Goal

Precompute expensive/repetitive repository understanding so many coding sessions
can reuse it instead of rummaging the tree.

## On-disk contract

Built into `<repo>/.engineering/index/` (derived; add it to `.gitignore`):

```text
.engineering/index/
  revision.json    # schema version, repo identity, indexed revision, generatedAt
  files.json       # tracked file metadata: path,size,ext,language,lines,head
  modules.json     # top-level module groups + git-history hotspots
  symbols.json     # deterministic regex symbol scan: path,name,kind,line,text
  tests.json       # test files + test-path-by-source-stem map
```

`revision.json` always declares:

- `schemaVersion` — incompatible indexes are ignored;
- `repository.id` — derived from the git remote (or local name); a different
  repository's index is ignored;
- `revision` — the indexed commit; an index whose revision is not the requested
  base is stale and ignored;
- `generatedAt` — build timestamp.

## Build strategy (deterministic first)

- git tree/file metadata (`git ls-files`, `stat`, first line);
- lightweight language detection + regex symbol scan (no parser/LLM
  dependency);
- test naming/config relationships;
- git history hotspots (`git log --name-only`).

Semantic module summaries are a possible later addition (cheap model, optional,
off by default). Embeddings/vector search are an explicit non-goal.

## Build / refresh / check

```bash
node scripts/index-repo.js --repo <path> [--out <dir>] [--generated-at <iso>]
node scripts/index-repo.js --repo <path> --check   # exit 0 only if usable
```

Also exposed as `npm run index:build` / `npm run index:check`. A refresh is a
full deterministic rebuild in v1; nightly/incremental scheduling is a
non-goal.

## Consumers

- `prepare_task` accepts `prefer_index` (default true). If the index is missing,
  corrupt, built for a different schema/repo, or stale for the base revision, it
  transparently falls back to `raw-repo`. Indexing is never a required
  correctness dependency.
- `engineering_repo_context(keywords)` queries the index when fresh, otherwise
  uses the deterministic raw keyword ranking. No network, no LLM.
- `repo_map(repo, level, focus)` (`src/repo-map/`, issue #49) renders the
  compressed map (L0) and the skeleton (L1) on top of the same index. Call it
  before any broad search.

## Shared cache (repo-map)

Derived data does not belong inside a working tree: two checkouts of one commit
would each build their own copy, and every worktree would carry untracked
build output. The index and the maps therefore live together, keyed by commit:

```text
<workspacesRoot>/repo-maps/<repoId>/
  descriptions.json          # LLM one-liners, cached by module content hash
  <sha>/
    index/                   # the v1 index, same schema, different location
    map-l0.json              # rendered L0 map
    map-l1.json is rendered on read from index/ (focus is per call)
```

`<workspacesRoot>` is `ENGINEERING_WORKSPACE_ROOT`, else
`~/agent-data/engineering-workspaces` — the same root the workspaces and
mirrors use. Retention keeps the last 10 commits per repository; a per-sha lock
(`<sha>.lock`) makes concurrent builders (spawn hook + first `repo_map`)
produce exactly one map.

`resolveIndexRoot()` (in `src/repo-map/paths.js`) is the single seam every
reader goes through: a checkout that owns a legacy `.engineering/index` keeps
using it, a fresh worktree resolves the shared per-sha copy. Readers and
writers agree by construction, so a worktree with no local index still gets
`indexed-repo` context instead of silently falling back to raw.

Writers are `repo_map` itself (`buildMap`) and the workspace spawn hook
(`src/workspace/for-task.js`, fire-and-forget, `REPO_MAP_SPAWN_BUILD=0` turns
it off). A commit merged in main is picked up lazily: the first spawn or first
`repo_map` at the new sha builds it, no webhook.

## Contract

Indexing is an optimization, never a required correctness dependency. Raw
repository discovery remains the fallback forever. The same holds for maps:
`repo_map` never answers empty, never serves a map for a commit other than the
one checked out, and any failure tells the caller to read the repository.
