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

/**
 * Raised after a model call has already been paid for and durably recorded, once the settled run
 * spend passes the cap. The ledger row survives; the workflow must stop spending.
 */
export class RunCostBudgetExceededError extends Error {
  readonly runId: string;
  readonly spentMicroUsd: number;
  readonly limitMicroUsd: number;

  constructor(runId: string, spentMicroUsd: number, limitMicroUsd: number) {
    super(`Run ${runId} spent ${spentMicroUsd} microUSD against a cap of ${limitMicroUsd}`);
    this.name = "RunCostBudgetExceededError";
    this.runId = runId;
    this.spentMicroUsd = spentMicroUsd;
    this.limitMicroUsd = limitMicroUsd;
  }
}

export class ModelInvocationIdentityConflictError extends Error {
  constructor(invocationId: string) {
    super(`Model invocation identity was replayed with different accounting data: ${invocationId}`);
    this.name = "ModelInvocationIdentityConflictError";
  }
}

export class ModelInvocationRepository {
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly runCostLimitMicroUsd: number | undefined;
  private exceeded: RunCostBudgetExceededError | undefined;

  constructor(db: Kysely<QuestLabDatabase>, options: { readonly run_cost_limit_microusd?: number } = {}) {
    this.db = db;
    if (options.run_cost_limit_microusd !== undefined) {
      if (!Number.isSafeInteger(options.run_cost_limit_microusd) || options.run_cost_limit_microusd < 1) {
        throw new TypeError("run_cost_limit_microusd must be a positive integer");
      }
      this.runCostLimitMicroUsd = options.run_cost_limit_microusd;
    }
  }

  /**
   * The violation observed while settling, if any. Recording runs inside the Model Gateway's
   * observer, which must not change provider semantics mid-call, so the caller drains this between
   * calls and stops the workflow.
   */
  takeBudgetViolation(): RunCostBudgetExceededError | undefined {
    const violation = this.exceeded;
    this.exceeded = undefined;
    return violation;
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
      error_message: redactErrorMessage(input.error?.message),
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
          const settled = await trx
            .updateTable("questlab.run_budget_usage")
            .set({
              tokens_used: sql<number>`tokens_used + ${usage.total_tokens}`,
              // ceil, not round: a sub-microUSD call must never settle as free.
              cost_microusd: sql<number>`cost_microusd + ${Math.ceil(usage.cost_usd * 1_000_000)}`,
              updated_at: new Date(input.completed_at_ms),
            })
            .where("run_id", "=", inserted.run_id)
            .returning(["cost_microusd", "tokens_used"])
            .executeTakeFirstOrThrow();
          // The row is committed before the cap is evaluated, so the spend stays auditable even
          // when the run is stopped. Enforcement lives here because this is the only place the
          // authoritative running total exists under a row lock.
          const limit = this.runCostLimitMicroUsd;
          const spent = Number(settled.cost_microusd);
          if (limit !== undefined && spent > limit) {
            this.exceeded = new RunCostBudgetExceededError(inserted.run_id, spent, limit);
          }
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
    "cached_input_tokens", "total_tokens", "error_code", "error_message", "error_retryable", "prompt_snapshot",
    "tools_snapshot", "knowledge_snapshot", "model_snapshot", "routing_snapshot",
  ] as const;
  return fields.every((field) => existing[field] === expected[field])
    && sameBigint(existing.cost_microusd, expected.cost_microusd)
    && existing.started_at.getTime() === expected.started_at.getTime()
    && existing.completed_at.getTime() === expected.completed_at.getTime();
}

/**
 * `cost_microusd` is BIGINT and node-postgres returns int8 as a string, so comparing it with `===`
 * against the inserted number always fails and breaks ledger replay for every billed invocation.
 */
function sameBigint(existing: number | string | null, expected: number | null): boolean {
  if (existing === null || expected === null) return existing === null && expected === null;
  return BigInt(existing) === BigInt(expected);
}

/**
 * Provider error text is third-party-controlled, reaches the audit ledger verbatim, and is shown to
 * operators. It is stripped of the credential shapes providers commonly echo back and bounded so a
 * verbose provider cannot bloat the billing record.
 */
export function redactErrorMessage(message: string | undefined): string | null {
  if (message === undefined) return null;
  const redacted = message
    // Credentials embedded in connection strings, checked before the generic key patterns.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/giu, "[redacted-uri]@")
    // Authorization headers echoed back by the provider.
    .replace(/\bBearer\s+[\w.~+/=-]+/giu, "Bearer [redacted]")
    // key=value style secrets (api_key=..., token: ..., password=...).
    .replace(/\b(?:sk|pk|rk|api[-_]?key|key|token|secret|password|passwd|pwd)[-_]?[a-z0-9]*\s*[:=]\s*[\w.~+/=-]{6,}/giu, "[redacted]")
    // Bare provider key prefixes such as sk-ant-api03-xxxx.
    .replace(/\b(?:sk|pk|rk)-[\w.~+/=-]{8,}/giu, "[redacted]")
    // Long hex or base64 blobs: digests are safe to lose from an error string, keys are not.
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[redacted]")
    // Control characters would corrupt log lines built from this value.
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return redacted.length > 1_000 ? `${redacted.slice(0, 997)}...` : redacted;
}
