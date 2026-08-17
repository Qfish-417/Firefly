import assert from "node:assert/strict";
import test from "node:test";

import type { EvolutionTrace, ModelInvocationRecordRow } from "@firefly/persistence";

import { buildAuditRunReport } from "../src/index.ts";

test("Audit Agent attributes usage, detects control risks and exposes metadata only", () => {
  const trace: EvolutionTrace = {
    run: {
      id: "run.audit-unit",
      state: "executing",
      budget: { max_cost_usd: 0.001 },
    },
    tasks: [
      task("task.recorded", "learning-scientist", "AnalyzeLearningOutcomeTask"),
      task("task.telemetry-gap", "learning-director", "GenerateMissionPlanTask"),
    ],
    transitions: [
      {
        event_id: "transition.audit-unit",
        event_type: "execution_started",
        to_state: "executing",
        occurred_at: new Date("2026-08-17T09:00:02.000Z"),
      },
    ],
    agent_results: [
      { task_id: "task.recorded", output: { model_execution: { route_id: "route.test" } } },
      {
        task_id: "task.telemetry-gap",
        output: { model_execution: { route_id: "route.missing" }, private_text: "do-not-expose" },
      },
    ],
    sandbox_runs: [
      {
        sandbox_run_id: "sandbox.audit-unit",
        status: "passed",
        started_at: new Date("2026-08-17T09:00:03.000Z"),
      },
    ],
    approvals: [],
    learning_events: [],
    artifacts: [],
    causal_edges: [],
    sentinel_incidents: [],
    quarantines: [],
    plugin_release_transitions: [],
    canary_evaluations: [],
  };
  const invocations = [
    invocation({
      invocation_id: "model.audit-unit:1",
      attempt: 1,
      status: "failed",
      latency_ms: 10,
      total_tokens: null,
      cost_microusd: null,
    }),
    invocation({
      invocation_id: "model.audit-unit:2",
      attempt: 2,
      status: "succeeded",
      latency_ms: 30,
      input_tokens: 60,
      output_tokens: 30,
      total_tokens: 90,
      cost_microusd: 900,
    }),
  ];

  const report = buildAuditRunReport(
    trace,
    invocations,
    new Date("2026-08-17T09:01:00.000Z"),
  );

  assert.deepEqual(report.totals, {
    task_count: 2,
    model_calls: 2,
    failed_calls: 1,
    retry_calls: 1,
    total_tokens: 90,
    total_cost_microusd: 900,
  });
  assert.deepEqual(report.alerts.map((alert) => alert.code), [
    "model_failures",
    "model_retries",
    "telemetry_gap",
    "budget_critical",
  ]);
  const scientist = report.agents.find((agent) => agent.agent_id === "learning-scientist");
  assert.equal(scientist?.model_calls, 2);
  assert.equal(scientist?.average_latency_ms, 20);
  assert.equal(report.privacy, "metadata_and_digests_only");
  assert.equal(JSON.stringify(report).includes("do-not-expose"), false);
  assert.deepEqual(report.activity.map((item) => item.occurred_at), [
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T09:00:02.000Z",
    "2026-08-17T09:00:03.000Z",
  ]);
});

function task(id: string, subject: string, taskType: string) {
  return {
    id,
    subject,
    task_type: taskType,
    status: "completed",
    created_at: new Date("2026-08-17T09:00:00.000Z"),
  };
}

function invocation(
  overrides: Partial<ModelInvocationRecordRow> & Pick<ModelInvocationRecordRow, "invocation_id">,
): ModelInvocationRecordRow {
  return {
    request_id: "model.task.recorded",
    workload: "learning-scientist.analyze",
    capability: "generate",
    run_id: "run.audit-unit",
    task_id: "task.recorded",
    agent_id: "learning-scientist",
    tenant_id: "tenant.audit-unit",
    user_id: null,
    origin: "business_agent",
    billing_source: "provider_reported",
    route_id: "route.test",
    transport_id: "pi-ai",
    provider: "test-provider",
    model: "test-model",
    attempt: 1,
    status: "succeeded",
    started_at: new Date("2026-08-17T09:00:00.000Z"),
    completed_at: new Date("2026-08-17T09:00:00.030Z"),
    latency_ms: 30,
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: 0,
    total_tokens: null,
    cost_microusd: null,
    error_code: null,
    error_message: null,
    error_retryable: null,
    prompt_snapshot: "prompt:test:v1",
    tools_snapshot: "tools:none:v1",
    knowledge_snapshot: "knowledge:test:v1",
    model_snapshot: "model:test:v1",
    routing_snapshot: "routing:test:v1",
    created_at: new Date("2026-08-17T09:00:00.000Z"),
    ...overrides,
  };
}
