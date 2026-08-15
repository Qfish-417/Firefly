import {
  OutboxRepository,
  RetrievalIndexRepository,
  createDatabase,
} from "@firefly/persistence";
import { PostgresMemoryIndexer } from "@firefly/retrieval-postgres";

import {
  AwsS3ObjectReadPort,
  BinaryTextArtifactReadPort,
  DefaultIndexReadyGate,
  MarkdownParentChildChunker,
  PostgresMemoryIndexSourcePort,
  RetrievalIndexBuildWorker,
} from "./index.ts";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const workerId = process.env.MEMORY_INDEX_BUILD_WORKER_ID ?? `memory-index-builder.pid-${process.pid}`;
const intervalMs = integerEnvironment("MEMORY_INDEX_BUILD_INTERVAL_MS", 1_000, 100, 86_400_000);
const batchSize = integerEnvironment("MEMORY_INDEX_BUILD_BATCH_SIZE", 10, 1, 1_000);
const leaseMs = integerEnvironment("MEMORY_INDEX_BUILD_LEASE_MS", 30_000, 1_000, 86_400_000);
const maxArtifactBytes = integerEnvironment("MEMORY_INDEX_MAX_ARTIFACT_BYTES", 50_000_000, 1_024, 500_000_000);
const db = createDatabase(databaseUrl);
const objects = new AwsS3ObjectReadPort({
  region: process.env.AWS_REGION ?? "us-east-1",
  ...(process.env.S3_ENDPOINT?.trim() ? { endpoint: process.env.S3_ENDPOINT.trim() } : {}),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const worker = new RetrievalIndexBuildWorker({
  worker_id: workerId,
  outbox: new OutboxRepository(db),
  indexes: new RetrievalIndexRepository(db),
  indexer: new PostgresMemoryIndexer(db),
  source: new PostgresMemoryIndexSourcePort(db, {
    read_artifact: new BinaryTextArtifactReadPort(objects),
    max_artifact_bytes: maxArtifactBytes,
  }),
  chunker: new MarkdownParentChildChunker(),
  ready_gate: new DefaultIndexReadyGate(),
  auto_activate: false,
  batch_size: batchSize,
  lease_duration_ms: leaseMs,
});

try {
  while (!controller.signal.aborted) {
    const result = await worker.runBatch();
    process.stdout.write(`${JSON.stringify({ type: "memory_index_build", worker_id: workerId, ...result })}\n`);
    if (!controller.signal.aborted) await wait(intervalMs, controller.signal);
  }
} finally {
  objects.destroy();
  await db.destroy();
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
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }).catch((error: unknown) => {
    if (signal.aborted) return;
    throw error;
  });
}
