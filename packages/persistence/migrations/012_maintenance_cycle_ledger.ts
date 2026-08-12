import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.maintenance_cycle (
      cycle_id TEXT PRIMARY KEY,
      cycle_kind TEXT NOT NULL CHECK (cycle_kind IN ('deletion_reconciliation', 'retired_index_gc')),
      worker_id TEXT NOT NULL CHECK (length(btrim(worker_id)) > 0),
      instance_id TEXT NOT NULL CHECK (length(btrim(instance_id)) > 0),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL CHECK (completed_at >= started_at),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE INDEX maintenance_cycle_kind_started_idx
      ON questlab.maintenance_cycle (cycle_kind, started_at DESC, cycle_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.maintenance_cycle;
  `.execute(db);
}
