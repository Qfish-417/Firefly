import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.workflow_task
      ADD COLUMN root_run_id TEXT,
      ADD COLUMN parent_task_id TEXT REFERENCES questlab.workflow_task(id) ON DELETE RESTRICT,
      ADD COLUMN hop_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN max_hops INTEGER NOT NULL DEFAULT 8,
      ADD COLUMN task_fingerprint TEXT,
      ADD COLUMN policy_snapshot TEXT,
      ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN cooldown_key TEXT,
      ADD CONSTRAINT workflow_task_hop_bounds CHECK (
        hop_count >= 0 AND max_hops > 0 AND hop_count <= max_hops
      ),
      ADD CONSTRAINT workflow_task_not_own_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id),
      ADD CONSTRAINT workflow_task_fingerprint_format CHECK (
        task_fingerprint IS NULL OR task_fingerprint ~ '^sha256:[a-f0-9]{64}$'
      );

    CREATE UNIQUE INDEX workflow_task_epoch_fingerprint_idx
      ON questlab.workflow_task (run_id, epoch, task_fingerprint)
      WHERE task_fingerprint IS NOT NULL;

    CREATE INDEX workflow_task_parent_idx
      ON questlab.workflow_task (parent_task_id)
      WHERE parent_task_id IS NOT NULL;

    CREATE TABLE questlab.causal_edge (
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      parent_node_id TEXT NOT NULL,
      child_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('task', 'event', 'artifact', 'transition')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (run_id, parent_node_id, child_node_id, edge_type),
      CHECK (parent_node_id <> child_node_id)
    );

    CREATE INDEX causal_edge_child_idx
      ON questlab.causal_edge (run_id, child_node_id, parent_node_id);

    CREATE TABLE questlab.run_budget_usage (
      run_id TEXT PRIMARY KEY REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      tasks_created INTEGER NOT NULL DEFAULT 0 CHECK (tasks_created >= 0),
      transitions_applied INTEGER NOT NULL DEFAULT 0 CHECK (transitions_applied >= 0),
      tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
      cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
      tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.sentinel_incident (
      incident_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      incident_type TEXT NOT NULL CHECK (incident_type IN (
        'causal_cycle', 'hop_limit', 'task_repetition', 'budget_exhausted',
        'delegation_violation', 'state_oscillation', 'event_storm'
      )),
      severity TEXT NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
      action TEXT NOT NULL CHECK (action IN (
        'reject', 'pause', 'quarantine', 'needs_human', 'rollback'
      )),
      details JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object'),
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
      UNIQUE (run_id, incident_type, fingerprint, status)
    );

    CREATE INDEX sentinel_incident_open_idx
      ON questlab.sentinel_incident (run_id, severity, first_seen_at)
      WHERE status = 'open';

    CREATE TABLE questlab.sentinel_observation (
      observation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX sentinel_observation_window_idx
      ON questlab.sentinel_observation (run_id, signal_type, fingerprint, observed_at);

    CREATE TABLE questlab.quarantine (
      quarantine_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('run', 'agent', 'task', 'plugin', 'tool')),
      subject_id TEXT NOT NULL,
      incident_id TEXT NOT NULL REFERENCES questlab.sentinel_incident(incident_id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      released_at TIMESTAMPTZ,
      released_by TEXT,
      CHECK (active = (released_at IS NULL AND released_by IS NULL))
    );

    CREATE UNIQUE INDEX quarantine_active_subject_idx
      ON questlab.quarantine (run_id, subject_type, subject_id)
      WHERE active = TRUE;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.quarantine;
    DROP TABLE IF EXISTS questlab.sentinel_observation;
    DROP TABLE IF EXISTS questlab.sentinel_incident;
    DROP TABLE IF EXISTS questlab.run_budget_usage;
    DROP TABLE IF EXISTS questlab.causal_edge;
    ALTER TABLE questlab.workflow_task
      DROP COLUMN IF EXISTS cooldown_key,
      DROP COLUMN IF EXISTS epoch,
      DROP COLUMN IF EXISTS policy_snapshot,
      DROP COLUMN IF EXISTS task_fingerprint,
      DROP COLUMN IF EXISTS max_hops,
      DROP COLUMN IF EXISTS hop_count,
      DROP COLUMN IF EXISTS parent_task_id,
      DROP COLUMN IF EXISTS root_run_id;
  `.execute(db);
}
