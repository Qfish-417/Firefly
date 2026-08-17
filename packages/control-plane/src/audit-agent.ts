import {
  ModelInvocationRepository,
  VerticalSliceRepository,
  type AgentUsageAggregate,
  type EvolutionTrace,
  type ModelInvocationRecordRow,
  type QuestLabDatabase,
} from "@firefly/persistence";
import type { Kysely } from "kysely";

const businessAgents = ["learning-director", "learning-scientist", "experience-engineer"] as const;
type BusinessAgentId = typeof businessAgents[number];

export interface AuditAlert {
  readonly code: "model_failures" | "model_retries" | "budget_warning" | "budget_critical" | "telemetry_gap";
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
  readonly evidence_ids: readonly string[];
}

export interface AgentAuditSummary {
  readonly agent_id: BusinessAgentId | "audit-agent";
  readonly task_count: number;
  readonly model_calls: number;
  readonly failed_calls: number;
  readonly retry_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly total_tokens: number;
  readonly total_cost_microusd: number;
  readonly average_latency_ms: number;
}

export interface AuditActivity {
  readonly activity_id: string;
  readonly kind: "agent_task" | "model_invocation" | "workflow_transition" | "sandbox_run";
  readonly agent_id?: string;
  readonly action: string;
  readonly status: string;
  readonly occurred_at: string;
  readonly task_id?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly total_tokens?: number;
  readonly cost_microusd?: number;
}

export interface AuditRunReport {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly generated_at: string;
  readonly run_state: string;
  readonly totals: {
    readonly task_count: number;
    readonly model_calls: number;
    readonly failed_calls: number;
    readonly retry_calls: number;
    readonly total_tokens: number;
    readonly total_cost_microusd: number;
  };
  readonly agents: readonly AgentAuditSummary[];
  readonly alerts: readonly AuditAlert[];
  readonly activity: readonly AuditActivity[];
  readonly privacy: "metadata_and_digests_only";
}

/** Read-only deterministic analyzer. It never invokes a model or mutates workflow state. */
export class AuditAgent {
  readonly id = "audit-agent" as const;
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly traces: VerticalSliceRepository;
  private readonly invocations: ModelInvocationRepository;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
    this.traces = new VerticalSliceRepository(db);
    this.invocations = new ModelInvocationRepository(db);
  }

  async analyzeRun(runId: string, now = new Date()): Promise<AuditRunReport | undefined> {
    const trace = await this.traces.getTrace(runId);
    if (!trace) return undefined;
    const invocations = await this.invocations.listByRun(runId);
    return buildAuditRunReport(trace, invocations, now);
  }

  async summarizeAgents(): Promise<readonly AgentAuditSummary[]> {
    const [tasks, usage] = await Promise.all([
      this.db
        .selectFrom("questlab.workflow_task")
        .select(["id", "task_type", "subject", "status", "created_at"])
        .where("subject", "in", businessAgents)
        .execute(),
      this.invocations.aggregateByAgent(),
    ]);
    return mergeAgentUsage(tasks, usage);
  }
}

export function buildAuditRunReport(
  trace: EvolutionTrace,
  invocations: readonly ModelInvocationRecordRow[],
  now = new Date(),
): AuditRunReport {
  const run = trace.run as { readonly id: string; readonly state: string; readonly budget?: { readonly max_cost_usd?: number } };
  const tasks = trace.tasks as readonly TaskRow[];
  const transitions = trace.transitions as readonly TransitionRow[];
  const sandboxRuns = trace.sandbox_runs as readonly SandboxRow[];
  const usage = aggregateRows(invocations);
  const agents = mergeAgentUsage(tasks, usage);
  const modelResultTaskIds = new Set(
    (trace.agent_results as readonly AgentResultRow[])
      .filter((result) => isRecord(result.output) && isRecord(result.output.model_execution))
      .map((result) => result.task_id),
  );
  const recordedTaskIds = new Set(invocations.map((invocation) => invocation.task_id).filter((value): value is string => Boolean(value)));
  const missingTelemetry = [...modelResultTaskIds].filter((taskId) => !recordedTaskIds.has(taskId));
  const failed = invocations.filter((invocation) => invocation.status === "failed");
  const retried = invocations.filter((invocation) => invocation.attempt > 1);
  const totalCost = invocations.reduce((sum, invocation) => sum + Number(invocation.cost_microusd ?? 0), 0);
  const maximumCost = Number(run.budget?.max_cost_usd ?? 0) * 1_000_000;
  const alerts: AuditAlert[] = [];
  if (failed.length > 0) alerts.push({ code: "model_failures", severity: "warning", message: `${failed.length} model invocation attempt(s) failed`, evidence_ids: failed.map((row) => row.invocation_id) });
  if (retried.length > 0) alerts.push({ code: "model_retries", severity: "info", message: `${retried.length} retry attempt(s) consumed additional budget`, evidence_ids: retried.map((row) => row.invocation_id) });
  if (missingTelemetry.length > 0) alerts.push({ code: "telemetry_gap", severity: "critical", message: `${missingTelemetry.length} model-backed task(s) have no durable invocation record`, evidence_ids: missingTelemetry });
  if (maximumCost > 0 && totalCost >= maximumCost * 0.9) alerts.push({ code: "budget_critical", severity: "critical", message: "Model cost reached at least 90% of the run budget", evidence_ids: invocations.map((row) => row.invocation_id) });
  else if (maximumCost > 0 && totalCost >= maximumCost * 0.7) alerts.push({ code: "budget_warning", severity: "warning", message: "Model cost reached at least 70% of the run budget", evidence_ids: invocations.map((row) => row.invocation_id) });

  const activity: AuditActivity[] = [
    ...tasks.map((task) => ({
      activity_id: task.id,
      kind: "agent_task" as const,
      agent_id: task.subject,
      action: task.task_type,
      status: task.status,
      occurred_at: iso(task.created_at),
      task_id: task.id,
    })),
    ...invocations.map((invocation) => ({
      activity_id: invocation.invocation_id,
      kind: "model_invocation" as const,
      ...(invocation.agent_id ? { agent_id: invocation.agent_id } : {}),
      action: `${invocation.capability}:${invocation.workload}`,
      status: invocation.status,
      occurred_at: iso(invocation.started_at),
      ...(invocation.task_id ? { task_id: invocation.task_id } : {}),
      provider: invocation.provider,
      model: invocation.model,
      total_tokens: Number(invocation.total_tokens ?? 0),
      cost_microusd: Number(invocation.cost_microusd ?? 0),
    })),
    ...transitions.map((transition) => ({
      activity_id: transition.event_id,
      kind: "workflow_transition" as const,
      action: transition.event_type,
      status: transition.to_state,
      occurred_at: iso(transition.occurred_at),
    })),
    ...sandboxRuns.map((sandbox, index) => ({
      activity_id: sandbox.sandbox_run_id ?? `sandbox.${index}`,
      kind: "sandbox_run" as const,
      agent_id: "experience-engineer",
      action: "sandbox.verify",
      status: sandbox.status,
      occurred_at: iso(sandbox.started_at),
    })),
  ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.activity_id.localeCompare(right.activity_id));
  return {
    schema_version: 1,
    run_id: run.id,
    generated_at: now.toISOString(),
    run_state: run.state,
    totals: {
      task_count: tasks.length,
      model_calls: invocations.length,
      failed_calls: failed.length,
      retry_calls: retried.length,
      total_tokens: invocations.reduce((sum, invocation) => sum + Number(invocation.total_tokens ?? 0), 0),
      total_cost_microusd: totalCost,
    },
    agents,
    alerts,
    activity,
    privacy: "metadata_and_digests_only",
  };
}

function aggregateRows(rows: readonly ModelInvocationRecordRow[]): AgentUsageAggregate[] {
  const grouped = new Map<NonNullable<ModelInvocationRecordRow["agent_id"]>, ModelInvocationRecordRow[]>();
  for (const row of rows) {
    if (!row.agent_id) continue;
    grouped.set(row.agent_id, [...(grouped.get(row.agent_id) ?? []), row]);
  }
  return [...grouped.entries()].map(([agentId, values]) => ({
    agent_id: agentId,
    calls: values.length,
    failed_calls: values.filter((value) => value.status === "failed").length,
    retry_calls: values.filter((value) => value.attempt > 1).length,
    input_tokens: sum(values, "input_tokens"),
    output_tokens: sum(values, "output_tokens"),
    cached_input_tokens: sum(values, "cached_input_tokens"),
    total_tokens: sum(values, "total_tokens"),
    total_cost_microusd: sum(values, "cost_microusd"),
    average_latency_ms: values.reduce((total, value) => total + value.latency_ms, 0) / values.length,
  }));
}

function mergeAgentUsage(tasks: readonly TaskRow[], usage: readonly AgentUsageAggregate[]): AgentAuditSummary[] {
  const usageByAgent = new Map(usage.map((item) => [item.agent_id, item]));
  const ids = [...businessAgents, ...(usageByAgent.has("audit-agent") ? (["audit-agent"] as const) : [])];
  return ids.map((agentId) => {
    const item = usageByAgent.get(agentId);
    return {
      agent_id: agentId,
      task_count: tasks.filter((task) => task.subject === agentId).length,
      model_calls: item?.calls ?? 0,
      failed_calls: item?.failed_calls ?? 0,
      retry_calls: item?.retry_calls ?? 0,
      input_tokens: item?.input_tokens ?? 0,
      output_tokens: item?.output_tokens ?? 0,
      cached_input_tokens: item?.cached_input_tokens ?? 0,
      total_tokens: item?.total_tokens ?? 0,
      total_cost_microusd: item?.total_cost_microusd ?? 0,
      average_latency_ms: item?.average_latency_ms ?? 0,
    };
  });
}

function sum(rows: readonly ModelInvocationRecordRow[], field: "input_tokens" | "output_tokens" | "cached_input_tokens" | "total_tokens" | "cost_microusd"): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

interface TaskRow { readonly id: string; readonly task_type: string; readonly subject: string; readonly status: string; readonly created_at: Date | string }
interface TransitionRow { readonly event_id: string; readonly event_type: string; readonly to_state: string; readonly occurred_at: Date | string }
interface SandboxRow { readonly sandbox_run_id?: string; readonly status: string; readonly started_at: Date | string }
interface AgentResultRow { readonly task_id: string; readonly output: unknown }
