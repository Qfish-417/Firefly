/**
 * Maps over items with a hard cap on how many operations run at once.
 *
 * `Promise.all(items.map(...))` starts every operation immediately. For document hydration that
 * means one concurrent object download per document — a 10k-document task opens 10k connections and
 * can hold 10k object bodies in memory at once. Results keep input order so callers stay
 * deterministic.
 */
export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1_000) {
    throw new TypeError("Concurrency must be between 1 and 1000");
  }
  if (items.length === 0) return [];
  const effective = Math.min(concurrency, items.length);
  const results = new Array<Output>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length || failed) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        // Record the first failure and stop starting new work; in-flight operations still settle so
        // nothing is left as an unhandled rejection.
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: effective }, () => worker()));
  if (failed) throw failure;
  return results;
}
