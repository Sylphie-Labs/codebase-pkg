/**
 * embed.ts -- tiny swappable embedding interface for the Conformity Judge.
 *
 * Contract:  embed(texts: string[]): Promise<number[][]>
 *
 * Default backend is @xenova/transformers running fully in-process and
 * offline (after first-run weight download), mean-pooled + L2-normalized.
 *
 * Model: validation (see experiments/conformity-probe/README.md) showed that
 * on the signature-skeleton category the small general model
 * jina-embeddings-v2-small-en (~33MB, 8192-ctx) SEPARATES the edit tiers ~9x
 * wider than the 162MB code model jina-embeddings-v2-base-code, which
 * near-saturated and discretized on the short canonical skeletons. So we use
 * the small general model as primary; the code model remains in the chain only
 * as an option for future whole-body categories. The chosen model id is printed
 * once on first load.
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
 * Ordered model preference list. The first that loads wins. Primary is the
 * small general model (best separation + smallest download per validation); the
 * jina code model follows as an option for whole-body work; MiniLM is the last
 * resort. Exported so init/download tooling can reuse the exact same chain.
 */
export const MODEL_CANDIDATES: readonly string[] = [
  'Xenova/jina-embeddings-v2-small-en',
  'jinaai/jina-embeddings-v2-base-code',
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
