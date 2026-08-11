import { createHash } from "node:crypto";
import { setTimeout as waitFor } from "node:timers/promises";

import type { MemoryRepository } from "@firefly/persistence";

export interface DeletionReconciliationCycle {
  readonly cycle_id: string;
  readonly scheduler_id: string;
  readonly instance_id: string;
  readonly status: "completed" | "failed";
  readonly stale_before: string;
  readonly batch_limit: number;
  readonly requeued_count: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly error?: {
    readonly code: "RECONCILIATION_FAILED";
    readonly message: string;
  };
}

export interface DeletionReconciliationSnapshot {
  readonly running: boolean;
  readonly observer_failures: number;
  readonly last_cycle?: DeletionReconciliationCycle;
}

export interface DeletionReconciliationSchedulerOptions {
  readonly scheduler_id: string;
  readonly instance_id: string;
  readonly memories: Pick<MemoryRepository, "reconcileFailedDeletionTargets">;
  readonly interval_ms?: number;
  readonly stale_after_ms?: number;
  readonly batch_limit?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observe?: (cycle: DeletionReconciliationCycle) => void;
}

export class DeletionReconciliationScheduler {
  private readonly options: DeletionReconciliationSchedulerOptions;
  private activeCycle: Promise<DeletionReconciliationCycle> | undefined;
  private loopRunning = false;
  private sequence = 0;
  private observerFailures = 0;
  private lastCycle: DeletionReconciliationCycle | undefined;

  constructor(options: DeletionReconciliationSchedulerOptions) {
    validateOptions(options);
    this.options = options;
  }

  snapshot(): DeletionReconciliationSnapshot {
    return {
      running: this.loopRunning || Boolean(this.activeCycle),
      observer_failures: this.observerFailures,
      ...(this.lastCycle ? { last_cycle: this.lastCycle } : {}),
    };
  }

  runOnce(): Promise<DeletionReconciliationCycle> {
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.executeCycle();
    this.activeCycle = cycle;
    void cycle.finally(() => {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    });
    return cycle;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.loopRunning) throw new TypeError("Deletion reconciliation scheduler loop is already running");
    this.loopRunning = true;
    try {
      while (!signal.aborted) {
        await this.runOnce();
        if (signal.aborted) break;
        try {
          await (this.options.wait ?? abortableWait)(this.intervalMs(), signal);
        } catch (error) {
          if (signal.aborted && isAbortError(error)) break;
          throw error;
        }
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private async executeCycle(): Promise<DeletionReconciliationCycle> {
    const startedAt = this.now();
    const staleBefore = new Date(startedAt.getTime() - this.staleAfterMs());
    const cycleId = cycleIdentity(this.options, startedAt, this.sequence++);
    let cycle: DeletionReconciliationCycle;
    try {
      const requeued = await this.options.memories.reconcileFailedDeletionTargets({
        stale_before: staleBefore,
        limit: this.batchLimit(),
        now: startedAt,
      });
      cycle = {
        cycle_id: cycleId,
        scheduler_id: this.options.scheduler_id,
        instance_id: this.options.instance_id,
        status: "completed",
        stale_before: staleBefore.toISOString(),
        batch_limit: this.batchLimit(),
        requeued_count: requeued,
        started_at: startedAt.toISOString(),
        completed_at: this.now().toISOString(),
      };
    } catch (error) {
      cycle = {
        cycle_id: cycleId,
        scheduler_id: this.options.scheduler_id,
        instance_id: this.options.instance_id,
        status: "failed",
        stale_before: staleBefore.toISOString(),
        batch_limit: this.batchLimit(),
        requeued_count: 0,
        started_at: startedAt.toISOString(),
        completed_at: this.now().toISOString(),
        error: {
          code: "RECONCILIATION_FAILED",
          message: errorMessage(error).slice(0, 2_048),
        },
      };
    }
    this.lastCycle = cycle;
    try {
      this.options.observe?.(cycle);
    } catch {
      this.observerFailures += 1;
    }
    return cycle;
  }

  private intervalMs(): number {
    return this.options.interval_ms ?? 60_000;
  }

  private staleAfterMs(): number {
    return this.options.stale_after_ms ?? 300_000;
  }

  private batchLimit(): number {
    return this.options.batch_limit ?? 100;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function validateOptions(options: DeletionReconciliationSchedulerOptions): void {
  if (!options.scheduler_id.trim() || !options.instance_id.trim()) {
    throw new TypeError("Deletion reconciliation scheduler and instance identities are required");
  }
  const interval = options.interval_ms ?? 60_000;
  const staleAfter = options.stale_after_ms ?? 300_000;
  const batchLimit = options.batch_limit ?? 100;
  if (!Number.isInteger(interval) || interval < 100 || interval > 86_400_000) {
    throw new TypeError("Deletion reconciliation interval must be between 100 and 86400000 milliseconds");
  }
  if (!Number.isInteger(staleAfter) || staleAfter < 0 || staleAfter > 2_592_000_000) {
    throw new TypeError("Deletion reconciliation stale age must be between 0 and 2592000000 milliseconds");
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 1_000) {
    throw new TypeError("Deletion reconciliation batch limit must be between 1 and 1000");
  }
}

function cycleIdentity(
  options: Pick<DeletionReconciliationSchedulerOptions, "scheduler_id" | "instance_id">,
  startedAt: Date,
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update(`${options.scheduler_id}\n${options.instance_id}\n${startedAt.toISOString()}\n${sequence}`, "utf8")
    .digest("hex");
  return `reconciliation.${digest}`;
}

async function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await waitFor(milliseconds, undefined, { signal });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
