import { createHash } from "node:crypto";
import { setTimeout as waitFor } from "node:timers/promises";

import type { MaintenanceCycleRepository, PurgedRetrievalIndex, RetrievalIndexRepository } from "@firefly/persistence";

export interface RetiredIndexGarbageCollectionCycle {
  readonly cycle_id: string;
  readonly collector_id: string;
  readonly instance_id: string;
  readonly status: "completed" | "failed";
  readonly retired_before: string;
  readonly batch_limit: number;
  readonly purged_index_count: number;
  readonly deleted_chunk_count: number;
  readonly purged_index_ids: readonly string[];
  readonly started_at: string;
  readonly completed_at: string;
  readonly error?: {
    readonly code: "RETIRED_INDEX_GC_FAILED";
    readonly message: string;
  };
}

export interface RetiredIndexGarbageCollectionSnapshot {
  readonly running: boolean;
  readonly observer_failures: number;
  readonly ledger_failures: number;
  readonly last_cycle?: RetiredIndexGarbageCollectionCycle;
}

export interface RetiredIndexGarbageCollectorOptions {
  readonly collector_id: string;
  readonly instance_id: string;
  readonly indexes: Pick<RetrievalIndexRepository, "purgeRetiredIndexes">;
  readonly ledger?: Pick<MaintenanceCycleRepository, "record">;
  readonly ledger_failures?: (error: unknown) => void;
  readonly interval_ms?: number;
  readonly retention_ms?: number;
  readonly batch_limit?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observe?: (cycle: RetiredIndexGarbageCollectionCycle) => void;
}

export class RetiredIndexGarbageCollector {
  private readonly options: RetiredIndexGarbageCollectorOptions;
  private activeCycle: Promise<RetiredIndexGarbageCollectionCycle> | undefined;
  private loopRunning = false;
  private sequence = 0;
  private observerFailures = 0;
  private lastCycle: RetiredIndexGarbageCollectionCycle | undefined;
  private ledgerFailures = 0;

  constructor(options: RetiredIndexGarbageCollectorOptions) {
    validateOptions(options);
    this.options = options;
  }

  snapshot(): RetiredIndexGarbageCollectionSnapshot {
    return {
      running: this.loopRunning || Boolean(this.activeCycle),
      observer_failures: this.observerFailures,
      ledger_failures: this.ledgerFailures,
      ...(this.lastCycle ? { last_cycle: this.lastCycle } : {}),
    };
  }

  runOnce(): Promise<RetiredIndexGarbageCollectionCycle> {
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.executeCycle();
    this.activeCycle = cycle;
    void cycle.finally(() => {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    });
    return cycle;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.loopRunning) throw new TypeError("Retired-index garbage collector loop is already running");
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

  private async executeCycle(): Promise<RetiredIndexGarbageCollectionCycle> {
    const startedAt = this.now();
    const retiredBefore = new Date(startedAt.getTime() - this.retentionMs());
    const cycleId = cycleIdentity(this.options, startedAt, this.sequence++);
    let cycle: RetiredIndexGarbageCollectionCycle;
    try {
      const purged = await this.options.indexes.purgeRetiredIndexes({
        retired_before: retiredBefore,
        limit: this.batchLimit(),
        now: startedAt,
      });
      cycle = completedCycle(this.options, cycleId, startedAt, this.now(), retiredBefore, this.batchLimit(), purged);
    } catch (error) {
      cycle = {
        cycle_id: cycleId,
        collector_id: this.options.collector_id,
        instance_id: this.options.instance_id,
        status: "failed",
        retired_before: retiredBefore.toISOString(),
        batch_limit: this.batchLimit(),
        purged_index_count: 0,
        deleted_chunk_count: 0,
        purged_index_ids: [],
        started_at: startedAt.toISOString(),
        completed_at: this.now().toISOString(),
        error: {
          code: "RETIRED_INDEX_GC_FAILED",
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
    if (this.options.ledger) {
      try {
        await this.options.ledger.record({
          cycle_id: cycle.cycle_id,
          cycle_kind: "retired_index_gc",
          worker_id: cycle.collector_id,
          instance_id: cycle.instance_id,
          status: cycle.status,
          started_at: new Date(cycle.started_at),
          completed_at: new Date(cycle.completed_at),
          payload: {
            retired_before: cycle.retired_before,
            batch_limit: cycle.batch_limit,
            purged_index_count: cycle.purged_index_count,
            deleted_chunk_count: cycle.deleted_chunk_count,
            purged_index_ids: cycle.purged_index_ids,
          },
          ...(cycle.error ? { error: cycle.error } : {}),
        });
      } catch (error) {
        this.ledgerFailures += 1;
        try { this.options.ledger_failures?.(error); } catch { /* observer boundary */ }
      }
    }
    return cycle;
  }

  private intervalMs(): number {
    return this.options.interval_ms ?? 3_600_000;
  }

  private retentionMs(): number {
    return this.options.retention_ms ?? 604_800_000;
  }

  private batchLimit(): number {
    return this.options.batch_limit ?? 100;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function completedCycle(
  options: Pick<RetiredIndexGarbageCollectorOptions, "collector_id" | "instance_id">,
  cycleId: string,
  startedAt: Date,
  completedAt: Date,
  retiredBefore: Date,
  batchLimit: number,
  purged: readonly PurgedRetrievalIndex[],
): RetiredIndexGarbageCollectionCycle {
  return {
    cycle_id: cycleId,
    collector_id: options.collector_id,
    instance_id: options.instance_id,
    status: "completed",
    retired_before: retiredBefore.toISOString(),
    batch_limit: batchLimit,
    purged_index_count: purged.length,
    deleted_chunk_count: purged.reduce((total, item) => total + item.deleted_chunk_count, 0),
    purged_index_ids: purged.map((item) => item.index_version_id),
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
  };
}

function validateOptions(options: RetiredIndexGarbageCollectorOptions): void {
  if (!options.collector_id.trim() || !options.instance_id.trim()) {
    throw new TypeError("Retired-index garbage collector and instance identities are required");
  }
  const interval = options.interval_ms ?? 3_600_000;
  const retention = options.retention_ms ?? 604_800_000;
  const batchLimit = options.batch_limit ?? 100;
  if (!Number.isInteger(interval) || interval < 100 || interval > 86_400_000) {
    throw new TypeError("Retired-index garbage collection interval must be between 100 and 86400000 milliseconds");
  }
  if (!Number.isInteger(retention) || retention < 0 || retention > 31_536_000_000) {
    throw new TypeError("Retired-index retention must be between 0 and 31536000000 milliseconds");
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 1_000) {
    throw new TypeError("Retired-index garbage collection batch limit must be between 1 and 1000");
  }
}

function cycleIdentity(
  options: Pick<RetiredIndexGarbageCollectorOptions, "collector_id" | "instance_id">,
  startedAt: Date,
  sequence: number,
): string {
  const digest = createHash("sha256")
    .update(`${options.collector_id}\n${options.instance_id}\n${startedAt.toISOString()}\n${sequence}`, "utf8")
    .digest("hex");
  return `index-gc.${digest}`;
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
