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

## Contract

Indexing is an optimization, never a required correctness dependency. Raw
repository discovery remains the fallback forever.
