import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE questlab.model_invocation (
      invocation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      workload TEXT NOT NULL,
      route_id TEXT NOT NULL,
      transport_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      total_tokens INTEGER,
      cost_microusd BIGINT,
      error_code TEXT,
      error_message TEXT,
      error_retryable BOOLEAN,
      prompt_snapshot TEXT NOT NULL,
      tools_snapshot TEXT NOT NULL,
      knowledge_snapshot TEXT NOT NULL,
      model_snapshot TEXT,
      routing_snapshot TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (completed_at >= started_at),
      CHECK ((status = 'succeeded') = (error_code IS NULL AND error_message IS NULL AND error_retryable IS NULL)),
      CHECK ((status = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL AND error_retryable IS NOT NULL)),
      CHECK ((total_tokens IS NULL) OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL))
    );

    CREATE INDEX model_invocation_workload_time_idx
      ON questlab.model_invocation (workload, started_at DESC);
    CREATE INDEX model_invocation_provider_status_idx
      ON questlab.model_invocation (provider, status, started_at DESC);
    CREATE INDEX model_invocation_request_idx
      ON questlab.model_invocation (request_id, attempt);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS questlab.model_invocation`.execute(db);
}
