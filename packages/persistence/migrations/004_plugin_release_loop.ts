import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.plugin (
      plugin_id TEXT PRIMARY KEY,
      active_version_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.plugin_version (
      version_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL REFERENCES questlab.plugin(plugin_id) ON DELETE RESTRICT,
      version TEXT NOT NULL,
      digest TEXT NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
      artifact_ref JSONB NOT NULL CHECK (jsonb_typeof(artifact_ref) = 'object'),
      source_commit TEXT NOT NULL CHECK (source_commit ~ '^[a-f0-9]{7,64}$'),
      status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'inactive', 'quarantined')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (plugin_id, version),
      UNIQUE (plugin_id, digest)
    );

    ALTER TABLE questlab.plugin
      ADD CONSTRAINT plugin_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES questlab.plugin_version(version_id) ON DELETE RESTRICT;

    CREATE TABLE questlab.plugin_release (
      release_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE RESTRICT,
      plugin_id TEXT NOT NULL REFERENCES questlab.plugin(plugin_id) ON DELETE RESTRICT,
      candidate_version_id TEXT NOT NULL REFERENCES questlab.plugin_version(version_id) ON DELETE RESTRICT,
      rollback_version_id TEXT NOT NULL REFERENCES questlab.plugin_version(version_id) ON DELETE RESTRICT,
      changeset_id TEXT NOT NULL UNIQUE REFERENCES questlab.change_set(changeset_id) ON DELETE RESTRICT,
      authorized_task_id TEXT NOT NULL UNIQUE REFERENCES questlab.workflow_task(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (state IN (
        'proposed', 'sandboxed', 'verified', 'awaiting_approval', 'canary',
        'active', 'rejected', 'failed', 'rolled_back', 'retired'
      )),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      canary_policy JSONB NOT NULL CHECK (jsonb_typeof(canary_policy) = 'object'),
      verification_report_id TEXT REFERENCES questlab.verification_report(report_id) ON DELETE RESTRICT,
      approval_id TEXT REFERENCES questlab.approval(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (candidate_version_id <> rollback_version_id)
    );

    CREATE TABLE questlab.plugin_release_transition (
      event_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES questlab.plugin_release(release_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      from_version INTEGER NOT NULL CHECK (from_version >= 0),
      to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL,
      UNIQUE (release_id, to_version)
    );

    CREATE TABLE questlab.sandbox_run (
      sandbox_run_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES questlab.plugin_release(release_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'timed_out')),
      runner TEXT NOT NULL CHECK (runner IN ('docker')),
      image TEXT NOT NULL,
      network_mode TEXT NOT NULL CHECK (network_mode = 'none'),
      read_only BOOLEAN NOT NULL CHECK (read_only = TRUE),
      limits JSONB NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
      checks JSONB NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      CHECK (completed_at >= started_at)
    );

    CREATE INDEX sandbox_run_release_idx
      ON questlab.sandbox_run (release_id, completed_at DESC);

    CREATE TABLE questlab.canary_evaluation (
      evaluation_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES questlab.plugin_release(release_id) ON DELETE CASCADE,
      cohort TEXT NOT NULL,
      sample_size INTEGER NOT NULL CHECK (sample_size > 0),
      metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
      decision TEXT NOT NULL CHECK (decision IN ('activate', 'rollback', 'needs_human')),
      evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
      evaluated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX canary_evaluation_release_idx
      ON questlab.canary_evaluation (release_id, evaluated_at DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.canary_evaluation;
    DROP TABLE IF EXISTS questlab.sandbox_run;
    DROP TABLE IF EXISTS questlab.plugin_release_transition;
    DROP TABLE IF EXISTS questlab.plugin_release;
    ALTER TABLE questlab.plugin DROP CONSTRAINT IF EXISTS plugin_active_version_fk;
    DROP TABLE IF EXISTS questlab.plugin_version;
    DROP TABLE IF EXISTS questlab.plugin;
  `.execute(db);
}
