/**
 * embed.ts -- tiny swappable embedding interface for the Conformity Judge.
 *
 * Contract:  embed(texts: string[]): Promise<number[][]>
 *
 * Default backend is @xenova/transformers running fully in-process and
 * offline (after first-run weight download), mean-pooled + L2-normalized.
 *
 * Model: the embedding REPRESENTATION is now the whole function body (lightly
 * normalized), not the old signature skeleton. Controlled validation
 * (experiments/conformity-controlled, experiments/conformity-corpus) showed
 * that on whole-body text the code model jinaai/jina-embeddings-v2-base-code
 * (768-dim) recovers similarity cleanly and separates functions, whereas the
 * earlier small GENERAL model (jina-embeddings-v2-small-en) only looked better
 * on the now-abandoned skeletons (short canonical strings that collapsed every
 * function to ~0 distance). So the code model is now PRIMARY; the small general
 * model and MiniLM remain only as fallbacks if it cannot load. The chosen model
 * id is printed once on first load.
 *
 * Swap the backend by passing a different `Embedder` anywhere this is used; the
 * unit tests, for example, never touch this module so they need no model.
 */

/**
 * A pluggable embedding backend. Any function with this shape can be injected
 * wherever the conformity engine needs vectors, so tests can use a deterministic
 * offline fake and production can use the real model.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * Ordered model preference list. The first that loads wins. Primary is the jina
 * code model (768-dim): validation showed whole-body embedding with the code
 * model recovers similarity, which is the representation the judge now uses. The
 * small general model and MiniLM follow only as fallbacks. Exported so
 * init/download tooling can reuse the exact same chain.
 *
 * NOTE: the primary emits 768-dim vectors -- EMBEDDING_DIM in schema.ts must
 * match. Changing the primary model's dimension is a schema migration.
 */
export const MODEL_CANDIDATES: readonly string[] = [
  'jinaai/jina-embeddings-v2-base-code',
  'Xenova/jina-embeddings-v2-small-en',
  'Xenova/all-MiniLM-L6-v2',
];

/** The model id actually loaded, or null before the first embed call. */
export let CHOSEN_MODEL: string | null = null;

type FeatureExtractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

let _pipelinePromise: Promise<FeatureExtractor> | null = null;

async function getPipeline(): Promise<FeatureExtractor> {
  if (!_pipelinePromise) {
    // Lazy import so merely importing this file does not pull the model in.
    _pipelinePromise = (async () => {
      // Clear any stale HuggingFace auth from the process env. The jina code
      // repo is public/Apache-2.0; a stale/invalid HF_TOKEN being sent as a
      // bearer credential is what produced the spurious 401 "Unauthorized" on
      // the earlier attempt. Unauthenticated requests succeed for public repos.
      delete process.env.HF_TOKEN;
      delete process.env.HUGGING_FACE_HUB_TOKEN;
      delete process.env.HF_ACCESS_TOKEN;
      delete process.env.HUGGINGFACE_HUB_TOKEN;

      // @xenova/transformers is a devDependency / optional runtime backend, so
      // it is imported dynamically and typed loosely to avoid a hard build dep.
      const transformers = await import('@xenova/transformers' as string);
      const pipeline = transformers.pipeline as (
        task: string,
        model: string,
      ) => Promise<FeatureExtractor>;

      let lastErr: unknown;
      for (const model of MODEL_CANDIDATES) {
        try {
          const extractor = await pipeline('feature-extraction', model);
          CHOSEN_MODEL = model;
          console.error(`[embed] using model: ${model}`);
          return extractor;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[embed] model ${model} failed to load: ${msg}`);
        }
      }
      const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`No embedding model could be loaded. Last error: ${lastMsg}`);
    })();
  }
  return _pipelinePromise;
}

/**
 * Embed an array of strings into an array of vectors using the default
 * @xenova/transformers backend (mean-pooled + L2-normalized).
 */
export const embed: Embedder = async (texts: string[]): Promise<number[][]> => {
  if (!Array.isArray(texts)) throw new TypeError('embed expects string[]');
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out: number[][] = [];
  for (const text of texts) {
    const tensor = await extractor(text, { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data));
  }
  return out;
};
