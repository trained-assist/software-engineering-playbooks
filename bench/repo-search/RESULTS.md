# engineering_repo_search — benchmark (#110)

Benchmark for the retrieval engine, run against a REAL checkout
(`trained-assist-agent` @ `31a11f7`, 629 indexed files → 3904 chunks).

    npm run bench:repo-search -- --repo <path>              # measure
    npm run bench:repo-search -- --repo <path> --integrity  # verify the labels first

`--integrity` re-checks every label against the checkout (expected file exists,
expected token inside it, absent token nowhere in the repo, ids unique, 30–50
queries). A dataset whose labels rot is worse than no dataset, so the integrity
gate fails instead of reporting fake numbers.

Dataset: `bench/repo-search/dataset.js` — 34 queries in four classes, because
they fail differently:

| class      | n  | what it catches                                                       |
|------------|----|-----------------------------------------------------------------------|
| exact      | 16 | the identifier itself; string equality must win                        |
| ru_en      | 6  | Russian question → English identifiers (cross-lingual)                |
| behavior   | 6  | "where does X happen", no identifier in the query                      |
| absent     | 6  | a mechanism the repo does NOT have; an empty answer is the right one    |

## Result (2026-10-04, embeddings on, `google/gemini-embedding-001` via OpenRouter)

| strategy | overall r@5 | exact | ru_en | behavior | absent empty@5 | median ms |
|----------|-------------|-------|-------|----------|----------------|-----------|
| keyword  | 0.571       | 1.000 | 0.000 | 0.000    | 0.000          | 164 |
| hybrid   | **0.679**   | 1.000 | 0.000 | 0.500    | 0.000          | 6485\* |
| auto     | 0.643       | 1.000 | 0.333 | 0.000    | 0.000          | 175 |
| current  | 0.643       | 1.000 | 0.000 | 0.333    | 0.000          | 92 |
| dense    | **0.946**   | 1.000 | 0.833 | 0.917    | 0.000          | 6537\* |

`current` = the production `engineering_repo_context` ranking, i.e. what the
codebase does today. `auto` = lexical first, semantic only when lexical has no
confident hit (an intermediate strategy that was measured and rejected).

\* hybrid/dense latency is measured against a warm cache that already holds all
3904 chunk vectors (259 MB); reading and rewriting that file dominates. Cold,
hybrid embeds only its lexical shortlist, dense embeds the whole chunk set —
measured ~19 min for 3904 chunks, once per revision, because the vector cache
lives in the per-revision directory.

## Decision

* **Default = `hybrid`.** It is the best strategy that does not pay the
  full-corpus embedding pass: 0.679 vs 0.571 lexical and 0.643 for the tool that
  exists today.
* **`dense` stays available, not default.** It is strictly better (0.946, and it
  is the only strategy that answers the cross-lingual class at all — 0.833 vs
  0) but it costs ~19 min cold per revision. Promoting it needs a vector cache
  that survives a new revision.
* **No mandatory service.** Embeddings are optional: without credentials
  `hybrid`/`dense` degrade to `keyword` and say so in `limitations`.

## Known gap (measured, not fixed here)

`absent empty@5 = 0` for EVERY strategy: a query about a mechanism the repository
does not have still returns its best lexical match instead of an empty answer.
The lexical ranker already demotes single-word coincidences (`weak-*`
`match_kind`) but never returns nothing. Honest-empty needs its own threshold
measurement — tracked separately, not silently folded in here.