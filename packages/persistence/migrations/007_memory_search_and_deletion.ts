import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE questlab.memory_chunk (
      chunk_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES questlab.memory_record(memory_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      content TEXT NOT NULL CHECK (length(content) > 0),
      chunk_digest TEXT NOT NULL CHECK (chunk_digest ~ '^sha256:[a-f0-9]{64}$'),
      token_count INTEGER NOT NULL CHECK (token_count > 0),
      source_type TEXT NOT NULL,
      entity_keys TEXT[] NOT NULL DEFAULT '{}',
      citation_artifact_id TEXT NOT NULL,
      citation_uri TEXT NOT NULL,
      citation_digest TEXT NOT NULL CHECK (citation_digest ~ '^sha256:[a-f0-9]{64}$'),
      citation_locator JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(citation_locator) = 'object'),
      embedding VECTOR,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (memory_id, ordinal),
      CHECK (
        (embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL)
        OR
        (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimensions > 0)
      )
    );

    CREATE INDEX memory_chunk_search_idx
      ON questlab.memory_chunk USING GIN (search_vector);
    CREATE INDEX memory_chunk_memory_idx
      ON questlab.memory_chunk (memory_id, ordinal);
    CREATE INDEX memory_chunk_embedding_route_idx
      ON questlab.memory_chunk (embedding_model, embedding_dimensions)
      WHERE embedding IS NOT NULL;

    CREATE TABLE questlab.memory_deletion_receipt (
      deletion_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE REFERENCES questlab.memory_record(memory_id) ON DELETE RESTRICT,
      tenant_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      removed_chunk_count INTEGER NOT NULL CHECK (removed_chunk_count >= 0),
      invalidated_event_count INTEGER NOT NULL CHECK (invalidated_event_count >= 0),
      completed_at TIMESTAMPTZ NOT NULL
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.memory_deletion_receipt;
    DROP TABLE IF EXISTS questlab.memory_chunk;
  `.execute(db);
}
