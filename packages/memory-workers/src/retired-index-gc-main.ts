import { MaintenanceCycleRepository, RetrievalIndexRepository, createDatabase } from "@firefly/persistence";

import { RetiredIndexGarbageCollector } from "./retired-index-gc.ts";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const collectorId = process.env.MEMORY_INDEX_GC_COLLECTOR_ID ?? "memory-retired-index-gc";
const instanceId = process.env.MEMORY_INDEX_GC_INSTANCE_ID ?? `${collectorId}.pid-${process.pid}`;
const db = createDatabase(databaseUrl);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const collector = new RetiredIndexGarbageCollector({
  collector_id: collectorId,
  instance_id: instanceId,
  indexes: new RetrievalIndexRepository(db),
  ledger: new MaintenanceCycleRepository(db),
  interval_ms: integerEnvironment("MEMORY_INDEX_GC_INTERVAL_MS", 3_600_000),
  retention_ms: integerEnvironment("MEMORY_INDEX_GC_RETENTION_MS", 604_800_000),
  batch_limit: integerEnvironment("MEMORY_INDEX_GC_BATCH_SIZE", 100),
  observe: (cycle) => process.stdout.write(`${JSON.stringify({ type: "memory_retired_index_gc", ...cycle })}\n`),
});

try {
  await collector.run(controller.signal);
} finally {
  await db.destroy();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new TypeError(`${name} must be a non-negative integer`);
  return Number(raw);
}
