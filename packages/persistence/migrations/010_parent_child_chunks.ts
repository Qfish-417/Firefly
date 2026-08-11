import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.memory_chunk
      ADD COLUMN chunk_level TEXT NOT NULL DEFAULT 'child'
        CHECK (chunk_level IN ('parent', 'child')),
      ADD COLUMN parent_chunk_id TEXT,
      ADD COLUMN structure_path TEXT[] NOT NULL DEFAULT '{}';

    ALTER TABLE questlab.memory_chunk
      ADD CONSTRAINT memory_chunk_parent_shape_check
        CHECK (chunk_level = 'child' OR parent_chunk_id IS NULL),
      ADD CONSTRAINT memory_chunk_parent_projection_unique
        UNIQUE (chunk_id, memory_id, index_version_id),
      ADD CONSTRAINT memory_chunk_parent_same_projection_fk
        FOREIGN KEY (parent_chunk_id, memory_id, index_version_id)
        REFERENCES questlab.memory_chunk (chunk_id, memory_id, index_version_id)
        ON DELETE CASCADE;

    CREATE INDEX memory_chunk_parent_idx
      ON questlab.memory_chunk (parent_chunk_id, index_version_id)
      WHERE parent_chunk_id IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS questlab.memory_chunk_parent_idx;
    ALTER TABLE questlab.memory_chunk
      DROP CONSTRAINT IF EXISTS memory_chunk_parent_same_projection_fk,
      DROP CONSTRAINT IF EXISTS memory_chunk_parent_projection_unique,
      DROP CONSTRAINT IF EXISTS memory_chunk_parent_shape_check,
      DROP COLUMN IF EXISTS structure_path,
      DROP COLUMN IF EXISTS parent_chunk_id,
      DROP COLUMN IF EXISTS chunk_level;
  `.execute(db);
}
