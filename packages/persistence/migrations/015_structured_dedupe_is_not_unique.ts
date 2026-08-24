import { sql, type Kysely } from "kysely";

/**
 * `dedupe_key` is a read-side collapse key, not an identity key.
 *
 * ADR 0009 and ADR 0039 define aggregation as "retain the first visible representative of each
 * `dedupe_key`", which only has meaning when several rows can share one key. Migrations 006 and 013
 * nevertheless declared `UNIQUE (tenant_id, dedupe_key)`, so writing the second observation of the
 * same fact raised a duplicate-key error before the aggregator could ever deduplicate it.
 *
 * The unique constraints are replaced with plain lookup indexes. Identity stays on `event_id` /
 * `edge_id`, which `recordEvent` and `recordEdge` still verify on replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.structured_event
      DROP CONSTRAINT IF EXISTS structured_event_tenant_id_dedupe_key_key;
    ALTER TABLE questlab.structured_edge
      DROP CONSTRAINT IF EXISTS structured_edge_tenant_id_dedupe_key_key;

    CREATE INDEX IF NOT EXISTS structured_event_dedupe_idx
      ON questlab.structured_event (tenant_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS structured_edge_dedupe_idx
      ON questlab.structured_edge (tenant_id, dedupe_key);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS questlab.structured_event_dedupe_idx;
    DROP INDEX IF EXISTS questlab.structured_edge_dedupe_idx;
  `.execute(db);
}
