import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.memory_record (
      memory_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('platform', 'tenant', 'agent', 'user', 'session')),
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('public', 'tenant', 'agent_private', 'user_private', 'session')),
      stage TEXT NOT NULL CHECK (stage IN ('raw', 'episodic', 'structured', 'semantic', 'procedural', 'archived')),
      kind TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      source_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array'),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'private', 'restricted')),
      status TEXT NOT NULL CHECK (status IN ('captured', 'normalized', 'structured', 'indexed', 'consolidated', 'active', 'quarantined', 'deleted')),
      valid_from TIMESTAMPTZ,
      valid_to TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      deleted_at TIMESTAMPTZ,
      CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
      CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
    );

    CREATE INDEX memory_scope_owner_idx
      ON questlab.memory_record (tenant_id, scope, owner_id, status);
    CREATE INDEX memory_active_time_idx
      ON questlab.memory_record (tenant_id, valid_from, valid_to)
      WHERE status = 'active';

    CREATE TABLE questlab.memory_acl (
      memory_id TEXT NOT NULL REFERENCES questlab.memory_record(memory_id) ON DELETE CASCADE,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent', 'tenant', 'role', 'session')),
      principal_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'delete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (memory_id, principal_type, principal_id, permission)
    );

    CREATE INDEX memory_acl_principal_idx
      ON questlab.memory_acl (principal_type, principal_id, permission, memory_id);

    CREATE TABLE questlab.structured_event (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      object JSONB NOT NULL CHECK (jsonb_typeof(object) = 'object'),
      scope TEXT NOT NULL CHECK (scope IN ('public', 'tenant', 'agent_private', 'user_private', 'session')),
      owner_id TEXT NOT NULL,
      occurred_from TIMESTAMPTZ NOT NULL,
      occurred_to TIMESTAMPTZ,
      dedupe_key TEXT NOT NULL,
      source_memory_ids JSONB NOT NULL CHECK (jsonb_typeof(source_memory_ids) = 'array'),
      confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      conflict_status TEXT NOT NULL CHECK (conflict_status IN ('none', 'conflict', 'superseded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (occurred_to IS NULL OR occurred_to >= occurred_from),
      UNIQUE (tenant_id, dedupe_key)
    );

    CREATE INDEX structured_event_query_idx
      ON questlab.structured_event (tenant_id, subject_id, event_type, occurred_from);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.structured_event;
    DROP TABLE IF EXISTS questlab.memory_acl;
    DROP TABLE IF EXISTS questlab.memory_record;
  `.execute(db);
}
