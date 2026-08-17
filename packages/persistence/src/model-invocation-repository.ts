import type { ModelInvocationRecord } from "@firefly/model-gateway";
import { sql, type Kysely, type Selectable } from "kysely";

import type { ModelInvocationTable, QuestLabDatabase } from "./database.ts";

export type ModelInvocationRecordRow = Selectable<ModelInvocationTable>;

export interface ModelInvocationAggregate {
  readonly workload: string;
  readonly provider: string;
  readonly status: "succeeded" | "failed";
  readonly calls: number;
  readonly total_tokens: number;
  readonly total_cost_microusd: number;
  readonly average_latency_ms: number;
}

export interface AgentUsageAggregate {
  readonly agent_id: "learning-director" | "learning-scientist" | "experience-engineer" | "audit-agent";
  readonly calls: number;
  readonly failed_calls: number;
  readonly retry_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly total_tokens: number;
  readonly total_cost_microusd: number;
  readonly average_latency_ms: number;
}

export class ModelInvocationIdentityConflictError extends Error {
  constructor(invocationId: string) {
    super(`Model invocation identity was replayed with different accounting data: ${invocationId}`);
    this.name = "ModelInvocationIdentityConflictError";
  }
}

export class ModelInvocationRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async record(input: ModelInvocationRecord): Promise<ModelInvocationRecordRow> {
    const usage = input.usage;
    const attribution = input.attribution;
    const row = {
      invocation_id: input.invocation_id,
      request_id: input.request_id,
      workload: input.workload,
      capability: input.capability,
      run_id: attribution?.run_id ?? null,
      task_id: attribution?.task_id ?? null,
      agent_id: attribution?.agent_id ?? null,
      tenant_id: attribution?.tenant_id ?? null,
      user_id: attribution?.user_id ?? null,
      origin: attribution?.origin ?? "system" as const,
      billing_source: usage ? "provider_reported" as const : "none" as const,
      route_id: input.route_id,
      transport_id: input.transport_id,
      provider: input.provider,
      model: input.model,
      attempt: input.attempt,
      status: input.status,
      started_at: new Date(input.started_at_ms),
      completed_at: new Date(input.completed_at_ms),
      latency_ms: input.latency_ms,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cached_input_tokens: usage?.cached_input_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null,
      cost_microusd: usage ? Math.round(usage.cost_usd * 1_000_000) : null,
      error_code: input.error?.code ?? null,
      error_message: input.error?.message ?? null,
      error_retryable: input.error?.retryable ?? null,
      prompt_snapshot: input.snapshots.prompt,
      tools_snapshot: input.snapshots.tools,
      knowledge_snapshot: input.snapshots.knowledge,
      model_snapshot: input.snapshots.model ?? null,
      routing_snapshot: input.snapshots.routing ?? null,
    };
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("questlab.model_invocation")
        .values(row)
        .onConflict((conflict) => conflict.column("invocation_id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        if (inserted.run_id && usage) {
          await trx
            .insertInto("questlab.run_budget_usage")
            .values({ run_id: inserted.run_id })
            .onConflict((conflict) => conflict.column("run_id").doNothing())
            .execute();
          await trx
            .updateTable("questlab.run_budget_usage")
            .set({
              tokens_used: sql<number>`tokens_used + ${usage.total_tokens}`,
              cost_microusd: sql<number>`cost_microusd + ${Math.round(usage.cost_usd * 1_000_000)}`,
              updated_at: new Date(input.completed_at_ms),
            })
            .where("run_id", "=", inserted.run_id)
            .execute();
        }
        return inserted;
      }
      const existing = await trx
        .selectFrom("questlab.model_invocation")
        .selectAll()
        .where("invocation_id", "=", input.invocation_id)
        .executeTakeFirstOrThrow();
      if (!sameInvocation(existing, row)) throw new ModelInvocationIdentityConflictError(input.invocation_id);
      return existing;
    });
  }

  async listByRun(runId: string): Promise<readonly ModelInvocationRecordRow[]> {
    return this.db
      .selectFrom("questlab.model_invocation")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("started_at", "asc")
      .orderBy("invocation_id", "asc")
      .execute();
  }

  async aggregateByAgent(runId?: string): Promise<readonly AgentUsageAggregate[]> {
    let query = this.db
      .selectFrom("questlab.model_invocation")
      .select((expression) => [
        "agent_id",
        expression.fn.countAll<number>().as("calls"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed_calls"),
        sql<number>`count(*) filter (where attempt > 1)`.as("retry_calls"),
        expression.fn.coalesce(expression.fn.sum<number>("input_tokens"), expression.val(0)).as("input_tokens"),
        expression.fn.coalesce(expression.fn.sum<number>("output_tokens"), expression.val(0)).as("output_tokens"),
        expression.fn.coalesce(expression.fn.sum<number>("cached_input_tokens"), expression.val(0)).as("cached_input_tokens"),
        expression.fn.coalesce(expression.fn.sum<number>("total_tokens"), expression.val(0)).as("total_tokens"),
        expression.fn.coalesce(expression.fn.sum<number>("cost_microusd"), expression.val(0)).as("total_cost_microusd"),
        expression.fn.avg<number>("latency_ms").as("average_latency_ms"),
      ])
      .where("agent_id", "is not", null)
      .groupBy("agent_id")
      .orderBy("agent_id", "asc");
    if (runId) query = query.where("run_id", "=", runId);
    const rows = await query.execute();
    return rows.map((row) => ({
      agent_id: row.agent_id!,
      calls: Number(row.calls),
      failed_calls: Number(row.failed_calls),
      retry_calls: Number(row.retry_calls),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cached_input_tokens: Number(row.cached_input_tokens ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_microusd: Number(row.total_cost_microusd ?? 0),
      average_latency_ms: Number(row.average_latency_ms ?? 0),
    }));
  }

  async aggregate(options: {
    readonly workload?: string;
    readonly since?: Date;
  } = {}): Promise<readonly ModelInvocationAggregate[]> {
    const query = this.db
      .selectFrom("questlab.model_invocation")
      .select((expression) => [
        "workload",
        "provider",
        "status",
        expression.fn.countAll<number>().as("calls"),
        expression.fn.coalesce(expression.fn.sum<number>("total_tokens"), expression.val(0)).as("total_tokens"),
        expression.fn.coalesce(expression.fn.sum<number>("cost_microusd"), expression.val(0)).as("total_cost_microusd"),
        expression.fn.avg<number>("latency_ms").as("average_latency_ms"),
      ])
      .groupBy(["workload", "provider", "status"])
      .orderBy("workload", "asc")
      .orderBy("provider", "asc");
    const filtered = options.workload ? query.where("workload", "=", options.workload) : query;
    const sinceFiltered = options.since ? filtered.where("started_at", ">=", options.since) : filtered;
    const rows = await sinceFiltered.execute();
    return rows.map((row) => ({
      workload: row.workload,
      provider: row.provider,
      status: row.status,
      calls: Number(row.calls),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_microusd: Number(row.total_cost_microusd ?? 0),
      average_latency_ms: Number(row.average_latency_ms ?? 0),
    }));
  }
}

function sameInvocation(existing: ModelInvocationRecordRow, expected: Omit<ModelInvocationTable, "created_at">): boolean {
  const fields = [
    "request_id", "workload", "capability", "run_id", "task_id", "agent_id", "tenant_id", "user_id", "origin", "billing_source",
    "route_id", "transport_id", "provider", "model", "attempt", "status", "latency_ms", "input_tokens", "output_tokens",
    "cached_input_tokens", "total_tokens", "cost_microusd", "error_code", "error_message", "error_retryable", "prompt_snapshot",
    "tools_snapshot", "knowledge_snapshot", "model_snapshot", "routing_snapshot",
  ] as const;
  return fields.every((field) => existing[field] === expected[field])
    && existing.started_at.getTime() === expected.started_at.getTime()
    && existing.completed_at.getTime() === expected.completed_at.getTime();
}
