import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.retrieval_index_version (
      index_version_id TEXT PRIMARY KEY,
      build_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      logical_name TEXT NOT NULL,
      index_kind TEXT NOT NULL CHECK (index_kind IN ('lexical', 'vector', 'hybrid', 'multimodal')),
      provider TEXT NOT NULL,
      configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[a-f0-9]{64}$'),
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      source_watermark TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'active', 'retired', 'failed')),
      document_count INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
      chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
      error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
      requested_at TIMESTAMPTZ NOT NULL,
      ready_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (tenant_id, logical_name, index_version_id),
      CHECK (
        (embedding_model IS NULL AND embedding_dimensions IS NULL)
        OR
        (embedding_model IS NOT NULL AND embedding_dimensions > 0)
      ),
      CHECK (status <> 'ready' OR ready_at IS NOT NULL),
      CHECK (status <> 'active' OR activated_at IS NOT NULL),
      CHECK (status <> 'retired' OR retired_at IS NOT NULL),
      CHECK (status <> 'failed' OR error IS NOT NULL)
    );

    CREATE UNIQUE INDEX retrieval_index_one_active_idx
      ON questlab.retrieval_index_version (tenant_id, logical_name)
      WHERE status = 'active';
    CREATE INDEX retrieval_index_build_idx
      ON questlab.retrieval_index_version (tenant_id, logical_name, status, requested_at DESC);

    ALTER TABLE questlab.memory_chunk
      ADD COLUMN index_version_id TEXT REFERENCES questlab.retrieval_index_version(index_version_id) ON DELETE RESTRICT;
    ALTER TABLE questlab.memory_chunk
      DROP CONSTRAINT memory_chunk_memory_id_ordinal_key;
    ALTER TABLE questlab.memory_chunk
      ADD CONSTRAINT memory_chunk_version_ordinal_unique UNIQUE (memory_id, index_version_id, ordinal);
    CREATE INDEX memory_chunk_active_version_idx
      ON questlab.memory_chunk (index_version_id, memory_id, ordinal);

    ALTER TABLE questlab.memory_deletion_receipt
      ADD COLUMN propagation_status TEXT NOT NULL DEFAULT 'completed'
        CHECK (propagation_status IN ('pending', 'completed', 'failed')),
      ADD COLUMN propagation_completed_at TIMESTAMPTZ;
    UPDATE questlab.memory_deletion_receipt
      SET propagation_completed_at = completed_at;

    CREATE TABLE questlab.memory_deletion_target (
      deletion_id TEXT NOT NULL REFERENCES questlab.memory_deletion_receipt(deletion_id) ON DELETE CASCADE,
      target TEXT NOT NULL CHECK (target IN (
        'object_store', 'external_lexical', 'external_vector', 'multimodal_index',
        'cache', 'summary', 'evaluation'
      )),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      ack_id TEXT UNIQUE,
      evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
      last_error JSONB CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      acknowledged_at TIMESTAMPTZ,
      PRIMARY KEY (deletion_id, target),
      CHECK (status <> 'completed' OR acknowledged_at IS NOT NULL),
      CHECK (status <> 'failed' OR last_error IS NOT NULL)
    );

    CREATE INDEX memory_deletion_target_pending_idx
      ON questlab.memory_deletion_target (status, updated_at)
      WHERE status <> 'completed';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.memory_deletion_target;
    ALTER TABLE questlab.memory_deletion_receipt
      DROP COLUMN IF EXISTS propagation_completed_at,
      DROP COLUMN IF EXISTS propagation_status;
    DROP INDEX IF EXISTS questlab.memory_chunk_active_version_idx;
    ALTER TABLE questlab.memory_chunk
      DROP CONSTRAINT IF EXISTS memory_chunk_version_ordinal_unique;
    DELETE FROM questlab.memory_chunk WHERE index_version_id IS NOT NULL;
    ALTER TABLE questlab.memory_chunk DROP COLUMN IF EXISTS index_version_id;
    ALTER TABLE questlab.memory_chunk
      ADD CONSTRAINT memory_chunk_memory_id_ordinal_key UNIQUE (memory_id, ordinal);
    DROP TABLE IF EXISTS questlab.retrieval_index_version;
  `.execute(db);
}
