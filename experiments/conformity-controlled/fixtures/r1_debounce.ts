// r1_debounce.ts -- debounce higher-order function using setTimeout.
export function debounce(fn: (...a: unknown[]) => void, waitMs: number): (...a: unknown[]) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: unknown[]): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn(...args);
    }, waitMs);
  };
}
