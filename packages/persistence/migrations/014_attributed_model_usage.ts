import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.model_invocation
      ADD COLUMN capability TEXT NOT NULL DEFAULT 'generate'
        CHECK (capability IN ('generate', 'stream', 'embed', 'rerank')),
      ADD COLUMN run_id TEXT REFERENCES questlab.evolution_run(id),
      ADD COLUMN task_id TEXT REFERENCES questlab.workflow_task(id),
      ADD COLUMN agent_id TEXT
        CHECK (agent_id IN ('learning-director', 'learning-scientist', 'experience-engineer', 'audit-agent')),
      ADD COLUMN tenant_id TEXT,
      ADD COLUMN user_id TEXT,
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'system'
        CHECK (origin IN ('business_agent', 'audit_agent', 'system')),
      ADD COLUMN billing_source TEXT NOT NULL DEFAULT 'none'
        CHECK (billing_source IN ('provider_reported', 'estimated', 'none')),
      ADD CONSTRAINT model_invocation_task_run_check CHECK (task_id IS NULL OR run_id IS NOT NULL),
      ADD CONSTRAINT model_invocation_agent_origin_check CHECK (
        (origin = 'business_agent' AND agent_id IN ('learning-director', 'learning-scientist', 'experience-engineer'))
        OR (origin = 'audit_agent' AND agent_id = 'audit-agent')
        OR (origin = 'system')
      );

    CREATE INDEX model_invocation_run_time_idx
      ON questlab.model_invocation (run_id, started_at, invocation_id)
      WHERE run_id IS NOT NULL;
    CREATE INDEX model_invocation_agent_time_idx
      ON questlab.model_invocation (agent_id, started_at DESC)
      WHERE agent_id IS NOT NULL;
    CREATE INDEX model_invocation_task_idx
      ON questlab.model_invocation (task_id, attempt)
      WHERE task_id IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS questlab.model_invocation_task_idx;
    DROP INDEX IF EXISTS questlab.model_invocation_agent_time_idx;
    DROP INDEX IF EXISTS questlab.model_invocation_run_time_idx;
    ALTER TABLE questlab.model_invocation
      DROP CONSTRAINT IF EXISTS model_invocation_agent_origin_check,
      DROP CONSTRAINT IF EXISTS model_invocation_task_run_check,
      DROP COLUMN IF EXISTS billing_source,
      DROP COLUMN IF EXISTS origin,
      DROP COLUMN IF EXISTS user_id,
      DROP COLUMN IF EXISTS tenant_id,
      DROP COLUMN IF EXISTS agent_id,
      DROP COLUMN IF EXISTS task_id,
      DROP COLUMN IF EXISTS run_id,
      DROP COLUMN IF EXISTS capability;
  `.execute(db);
}
