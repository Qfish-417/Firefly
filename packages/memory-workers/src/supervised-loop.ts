import { setTimeout as waitFor } from "node:timers/promises";

export interface SupervisedLoopOptions {
  readonly signal: AbortSignal;
  /** Idle wait between successful cycles. */
  readonly interval_ms: number;
  /** First backoff after a failure; doubles per consecutive failure. */
  readonly initial_backoff_ms?: number;
  readonly max_backoff_ms?: number;
  readonly observe_error: (error: unknown, consecutiveFailures: number, backoffMs: number) => void;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Runs a worker cycle until aborted, keeping infrastructure failures inside the loop.
 *
 * `runBatch` isolates per-item errors, but the surrounding calls (claiming a batch, releasing a
 * lease) do not. Letting those escape terminates the process, which under a restart supervisor
 * becomes a hot crash-loop that re-claims and re-fails the same poison item with no backoff.
 */
export async function runSupervisedLoop(
  cycle: () => Promise<void>,
  options: SupervisedLoopOptions,
): Promise<void> {
  const initialBackoff = options.initial_backoff_ms ?? 1_000;
  const maxBackoff = options.max_backoff_ms ?? 60_000;
  if (options.interval_ms < 0 || initialBackoff < 1 || maxBackoff < initialBackoff) {
    throw new TypeError("Supervised loop intervals must be positive and ordered");
  }
  const wait = options.wait ?? ((milliseconds, signal) => waitFor(milliseconds, undefined, { signal }));
  let consecutiveFailures = 0;

  while (!options.signal.aborted) {
    let delayMs = options.interval_ms;
    try {
      await cycle();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      delayMs = Math.min(initialBackoff * 2 ** (consecutiveFailures - 1), maxBackoff);
      options.observe_error(error, consecutiveFailures, delayMs);
    }
    if (options.signal.aborted) return;
    try {
      await wait(delayMs, options.signal);
    } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
  }
}
