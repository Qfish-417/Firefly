import type { ModelInvocationRecord } from "@firefly/model-gateway";
import type { Kysely, Selectable } from "kysely";

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

export class ModelInvocationRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async record(input: ModelInvocationRecord): Promise<ModelInvocationRecordRow> {
    const usage = input.usage;
    const row = {
      invocation_id: input.invocation_id,
      request_id: input.request_id,
      workload: input.workload,
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
    const inserted = await this.db
      .insertInto("questlab.model_invocation")
      .values(row)
      .onConflict((conflict) => conflict.column("invocation_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    return this.db
      .selectFrom("questlab.model_invocation")
      .selectAll()
      .where("invocation_id", "=", input.invocation_id)
      .executeTakeFirstOrThrow();
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
