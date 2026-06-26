// r3_retry.ts -- async retry wrapper with exponential backoff.
export async function retry<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      const delay = 100 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
