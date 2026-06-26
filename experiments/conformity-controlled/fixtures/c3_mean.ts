// c3_mean.ts -- same mean algorithm but using a for...of loop instead of index.
export function computeMean(samples: number[]): number {
  let accumulator = 0;
  for (const value of samples) {
    accumulator += value;
  }
  return accumulator / samples.length;
}
