import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.retrieval_index_version
      ADD COLUMN purged_at TIMESTAMPTZ,
      ADD CONSTRAINT retrieval_index_purge_state_check
        CHECK (purged_at IS NULL OR (status = 'retired' AND retired_at IS NOT NULL AND purged_at >= retired_at));

    CREATE INDEX retrieval_index_gc_candidate_idx
      ON questlab.retrieval_index_version (retired_at, index_version_id)
      WHERE status = 'retired' AND purged_at IS NULL;

    CREATE TABLE questlab.retrieval_index_retention_hold (
      hold_id TEXT PRIMARY KEY,
      index_version_id TEXT NOT NULL
        REFERENCES questlab.retrieval_index_version(index_version_id) ON DELETE RESTRICT,
      reference_type TEXT NOT NULL CHECK (length(btrim(reference_type)) > 0),
      reference_id TEXT NOT NULL CHECK (length(btrim(reference_id)) > 0),
      reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      UNIQUE (index_version_id, reference_type, reference_id),
      CHECK (expires_at IS NULL OR expires_at > created_at),
      CHECK (released_at IS NULL OR released_at >= created_at)
    );

    CREATE INDEX retrieval_index_retention_hold_active_idx
      ON questlab.retrieval_index_retention_hold (index_version_id, expires_at)
      WHERE released_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.retrieval_index_retention_hold;
    DROP INDEX IF EXISTS questlab.retrieval_index_gc_candidate_idx;
    ALTER TABLE questlab.retrieval_index_version
      DROP CONSTRAINT IF EXISTS retrieval_index_purge_state_check,
      DROP COLUMN IF EXISTS purged_at;
  `.execute(db);
}
