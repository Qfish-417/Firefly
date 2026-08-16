import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.structured_edge (
      edge_id TEXT PRIMARY KEY,
      schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
      tenant_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('directed', 'bidirectional')),
      scope TEXT NOT NULL CHECK (scope IN ('public', 'tenant', 'agent_private', 'user_private', 'session')),
      owner_id TEXT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_to TIMESTAMPTZ,
      dedupe_key TEXT NOT NULL,
      source_memory_ids JSONB NOT NULL CHECK (jsonb_typeof(source_memory_ids) = 'array'),
      confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      conflict_status TEXT NOT NULL CHECK (conflict_status IN ('none', 'conflict', 'superseded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (source_node_id <> target_node_id),
      CHECK (valid_to IS NULL OR valid_to >= valid_from),
      UNIQUE (tenant_id, dedupe_key)
    );

    CREATE INDEX structured_edge_outbound_idx
      ON questlab.structured_edge (tenant_id, source_node_id, predicate, valid_from);
    CREATE INDEX structured_edge_inbound_idx
      ON questlab.structured_edge (tenant_id, target_node_id, predicate, valid_from);

    ALTER TABLE questlab.memory_deletion_receipt
      ADD COLUMN invalidated_edge_count INTEGER NOT NULL DEFAULT 0 CHECK (invalidated_edge_count >= 0);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.memory_deletion_receipt DROP COLUMN IF EXISTS invalidated_edge_count;
    DROP TABLE IF EXISTS questlab.structured_edge;
  `.execute(db);
}
