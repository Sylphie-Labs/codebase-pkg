// c4_mean.ts -- same approach as c1 with an empty-array guard and a separate
// division step. Still a manual accumulator loop computing the arithmetic mean.
export function arithmeticMean(data: number[]): number {
  if (data.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const result = sum / data.length;
  return result;
}
