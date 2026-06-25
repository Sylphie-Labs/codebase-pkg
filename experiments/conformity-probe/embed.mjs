/**
 * embed.mjs -- tiny swappable embedding interface.
 *
 * Contract:  embed(texts: string[]): Promise<number[][]>
 *
 * Default backend is @xenova/transformers running fully in-process and
 * offline (after first-run weight download), mean-pooled + L2-normalized.
 *
 * Model: validation (see README) showed that on the signature-skeleton
 * category the small general model jina-embeddings-v2-small-en (~33MB,
 * 8192-ctx) SEPARATES the edit tiers ~9x wider than the 162MB code model
 * jina-embeddings-v2-base-code, which near-saturated and discretized on the
 * short canonical skeletons. So we use the small general model as primary; the
 * code model remains in the chain only as an option for future whole-body
 * categories. The chosen model id is printed once on first load.
 *
 * Swap the backend by passing a different `embedFn` anywhere this is used;
 * the unit tests, for example, never touch this module so they need no model.
 */

// Ordered preference list. First that loads wins. Primary is the small general
// model (best separation + smallest download per validation); the jina code
// model follows as an option for whole-body work; MiniLM is the last resort.
const MODEL_CANDIDATES = [
  'Xenova/jina-embeddings-v2-small-en',
  'jinaai/jina-embeddings-v2-base-code',
  'Xenova/all-MiniLM-L6-v2',
];

let _pipelinePromise = null;
export let CHOSEN_MODEL = null;

async function getPipeline() {
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

      const { pipeline } = await import('@xenova/transformers');
      let lastErr;
      for (const model of MODEL_CANDIDATES) {
        try {
          const extractor = await pipeline('feature-extraction', model);
          CHOSEN_MODEL = model;
          console.error(`[embed] using model: ${model}`);
          return extractor;
        } catch (err) {
          lastErr = err;
          console.error(`[embed] model ${model} failed to load: ${err?.message ?? err}`);
        }
      }
      throw new Error(`No embedding model could be loaded. Last error: ${lastErr?.message ?? lastErr}`);
    })();
  }
  return _pipelinePromise;
}

/**
 * Embed an array of strings into an array of vectors.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embed(texts) {
  if (!Array.isArray(texts)) throw new TypeError('embed expects string[]');
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out = [];
  for (const text of texts) {
    const tensor = await extractor(text, { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data));
  }
  return out;
}
