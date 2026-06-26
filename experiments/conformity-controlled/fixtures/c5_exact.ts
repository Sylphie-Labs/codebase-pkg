// c5_exact.ts -- EXACT byte-for-byte copy of c1_mean's function body.
export function mean(numbers: number[]): number {
  let sum = 0;
  for (let i = 0; i < numbers.length; i++) {
    sum = sum + numbers[i];
  }
  return sum / numbers.length;
}
