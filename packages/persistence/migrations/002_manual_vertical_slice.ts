import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.learning_event (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      causation_id TEXT,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE INDEX learning_event_run_idx
      ON questlab.learning_event (run_id, occurred_at, event_id);

    CREATE TABLE questlab.agent_result (
      result_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL UNIQUE REFERENCES questlab.workflow_task(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL CHECK (agent_id IN (
        'learning-director', 'learning-scientist', 'experience-engineer'
      )),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'canceled', 'needs_human')),
      snapshots JSONB NOT NULL CHECK (jsonb_typeof(snapshots) = 'object'),
      artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs) = 'array'),
      output JSONB NOT NULL CHECK (jsonb_typeof(output) = 'object'),
      completed_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX agent_result_run_idx
      ON questlab.agent_result (run_id, completed_at, result_id);

    CREATE TABLE questlab.learning_finding (
      finding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      causation_id TEXT NOT NULL,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.improvement_plan (
      plan_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      finding_id TEXT NOT NULL UNIQUE REFERENCES questlab.learning_finding(finding_id) ON DELETE RESTRICT,
      causation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.change_set (
      changeset_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL UNIQUE REFERENCES questlab.improvement_plan(plan_id) ON DELETE RESTRICT,
      causation_id TEXT NOT NULL,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.verification_report (
      report_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      changeset_id TEXT NOT NULL UNIQUE REFERENCES questlab.change_set(changeset_id) ON DELETE RESTRICT,
      causation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE questlab.learning_outcome (
      outcome_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES questlab.evolution_run(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL UNIQUE REFERENCES questlab.improvement_plan(plan_id) ON DELETE RESTRICT,
      causation_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN (
        'recommend_activate', 'recommend_rollback', 'needs_human'
      )),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS questlab.learning_outcome;
    DROP TABLE IF EXISTS questlab.verification_report;
    DROP TABLE IF EXISTS questlab.change_set;
    DROP TABLE IF EXISTS questlab.improvement_plan;
    DROP TABLE IF EXISTS questlab.learning_finding;
    DROP TABLE IF EXISTS questlab.agent_result;
    DROP TABLE IF EXISTS questlab.learning_event;
  `.execute(db);
}
