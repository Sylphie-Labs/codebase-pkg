// r5_quicksort.ts -- quicksort with an explicit partition step.
export function quicksort(arr: number[]): number[] {
  if (arr.length <= 1) {
    return arr;
  }
  const pivot = arr[arr.length - 1];
  const less: number[] = [];
  const greater: number[] = [];
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] < pivot) {
      less.push(arr[i]);
    } else {
      greater.push(arr[i]);
    }
  }
  return [...quicksort(less), pivot, ...quicksort(greater)];
}
