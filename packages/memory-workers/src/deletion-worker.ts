import { createHash } from "node:crypto";

import {
  assertContract,
  type ArtifactRef,
  type DeletionPropagationAck,
  type DeletionPropagationTarget,
  type DeletionPropagationTask,
} from "@firefly/contracts";
import type { MemoryRepository, OutboxRepository } from "@firefly/persistence";

import type { WorkerBatchResult } from "./index-build-worker.ts";

export interface DeletionTargetConsumer {
  readonly target: DeletionPropagationTarget;
  delete(task: DeletionPropagationTask): Promise<readonly ArtifactRef[]>;
}

export interface DeletionPropagationWorkerOptions {
  readonly worker_id: string;
  readonly outbox: Pick<OutboxRepository, "claimDeletionBatch" | "markPublished" | "markDiscarded" | "releaseWithError">;
  readonly memories: Pick<MemoryRepository, "getDeletionStatus" | "acknowledgeDeletion">;
  readonly consumer: DeletionTargetConsumer;
  readonly batch_size?: number;
  readonly lease_duration_ms?: number;
  readonly max_attempts?: number;
  readonly initial_backoff_ms?: number;
  readonly max_backoff_ms?: number;
  readonly now?: () => Date;
}

export class DeletionPropagationWorker {
  private readonly options: DeletionPropagationWorkerOptions;

  constructor(options: DeletionPropagationWorkerOptions) {
    this.options = options;
  }

  async runBatch(): Promise<WorkerBatchResult> {
    const events = await this.options.outbox.claimDeletionBatch(
      this.options.worker_id,
      this.options.consumer.target,
      this.options.batch_size ?? 10,
      this.options.lease_duration_ms ?? 30_000,
      this.now(),
    );
    let completed = 0;
    let failed = 0;
    let released = 0;
    for (const event of events) {
      try {
        const outcome = await this.processEvent(event);
        if (outcome === "completed") completed += 1;
        else if (outcome === "failed") failed += 1;
        else released += 1;
      } catch (error) {
        const retryable = (!(error instanceof DeletionWorkerError) || error.retryable) &&
          event.attempts < (this.options.max_attempts ?? 3);
        if (retryable) {
          await this.options.outbox.releaseWithError(
            event.event_id,
            this.options.worker_id,
            errorMessage(error),
            new Date(this.now().getTime() + retryDelay(event.attempts, this.options)),
          );
          released += 1;
        } else {
          await this.options.outbox.markDiscarded(
            event.event_id,
            this.options.worker_id,
            errorMessage(error),
            this.now(),
          );
          failed += 1;
        }
      }
    }
    return { claimed: events.length, completed, failed, released };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async processEvent(event: {
    readonly event_id: string;
    readonly attempts: number;
    readonly payload: unknown;
  }): Promise<"completed" | "failed" | "released"> {
    const task = parseDeletionTask(event.payload);
    if (task.target !== this.options.consumer.target) {
      throw new DeletionWorkerError("DELETION_TARGET_MISMATCH", "Consumer received another target's task", false);
    }
    const current = await this.options.memories.getDeletionStatus(task.deletion_id);
    if (!current || current.receipt.memory_id !== task.memory_id || current.receipt.tenant_id !== task.tenant_id) {
      throw new DeletionWorkerError("DELETION_IDENTITY_MISMATCH", "Deletion task does not match persisted identity", false);
    }
    const target = current.targets.find((item) => item.target === task.target);
    if (!target) throw new DeletionWorkerError("DELETION_TARGET_MISSING", "Deletion target was not requested", false);
    if (target.status === "completed") {
      await this.options.outbox.markPublished(event.event_id, this.options.worker_id, this.now());
      return "completed";
    }
    const attempt = Math.max(target.attempt + 1, event.attempts);

    let evidence: readonly ArtifactRef[];
    try {
      evidence = await this.options.consumer.delete(task);
    } catch (error) {
      const declaredRetryable = !(error instanceof DeletionWorkerError) || error.retryable;
      const retryable = declaredRetryable && event.attempts < (this.options.max_attempts ?? 3);
      await this.options.memories.acknowledgeDeletion(
        acknowledgement(task, event.event_id, attempt, "failed", [], this.now(), {
          code: error instanceof DeletionWorkerError ? error.code : "DELETION_PROVIDER_FAILED",
          message: errorMessage(error).slice(0, 2_048),
          retryable,
        }),
      );
      if (retryable) {
        await this.options.outbox.releaseWithError(
          event.event_id,
          this.options.worker_id,
          errorMessage(error),
          new Date(this.now().getTime() + retryDelay(event.attempts, this.options)),
        );
        return "released";
      }
      await this.options.outbox.markDiscarded(event.event_id, this.options.worker_id, errorMessage(error), this.now());
      return "failed";
    }

    await this.options.memories.acknowledgeDeletion(
      acknowledgement(task, event.event_id, attempt, "completed", evidence, this.now()),
    );
    await this.options.outbox.markPublished(event.event_id, this.options.worker_id, this.now());
    return "completed";
  }
}

export class DeletionWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "DeletionWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parseDeletionTask(value: unknown): DeletionPropagationTask {
  assertContract("DeletionPropagationTask", value);
  return value as DeletionPropagationTask;
}

function acknowledgement(
  task: DeletionPropagationTask,
  eventId: string,
  attempt: number,
  status: DeletionPropagationAck["status"],
  evidenceRefs: readonly ArtifactRef[],
  occurredAt: Date,
  error?: DeletionPropagationAck["error"],
): DeletionPropagationAck {
  const ackHash = createHash("sha256").update(`${eventId}\n${attempt}\n${status}`, "utf8").digest("hex");
  return {
    schema_version: 1,
    ack_id: `ack.${ackHash}`,
    deletion_id: task.deletion_id,
    target: task.target,
    status,
    attempt,
    occurred_at: occurredAt.toISOString(),
    evidence_refs: evidenceRefs,
    ...(error ? { error } : {}),
  };
}

function retryDelay(attempt: number, options: DeletionPropagationWorkerOptions): number {
  const initial = options.initial_backoff_ms ?? 1_000;
  const maximum = options.max_backoff_ms ?? 60_000;
  return Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
