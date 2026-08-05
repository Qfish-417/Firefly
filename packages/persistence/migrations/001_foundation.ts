import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SCHEMA IF NOT EXISTS questlab;

    CREATE TABLE questlab.evolution_run (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN (
        'observed', 'diagnosed', 'planned', 'awaiting_approval', 'executing',
        'verifying', 'canary', 'released', 'learned', 'rejected', 'failed',
        'rolled_back', 'canceled', 'needs_human'
      )),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      goal JSONB NOT NULL CHECK (jsonb_typeof(goal) = 'object'),
      budget JSONB NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
      risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.evolution_transition (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      from_version INTEGER NOT NULL CHECK (from_version >= 0),
      to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (run_id, to_version)
    );

    CREATE TABLE questlab.workflow_task (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      task_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'leased', 'completed', 'failed', 'canceled', 'needs_human'
      )),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs) = 'array'),
      idempotency_key TEXT NOT NULL UNIQUE,
      available_at TIMESTAMPTZ NOT NULL,
      deadline TIMESTAMPTZ NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
      result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
      last_error JSONB CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
      CHECK (deadline > created_at)
    );

    CREATE INDEX workflow_task_claim_idx
      ON questlab.workflow_task (subject, status, available_at, created_at)
      WHERE status IN ('pending', 'leased');

    CREATE TABLE questlab.task_checkpoint (
      task_id TEXT NOT NULL REFERENCES questlab.workflow_task(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      checkpoint JSONB NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (task_id, sequence)
    );

    CREATE TABLE questlab.approval (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      requested_by TEXT NOT NULL,
      decided_by TEXT,
      reason TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      decided_at TIMESTAMPTZ,
      CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL))
    );

    CREATE TABLE questlab.outbox_event (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      trace_id TEXT NOT NULL,
      producer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs) = 'array'),
      occurred_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      locked_by TEXT,
      locked_until TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK ((locked_by IS NULL) = (locked_until IS NULL))
    );

    CREATE INDEX outbox_event_dispatch_idx
      ON questlab.outbox_event (available_at, created_at)
      WHERE published_at IS NULL;

    CREATE TABLE questlab.inbox_receipt (
      consumer TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (consumer, event_id)
    );

    CREATE TABLE questlab.artifact (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      digest TEXT NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
      media_type TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('public', 'tenant', 'agent-private', 'user-private', 'session')),
      owner_id TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (digest, scope, owner_id)
    );

    CREATE TABLE questlab.artifact_acl (
      artifact_id TEXT NOT NULL REFERENCES questlab.artifact(id) ON DELETE CASCADE,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent', 'tenant', 'role')),
      principal_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'delete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (artifact_id, principal_type, principal_id, permission)
    );

    CREATE TABLE questlab.artifact_lineage (
      artifact_id TEXT NOT NULL REFERENCES questlab.artifact(id) ON DELETE CASCADE,
      source_artifact_id TEXT NOT NULL REFERENCES questlab.artifact(id) ON DELETE RESTRICT,
      relation TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (artifact_id, source_artifact_id, relation),
      CHECK (artifact_id <> source_artifact_id)
    );

    CREATE INDEX artifact_acl_lookup_idx
      ON questlab.artifact_acl (principal_type, principal_id, permission, artifact_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS questlab CASCADE`.execute(db);
}
