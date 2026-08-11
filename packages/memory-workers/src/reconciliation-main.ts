import { MemoryRepository, createDatabase } from "@firefly/persistence";

import { DeletionReconciliationScheduler } from "./reconciliation-scheduler.ts";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const schedulerId = process.env.MEMORY_RECONCILIATION_SCHEDULER_ID ?? "memory-deletion-reconciler";
const instanceId = process.env.MEMORY_RECONCILIATION_INSTANCE_ID ?? `${schedulerId}.pid-${process.pid}`;
const db = createDatabase(databaseUrl);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const scheduler = new DeletionReconciliationScheduler({
  scheduler_id: schedulerId,
  instance_id: instanceId,
  memories: new MemoryRepository(db),
  interval_ms: integerEnvironment("MEMORY_RECONCILIATION_INTERVAL_MS", 60_000),
  stale_after_ms: integerEnvironment("MEMORY_RECONCILIATION_STALE_AFTER_MS", 300_000),
  batch_limit: integerEnvironment("MEMORY_RECONCILIATION_BATCH_SIZE", 100),
  observe: (cycle) => process.stdout.write(`${JSON.stringify({ type: "memory_deletion_reconciliation", ...cycle })}\n`),
});

try {
  await scheduler.run(controller.signal);
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
