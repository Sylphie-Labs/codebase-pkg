/**
 * bakeoff.mjs -- Docker-free corpus "bake-off" for redesigned conformity primitives.
 *
 * The current shipped conformity signal embeds normalized signature SKELETONS and
 * measures kNN cosine distance. At corpus scale it fails to separate in-repo from
 * foreign code (AUROC ~0.5). This experiment tests two redesigned primitives head
 * to head, BEFORE any rewrite of src/, to decide the fix direction:
 *
 *   Primitive A -- embedding redirect: embed WHOLE function BODIES (lightly
 *     normalized -- strip comments, collapse whitespace, KEEP identifiers/literals)
 *     with the jina CODE model, score with both (1) kNN mean cosine distance and
 *     (2) LOF (Local Outlier Factor) over L2-normalized embeddings.
 *
 *   Primitive B -- n-gram cache LM ("naturalness of software"): a lexical trigram
 *     model with Jelinek-Mercer backoff + a cache component (localness), scored as
 *     cross-entropy bits/token over non-separator tokens.
 *
 * Metric (the whole point): separation of in-repo (leave-one-out, negatives) vs
 * foreign (positives) -- AUROC per foreign repo + pooled, distribution stats, and
 * the foreign flag-rate at a threshold calibrated to 95% TPR on self (95th pct of
 * self scores). Good separation = foreign flag rate >> 5%.
 *
 * Reuses corpus.mjs's corpus-load + foreign-repo logic and the shipped engine
 * modules from dist/. Does NOT touch src/. Real local model, no Docker/API/tokens.
 *
 * Output: comparison table to stdout + bakeoff-report.json with raw numbers,
 * ending in a one-line VERDICT.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { walk } from './walk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = (rel) => pathToFileURL(path.join(REPO_ROOT, 'dist', rel)).href;

// --- shipped engine modules (compiled) -------------------------------------
const { parseFiles } = await import(DIST('sync/parser.js'));
const { knnPoolDistance, cosineDistance } = await import(DIST('conformity/distance.js'));
const { nodeIdOf } = await import(DIST('conformity/store.js'));

// jina code model id -- loaded directly here (NOT via the shipped embed.ts, whose
// candidate chain prefers the small general model). We replicate embed.ts's
// stale-HF-token clearing and mean-pool + L2-normalize contract.
const CODE_MODEL = 'jinaai/jina-embeddings-v2-base-code';
let ACTUAL_MODEL = null;

const K_KNN = 5; // kNN mean-distance neighbors (matches shipped DEFAULT_K)
const K_LOF = 20; // LOF neighborhood (brief: "a reasonable k like 20")
const FOREIGN_ROOTS = ['../memory-pkg', '../drift-detector'];

// ===========================================================================
// embedding backend -- jina code model, mean-pooled + L2-normalized
// ===========================================================================

let _pipelinePromise = null;
async function getPipeline() {
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      // Clear stale HF auth (see embed.ts rationale -- avoids spurious 401 on
      // the public Apache-2.0 jina code repo).
      delete process.env.HF_TOKEN;
      delete process.env.HUGGING_FACE_HUB_TOKEN;
      delete process.env.HF_ACCESS_TOKEN;
      delete process.env.HUGGINGFACE_HUB_TOKEN;
      const transformers = await import('@xenova/transformers');
      const extractor = await transformers.pipeline('feature-extraction', CODE_MODEL);
      ACTUAL_MODEL = CODE_MODEL;
      console.error(`[bakeoff] using code model: ${CODE_MODEL}`);
      return extractor;
    })();
  }
  return _pipelinePromise;
}

/** Embed strings -> mean-pooled + L2-normalized vectors (same contract as embed.ts). */
async function embedCode(texts) {
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out = [];
  for (const text of texts) {
    const tensor = await extractor(text, { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data));
  }
  return out;
}

// ===========================================================================
// representation builders
// ===========================================================================

/**
 * Light normalization of a whole function body for Primitive A: strip comments,
 * collapse runs of whitespace to single spaces, trim. KEEP identifiers and
 * literals (do NOT skeletonize). Block + line comments removed with a tolerant
 * regex (string-literal edge cases are acceptable noise for this experiment).
 */
function lightNormalizeBody(bodyText) {
  if (!bodyText) return '';
  let s = bodyText;
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (avoid :// in URLs)
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Lexical code tokenizer for Primitive B. Splits source into:
 *   - identifiers / keywords  (\w+)
 *   - numbers                 (handled by \w+ but we tag separately below)
 *   - string literals         '...' "..." `...`  -> single token kind
 *   - operators / punctuation -> each run as its own token
 * Returns tokens as { t: text, sep: boolean } where sep marks pure
 * punctuation/whitespace tokens (excluded from the bits/token average).
 */
function tokenizeCode(src) {
  if (!src) return [];
  const tokens = [];
  // Order matters: strings first, then idents/numbers, then operators.
  const re =
    /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([A-Za-z_$][\w$]*)|(\d[\w.]*)|(\s+)|([^\sA-Za-z0-9_$])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) tokens.push({ t: '"STR"', sep: false }); // collapse string literal value, keep kind
    else if (m[2] !== undefined) tokens.push({ t: m[2], sep: false }); // ident/keyword
    else if (m[3] !== undefined) tokens.push({ t: 'NUM', sep: false }); // number kind
    else if (m[4] !== undefined) {
      /* whitespace -> skip entirely (separator, not even a token) */
    } else if (m[5] !== undefined) tokens.push({ t: m[5], sep: true }); // single punct/operator char
  }
  return tokens;
}

// ===========================================================================
// LOF (Local Outlier Factor) over L2-normalized embeddings
// ===========================================================================
//
// We use cosine DISTANCE (1 - cos) as the metric. On L2-normalized vectors cosine
// distance is monotonic in squared euclidean distance, so cosine and euclidean
// k-NN orderings are identical; we state cosine for consistency with the shipped
// kNN signal. Standard LOF:
//   k-distance(p)      = distance to p's k-th nearest neighbor
//   N_k(p)             = the k nearest neighbors of p
//   reach-dist_k(p,o)  = max(k-distance(o), d(p,o))
//   lrd_k(p)           = 1 / ( mean_{o in N_k(p)} reach-dist_k(p,o) )
//   LOF_k(p)           = mean_{o in N_k(p)} lrd_k(o) / lrd_k(p)
// LOF ~1 = inlier; >>1 = outlier.

/** Pairwise cosine distance matrix is O(n^2); fine for a few-hundred-fn pool. */
function lofScores(refVectors, queryVectors, queryIsRef, k) {
  // refVectors: pool used to define density. queryVectors: points to score.
  // queryIsRef: if true, each query i is refVectors[i] and is excluded from its
  // own neighbor set (leave-one-out). If false (foreign), queries are scored
  // against the full ref pool (no exclusion).
  const n = refVectors.length;
  const kEff = Math.min(k, n - 1);

  // Precompute k-distance and N_k for every REF point (needed for reach-dist/lrd).
  const refNeighbors = new Array(n); // array of { idx, dist } sorted asc, length kEff
  const refKDist = new Array(n);
  for (let i = 0; i < n; i++) {
    const ds = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      ds.push({ idx: j, dist: cosineDistance(refVectors[i], refVectors[j]) });
    }
    ds.sort((a, b) => a.dist - b.dist);
    refNeighbors[i] = ds.slice(0, kEff);
    refKDist[i] = ds[kEff - 1]?.dist ?? 0;
  }

  // lrd for every ref point.
  const refLrd = new Array(n);
  for (let i = 0; i < n; i++) {
    let sumReach = 0;
    for (const { idx, dist } of refNeighbors[i]) {
      sumReach += Math.max(refKDist[idx], dist);
    }
    const meanReach = sumReach / refNeighbors[i].length;
    refLrd[i] = meanReach === 0 ? Infinity : 1 / meanReach;
  }

  // Score each query.
  const scores = [];
  for (let q = 0; q < queryVectors.length; q++) {
    const qv = queryVectors[q];
    const selfIdx = queryIsRef ? q : -1;
    // neighbors of the query among ref points
    const ds = [];
    for (let j = 0; j < n; j++) {
      if (j === selfIdx) continue;
      ds.push({ idx: j, dist: cosineDistance(qv, refVectors[j]) });
    }
    ds.sort((a, b) => a.dist - b.dist);
    const nbrs = ds.slice(0, kEff);

    // lrd of the query itself
    let sumReach = 0;
    for (const { idx, dist } of nbrs) sumReach += Math.max(refKDist[idx], dist);
    const meanReach = sumReach / nbrs.length;
    const qLrd = meanReach === 0 ? Infinity : 1 / meanReach;

    // LOF = mean(neighbor lrd) / query lrd
    let sumNbrLrd = 0;
    for (const { idx } of nbrs) sumNbrLrd += refLrd[idx];
    const meanNbrLrd = sumNbrLrd / nbrs.length;
    let lof;
    if (!isFinite(qLrd) && !isFinite(meanNbrLrd)) lof = 1;
    else if (!isFinite(qLrd)) lof = 0; // query in a zero-distance cluster -> dense inlier
    else lof = meanNbrLrd / qLrd;
    scores.push(lof);
  }
  return scores;
}

// ===========================================================================
// n-gram cache language model (naturalness)
// ===========================================================================

/**
 * Trigram model with Jelinek-Mercer interpolation backoff (tri/bi/unigram) plus a
 * per-document cache component. Trained on a token stream; scores a token list as
 * cross-entropy bits/token over NON-separator tokens.
 */
class NgramCacheLM {
  constructor({ lambda3 = 0.7, lambda2 = 0.2, lambda1 = 0.099, lambdaCache = 0.4, vocabFloor = 1 } = {}) {
    this.uni = new Map();
    this.bi = new Map(); // key "w1 w2"
    this.tri = new Map(); // key "w1 w2 w3"
    this.biCtx = new Map(); // count of context w1
    this.triCtx = new Map(); // count of context w1 w2
    this.total = 0;
    this.vocab = new Set();
    this.lambda3 = lambda3;
    this.lambda2 = lambda2;
    this.lambda1 = lambda1;
    this.lambdaCache = lambdaCache; // weight on the cache mixture
    this.vocabFloor = vocabFloor;
  }

  static inc(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  /** Train on a flat token-text stream (array of strings), spanning files. */
  train(streams) {
    for (const stream of streams) {
      let w1 = null;
      let w2 = null;
      for (const w of stream) {
        NgramCacheLM.inc(this.uni, w);
        this.vocab.add(w);
        this.total++;
        if (w2 !== null) {
          NgramCacheLM.inc(this.bi, w2 + ' ' + w);
          NgramCacheLM.inc(this.biCtx, w2);
        }
        if (w1 !== null && w2 !== null) {
          NgramCacheLM.inc(this.tri, w1 + ' ' + w2 + ' ' + w);
          NgramCacheLM.inc(this.triCtx, w1 + ' ' + w2);
        }
        w1 = w2;
        w2 = w;
      }
    }
  }

  /** Smoothed P(w | w1,w2) via JM interpolation over tri/bi/unigram. */
  pBackoff(w1, w2, w) {
    const V = Math.max(this.vocab.size, this.vocabFloor);
    // unigram with add-1 over vocab (handles OOV gracefully)
    const pUni = ((this.uni.get(w) ?? 0) + 1) / (this.total + V);
    // bigram
    let pBi = pUni;
    if (w2 !== null) {
      const cCtx = this.biCtx.get(w2) ?? 0;
      if (cCtx > 0) {
        const c = this.bi.get(w2 + ' ' + w) ?? 0;
        pBi = this.lambda2 * (c / cCtx) + (1 - this.lambda2) * pUni;
      }
    }
    // trigram
    let pTri = pBi;
    if (w1 !== null && w2 !== null) {
      const ctxKey = w1 + ' ' + w2;
      const cCtx = this.triCtx.get(ctxKey) ?? 0;
      if (cCtx > 0) {
        const c = this.tri.get(ctxKey + ' ' + w) ?? 0;
        pTri = this.lambda3 * (c / cCtx) + (1 - this.lambda3) * pBi;
      } else {
        pTri = pBi;
      }
    }
    return pTri;
  }

  /**
   * Cross-entropy bits/token over non-separator tokens of `tokens`
   * (array of { t, sep }). Cache: probability of a token is mixed with its
   * relative frequency among tokens already seen earlier in THIS document
   * (the localness effect), so repeated local identifiers become cheap.
   */
  scoreBitsPerToken(tokens) {
    let w1 = null;
    let w2 = null;
    let bits = 0;
    let counted = 0;
    const cacheCounts = new Map();
    let cacheTotal = 0;

    for (const tok of tokens) {
      const w = tok.t;
      let pModel = this.pBackoff(w1, w2, w);
      // cache component: relative freq of w among prior tokens in this doc
      let pFinal = pModel;
      if (cacheTotal > 0) {
        const pCache = (cacheCounts.get(w) ?? 0) / cacheTotal;
        pFinal = (1 - this.lambdaCache) * pModel + this.lambdaCache * pCache;
      }
      if (pFinal <= 0) pFinal = 1e-12;
      if (!tok.sep) {
        bits += -Math.log2(pFinal);
        counted++;
      }
      // update cache + history (cache includes separators as context but they
      // aren't scored; keeping them stabilizes local n-gram context)
      cacheCounts.set(w, (cacheCounts.get(w) ?? 0) + 1);
      cacheTotal++;
      w1 = w2;
      w2 = w;
    }
    return counted > 0 ? bits / counted : null;
  }
}

// ===========================================================================
// stats helpers
// ===========================================================================

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
const median = (xs) => percentile(xs, 0.5);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function distSummary(xs) {
  return {
    count: xs.length,
    median: median(xs),
    p90: percentile(xs, 0.9),
    p95: percentile(xs, 0.95),
    mean: mean(xs),
  };
}

/**
 * AUROC via the Mann-Whitney U statistic (rank-sum), with tie handling.
 * positives should score HIGHER than negatives for AUROC > 0.5.
 * Here positives = foreign scores, negatives = self-LOO scores.
 */
function auroc(positives, negatives) {
  const nPos = positives.length;
  const nNeg = negatives.length;
  if (nPos === 0 || nNeg === 0) return null;
  const all = [
    ...positives.map((v) => ({ v, pos: true })),
    ...negatives.map((v) => ({ v, pos: false })),
  ];
  all.sort((a, b) => a.v - b.v);
  // assign average ranks (1-based), handling ties
  let i = 0;
  const ranks = new Array(all.length);
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let r = i; r <= j; r++) ranks[r] = avgRank;
    i = j + 1;
  }
  let sumRankPos = 0;
  for (let r = 0; r < all.length; r++) if (all[r].pos) sumRankPos += ranks[r];
  const U = sumRankPos - (nPos * (nPos + 1)) / 2;
  return U / (nPos * nNeg);
}

/** Fraction of xs strictly greater than threshold t. */
const flagRate = (xs, t) => (xs.length ? xs.filter((d) => d > t).length / xs.length : null);

function fmt(x) {
  return x === null || x === undefined ? ' n/a  ' : x.toFixed(4);
}
function pct(x) {
  return x === null || x === undefined ? ' n/a ' : (x * 100).toFixed(1) + '%';
}

// ===========================================================================
// corpus loading (reuses walk + parseFiles + nodeIdOf from the harness)
// ===========================================================================

/** Parse files -> [{ nodeId, name, filePath, body (normalized), tokens }]. */
function recordsFromFiles(files) {
  const parsed = parseFiles(files);
  const records = [];
  for (const file of parsed) {
    for (const fn of file.functions ?? []) {
      const raw = fn.bodyText ?? '';
      const body = lightNormalizeBody(raw);
      if (!body) continue; // nothing to embed/score
      records.push({
        nodeId: nodeIdOf(fn),
        name: fn.name,
        filePath: fn.filePath,
        body,
        tokens: tokenizeCode(raw),
      });
    }
  }
  return records;
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  const t0 = Date.now();
  const report = { meta: {}, pool: {}, primitives: {}, foreign: {}, verdict: null };

  // --- 1. POOL (codebase-pkg/src) ------------------------------------------
  const srcDir = path.join(REPO_ROOT, 'src');
  const srcFiles = walk(srcDir);
  console.log(`\n=== BUILD POOL ===`);
  console.log(`Walked ${srcFiles.length} source files under ${srcDir}`);
  const poolRecords = recordsFromFiles(srcFiles);
  console.log(`Pool functions (non-empty body): ${poolRecords.length}`);
  if (poolRecords.length === 0) {
    console.error('Empty pool -- aborting.');
    process.exit(1);
  }

  // --- 2. FOREIGN corpora ---------------------------------------------------
  const foreignSets = [];
  for (const rel of FOREIGN_ROOTS) {
    const absRoot = path.resolve(REPO_ROOT, rel);
    const name = path.basename(absRoot);
    if (!fs.existsSync(absRoot)) {
      console.log(`  [${name}] MISSING at ${absRoot} -- skipped.`);
      report.foreign[name] = { skipped: true, reason: 'path missing' };
      continue;
    }
    const files = walk(absRoot);
    const recs = recordsFromFiles(files);
    console.log(`  [${name}] files=${files.length}  functions=${recs.length}`);
    foreignSets.push({ name, records: recs });
    report.foreign[name] = { skipped: false, files: files.length, functions: recs.length };
  }

  // --- 3. PRIMITIVE A: embed whole bodies with the code model --------------
  console.log(`\n=== PRIMITIVE A: embed whole bodies (jina code model) ===`);
  console.log(`Embedding ${poolRecords.length} pool bodies ...`);
  const poolVecs = await embedCode(poolRecords.map((r) => r.body));
  poolRecords.forEach((r, i) => (r.vec = poolVecs[i]));

  for (const fs_ of foreignSets) {
    console.log(`Embedding ${fs_.records.length} foreign bodies [${fs_.name}] ...`);
    const v = await embedCode(fs_.records.map((r) => r.body));
    fs_.records.forEach((r, i) => (r.vec = v[i]));
  }

  // A.1 kNN mean cosine distance ------------------------------------------
  // self: leave-one-out (exclude own nodeId). foreign: vs full pool.
  console.log(`Scoring A.kNN (k=${K_KNN}) and A.LOF (k=${K_LOF}) ...`);
  const selfKnn = [];
  for (let i = 0; i < poolRecords.length; i++) {
    const peers = poolVecs.filter((_, j) => j !== i);
    selfKnn.push(knnPoolDistance(poolVecs[i], peers, K_KNN));
  }
  const foreignKnn = {};
  for (const fs_ of foreignSets) {
    foreignKnn[fs_.name] = fs_.records.map((r) => knnPoolDistance(r.vec, poolVecs, K_KNN));
  }

  // A.2 LOF ----------------------------------------------------------------
  const selfLof = lofScores(poolVecs, poolVecs, true, K_LOF);
  const foreignLof = {};
  for (const fs_ of foreignSets) {
    foreignLof[fs_.name] = lofScores(
      poolVecs,
      fs_.records.map((r) => r.vec),
      false,
      K_LOF,
    );
  }

  // --- 4. PRIMITIVE B: n-gram cache LM -------------------------------------
  console.log(`\n=== PRIMITIVE B: n-gram cache LM (naturalness) ===`);
  // self LOO: train on pool EXCLUDING the scored function's FILE, then score it.
  // To keep this tractable we train one model per distinct file (exclude that
  // file's tokens), reused for all functions in that file.
  const filesInPool = [...new Set(poolRecords.map((r) => r.filePath))];
  console.log(`Self-LOO over ${filesInPool.length} distinct pool files ...`);
  const tokensByFile = new Map();
  for (const r of poolRecords) {
    if (!tokensByFile.has(r.filePath)) tokensByFile.set(r.filePath, []);
    tokensByFile.get(r.filePath).push(r.tokens.map((t) => t.t));
  }
  const selfNgram = [];
  for (const file of filesInPool) {
    const lm = new NgramCacheLM();
    const trainStreams = [];
    for (const [f, streams] of tokensByFile) {
      if (f === file) continue;
      trainStreams.push(...streams);
    }
    lm.train(trainStreams);
    for (const r of poolRecords) {
      if (r.filePath !== file) continue;
      const s = lm.scoreBitsPerToken(r.tokens);
      if (s !== null) selfNgram.push(s);
    }
  }

  // foreign: train on FULL pool, score each foreign function.
  console.log(`Training full-pool n-gram model for foreign scoring ...`);
  const fullLm = new NgramCacheLM();
  fullLm.train([...tokensByFile.values()].flat());
  const foreignNgram = {};
  for (const fs_ of foreignSets) {
    foreignNgram[fs_.name] = [];
    for (const r of fs_.records) {
      const s = fullLm.scoreBitsPerToken(r.tokens);
      if (s !== null) foreignNgram[fs_.name].push(s);
    }
  }

  // --- 5. METRICS ----------------------------------------------------------
  const foreignNames = foreignSets.map((f) => f.name);

  function buildRow(label, selfScores, foreignScoresByName) {
    const selfP95 = percentile(selfScores, 0.95); // 95% TPR threshold on self
    const pooledForeign = foreignNames.flatMap((n) => foreignScoresByName[n]);
    const row = {
      label,
      self: distSummary(selfScores),
      selfThresholdP95: selfP95,
      selfFlagRate: flagRate(selfScores, selfP95),
      perForeign: {},
      aurocPooled: auroc(pooledForeign, selfScores),
      foreignFlagRatePooled: flagRate(pooledForeign, selfP95),
    };
    for (const n of foreignNames) {
      row.perForeign[n] = {
        ...distSummary(foreignScoresByName[n]),
        auroc: auroc(foreignScoresByName[n], selfScores),
        flagRateAtSelfP95: flagRate(foreignScoresByName[n], selfP95),
      };
    }
    return row;
  }

  const rowKnn = buildRow('A:kNN', selfKnn, foreignKnn);
  const rowLof = buildRow('A:LOF', selfLof, foreignLof);
  const rowNgram = buildRow('B:ngram-cache', selfNgram, foreignNgram);
  const rows = [rowKnn, rowLof, rowNgram];

  report.meta = {
    model: ACTUAL_MODEL,
    kKnn: K_KNN,
    kLof: K_LOF,
    lofMetric: 'cosine distance on L2-normalized vectors',
    poolSize: poolRecords.length,
    elapsedSec: null,
  };
  report.pool = { size: poolRecords.length, files: srcFiles.length };
  report.primitives = { rowKnn, rowLof, rowNgram };

  // --- 6. COMPARISON TABLE -------------------------------------------------
  console.log(`\n========================= COMPARISON TABLE =========================`);
  const hdr = [
    'primitive'.padEnd(14),
    `AUROC:${foreignNames[0] ?? 'f1'}`.padStart(18),
    `AUROC:${foreignNames[1] ?? 'f2'}`.padStart(18),
    'AUROC:pooled'.padStart(13),
    'fgFlag@95'.padStart(11),
    'selfFlag'.padStart(10),
  ].join(' ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const row of rows) {
    const a0 = foreignNames[0] ? row.perForeign[foreignNames[0]].auroc : null;
    const a1 = foreignNames[1] ? row.perForeign[foreignNames[1]].auroc : null;
    console.log(
      [
        row.label.padEnd(14),
        fmt(a0).padStart(18),
        fmt(a1).padStart(18),
        fmt(row.aurocPooled).padStart(13),
        pct(row.foreignFlagRatePooled).padStart(11),
        pct(row.selfFlagRate).padStart(10),
      ].join(' '),
    );
  }
  console.log('-'.repeat(hdr.length));

  console.log(`\nDistribution stats (median / p90 / p95):`);
  for (const row of rows) {
    console.log(`  ${row.label}`);
    console.log(
      `    self   : median=${fmt(row.self.median)} p90=${fmt(row.self.p90)} p95=${fmt(row.self.p95)}`,
    );
    for (const n of foreignNames) {
      const f = row.perForeign[n];
      console.log(`    ${n.padEnd(16)}: median=${fmt(f.median)} p90=${fmt(f.p90)} p95=${fmt(f.p95)}`);
    }
  }

  console.log(`\nFlag-rate trade-off @ threshold = 95th pct of self (==> ~5% self by construction):`);
  for (const row of rows) {
    const cols = foreignNames.map((n) => `${n}=${pct(row.perForeign[n].flagRateAtSelfP95)}`).join('  ');
    console.log(`  ${row.label.padEnd(14)} self=${pct(row.selfFlagRate)}  ${cols}  pooled=${pct(row.foreignFlagRatePooled)}`);
  }

  // --- 7. VERDICT ----------------------------------------------------------
  // Best = highest pooled AUROC. Clears the bar if pooled AUROC >= 0.70.
  let best = rows[0];
  for (const r of rows) if ((r.aurocPooled ?? 0) > (best.aurocPooled ?? 0)) best = r;
  const anyClears = rows.some((r) => (r.aurocPooled ?? 0) >= 0.7);
  const verdict =
    `VERDICT: ${best.label} separates best (pooled AUROC=${fmt(best.aurocPooled)}). ` +
    (anyClears
      ? `At least one primitive clears AUROC~0.70.`
      : `NO primitive clears AUROC~0.70 -- separation still weak.`);
  report.verdict = verdict;
  report.meta.elapsedSec = Math.round((Date.now() - t0) / 1000);

  console.log(`\n${verdict}`);
  console.log(`(elapsed ${report.meta.elapsedSec}s, model=${ACTUAL_MODEL})`);

  const outPath = path.join(__dirname, 'bakeoff-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote raw numbers to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
