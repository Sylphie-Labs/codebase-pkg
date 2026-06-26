// c1_mean.ts -- canonical arithmetic mean via indexed for loop + sum accumulator.
export function mean(numbers: number[]): number {
  let sum = 0;
  for (let i = 0; i < numbers.length; i++) {
    sum = sum + numbers[i];
  }
  return sum / numbers.length;
}
