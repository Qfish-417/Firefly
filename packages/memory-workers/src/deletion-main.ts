import type { DeletionPropagationTarget } from "@firefly/contracts";
import { MemoryRepository, OutboxRepository, createDatabase } from "@firefly/persistence";

import {
  AwsS3ObjectDeletionPort,
  DeletionPropagationWorker,
  HttpDeletionTargetConsumer,
  ObjectStoreDeletionConsumer,
  type DeletionTargetConsumer,
  type HttpDeletionTarget,
} from "./index.ts";
import { runSupervisedLoop } from "./supervised-loop.ts";

const target = targetEnvironment();
const databaseUrl = requiredEnvironment("DATABASE_URL");
const workerId = process.env.MEMORY_DELETION_WORKER_ID?.trim() || `memory-deletion-${target}.pid-${process.pid}`;
const intervalMs = integerEnvironment("MEMORY_DELETION_INTERVAL_MS", 1_000, 100, 86_400_000);
const batchSize = integerEnvironment("MEMORY_DELETION_BATCH_SIZE", 10, 1, 1_000);
const leaseMs = integerEnvironment("MEMORY_DELETION_LEASE_MS", 30_000, 1_000, 86_400_000);
const db = createDatabase(databaseUrl);
const configured = createConsumer(target);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const worker = new DeletionPropagationWorker({
  worker_id: workerId,
  outbox: new OutboxRepository(db),
  memories: new MemoryRepository(db),
  consumer: configured.consumer,
  batch_size: batchSize,
  lease_duration_ms: leaseMs,
  max_attempts: integerEnvironment("MEMORY_DELETION_MAX_ATTEMPTS", 5, 1, 100),
});

try {
  await runSupervisedLoop(
    async () => {
      const result = await worker.runBatch();
      process.stdout.write(`${JSON.stringify({ type: "memory_deletion", target, worker_id: workerId, ...result })}\n`);
    },
    {
      signal: controller.signal,
      interval_ms: intervalMs,
      max_backoff_ms: integerEnvironment("MEMORY_DELETION_MAX_BACKOFF_MS", 60_000, 1_000, 3_600_000),
      observe_error: (error, failures, backoffMs) => {
        process.stderr.write(`${JSON.stringify({
          type: "memory_deletion_error",
          target,
          worker_id: workerId,
          consecutive_failures: failures,
          backoff_ms: backoffMs,
          message: error instanceof Error ? error.message : String(error),
        })}\n`);
      },
    },
  );
} finally {
  configured.destroy?.();
  await db.destroy();
}

function createConsumer(deletionTarget: DeletionPropagationTarget): { readonly consumer: DeletionTargetConsumer; readonly destroy?: () => void } {
  if (deletionTarget === "object_store") {
    const objects = new AwsS3ObjectDeletionPort({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(process.env.S3_ENDPOINT?.trim() ? { endpoint: process.env.S3_ENDPOINT.trim() } : {}),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    });
    return { consumer: new ObjectStoreDeletionConsumer(objects), destroy: () => objects.destroy() };
  }
  const token = process.env.MEMORY_DELETION_PROVIDER_TOKEN?.trim();
  return {
    consumer: new HttpDeletionTargetConsumer({
      target: deletionTarget as HttpDeletionTarget,
      endpoint: requiredEnvironment("MEMORY_DELETION_ENDPOINT"),
      timeout_ms: integerEnvironment("MEMORY_DELETION_PROVIDER_TIMEOUT_MS", 30_000, 100, 300_000),
      max_response_bytes: integerEnvironment("MEMORY_DELETION_PROVIDER_MAX_RESPONSE_BYTES", 1_000_000, 1_024, 10_000_000),
      allow_insecure_localhost: process.env.MEMORY_DELETION_ALLOW_INSECURE_LOCALHOST === "true",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }),
  };
}

function targetEnvironment(): DeletionPropagationTarget {
  const target = process.env.MEMORY_DELETION_TARGET?.trim();
  const allowed: readonly DeletionPropagationTarget[] = ["object_store", "external_lexical", "external_vector", "multimodal_index", "cache", "summary", "evaluation"];
  if (!target || !allowed.includes(target as DeletionPropagationTarget)) {
    throw new TypeError(`MEMORY_DELETION_TARGET must be one of: ${allowed.join(", ")}`);
  }
  return target as DeletionPropagationTarget;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

