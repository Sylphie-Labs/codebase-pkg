# conformity-probe (experiment, NOT a feature)

A standalone "legibility probe." It does NOT touch the sync pipeline, Neo4j, or
the MCP server. Everything lives in this directory.

## The one question

Does per-category embedding distance track real code edits **monotonically**,
or does it just jitter?

- **GREEN** — distance grows across edit tiers (cosmetic < small-structural <
  divergent) AND cosmetic edits are ~zero after normalization. The
  embedding-distance conformity mechanism is real and worth building.
- **RED** — distances jitter / don't separate edit tiers. Normalization is the
  real first problem before distance is trustworthy.

## What it does

- Category under test: `function:signature-skeleton` (derived from each parsed
  function's `args` + `returnType`, never the body).
- Embeds codebase-pkg's own `src/` functions into a pool (local, in-process,
  offline via `@xenova/transformers`, mean-pooled + normalized). Primary model
  is the small general `Xenova/jina-embeddings-v2-small-en` (~33MB), which
  validation found separates edit tiers best on signature skeletons; it falls
  back through `jinaai/jina-embeddings-v2-base-code` →
  `Xenova/all-MiniLM-L6-v2`. The chosen model id is printed on first load.
- Distance = mean cosine distance to a chunk's k=5 nearest neighbors in the
  pool (kNN, not centroid).
- Synthesizes graded edits of N sample functions (cosmetic / small-structural /
  divergent), measures each variant's pool distance excluding the original, and
  reports the delta — in **two modes, raw vs normalized**, because "how much
  normalization is needed" is exactly what's being measured.

## How to run

```sh
npm run build                                  # compile the parser to dist/
node --test experiments/conformity-probe/probe.test.mjs   # pure-helper tests (no model)
node experiments/conformity-probe/run.mjs      # full probe (downloads model on first run)
```

## How to read the verdict

Look at the bottom line. Within each mode, compare the per-tier mean deltas:
cosmetic should be ≈0 (especially normalized), small-structural larger, and
divergent largest. The `jitter` number is `|cosmetic delta|` — under
normalization it should be near zero. The final `VERDICT: GREEN/RED` applies the
thresholds to the **normalized** mode.

### Baseline (MiniLM general model, RED — saturated)

With the general model `Xenova/all-MiniLM-L6-v2`, normalization cleanly zeroed
cosmetic edits (jitter 0.0000), but normalized distance SATURATED:
small-structural (+0.063) and divergent (+0.062) landed at nearly the same
distance — the embedding registered "differs / does not," not "how much." RED.

### Current (small general model + real default-param signal, GREEN)

Two changes broke the saturation:

1. Swapped off MiniLM to `Xenova/jina-embeddings-v2-small-en`.
2. The TS parser (`extractArgsFromNode`) now captures `hasDefault`/`defaultText`
   per parameter, so real parsed functions surface a `DEFAULT` marker in the
   normalized skeleton — adding genuine structural signal without going to
   whole-body.

Observed normalized mean deltas: cosmetic +0.0000, small-structural +0.0173,
divergent +0.0387. Cosmetic stays perfectly zeroed, and divergent is clearly
~2.2× small-structural — distance tracks edit magnitude monotonically. GREEN.

### Model choice: the code model was tested and lost

`jinaai/jina-embeddings-v2-base-code` is **not** gated (an earlier `Unauthorized`
401 was a stale `HF_TOKEN`; the repo is public/Apache-2.0). When actually run on
this signature-skeleton category it was GREEN but near-saturated — divergent vs
small-structural margin only +0.0024, versus +0.022 for the small general model
(~9× wider), with suspicious distance discretization (identical divergent deltas
across all samples). Likely because a code-trained model treats a ~4-token
canonical skeleton as out-of-distribution. So the **small general model is the
pick** here, at 1/5 the download (~33MB vs ~162MB). Revisit the code model only
if whole-body categories are added.

NOTE / follow-up: the Python parser (`src/sync/python-parser`) has the same gap
— it does not yet capture default-parameter presence — so the `param-defaults`
axis is still unmeasurable on the Python path. Not implemented here.
