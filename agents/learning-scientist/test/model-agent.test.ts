import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, LearningEvent, TaskEnvelope } from "@firefly/contracts";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationStreamEvent,
  TextGenerationPort,
} from "@firefly/model-gateway";

import { LearningScientistAgent, ModelOutputValidationError } from "../src/index.ts";

const evidence: ArtifactRef = {
  artifact_id: "artifact.evidence.scientist-unit",
  uri: "https://artifacts.firefly.local/evidence/scientist-unit.json",
  digest: `sha256:${"a".repeat(64)}`,
  media_type: "application/json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: [],
};

const learningEvent: LearningEvent = {
  event_id: "event.learning.scientist-unit",
  learner_id: "learner.synthetic-1",
  world_id: "world.mars-base",
  mission_id: "mission.solar-energy",
  event_type: "assessment_completed",
  occurred_at: "2026-08-05T10:00:00.000Z",
  plugin_exposure: {
    plugin_id: "solar-energy",
    version: "1.2.0",
    digest: `sha256:${"b".repeat(64)}`,
  },
  artifact_refs: [evidence],
  attributes: { misconception: "constant_solar_output" },
};

test("model Scientist binds trusted identity and evidence while persisting execution snapshots", async () => {
  const gateway = new FakeGateway(
    JSON.stringify({
      problem: "Learners assume solar output is constant.",
      affected_concepts: ["physics.energy.solar-cycle"],
      confidence: 0.91,
      severity: "high",
      recommended_change_type: "plugin_and_instruction",
      success_criteria: { mastery_delta: 0.1, delayed_retention_delta: 0.08 },
      evidence_refs: [{ artifact_id: "model-invented" }],
      finding_id: "model-invented",
    }),
  );
  const result = await new LearningScientistAgent(gateway).execute(task(), {
    now: () => new Date("2026-08-05T10:01:00.000Z"),
  });
  const finding = result.output.finding as unknown as {
    finding_id: string;
    evidence_refs: readonly ArtifactRef[];
    success_criteria: { no_harm_constraints: readonly string[] };
  };

  assert.equal(finding.finding_id, "finding.run.scientist-unit");
  assert.deepEqual(finding.evidence_refs, [evidence]);
  assert.deepEqual(finding.success_criteria.no_harm_constraints, [
    "assessment_invariance",
    "accessibility",
    "no_regression",
  ]);
  assert.match(result.snapshots.model ?? "", /model:test.*routing:test/);
  assert.match(result.snapshots.prompt ?? "", /^prompt:learning-scientist\.analysis\.v1:sha256:/);
  assert.equal(gateway.requests[0]?.temperature, 0);
  assert.deepEqual(gateway.requests[0]?.attribution, {
    run_id: "run.scientist-unit",
    task_id: "task.analyze.scientist-unit",
    agent_id: "learning-scientist",
    origin: "business_agent",
  });
});

test("model Scientist rejects non-JSON output before it reaches the workflow state machine", async () => {
  const gateway = new FakeGateway("```json\n{}\n```");
  await assert.rejects(
    new LearningScientistAgent(gateway).execute(task(), { now: () => new Date() }),
    ModelOutputValidationError,
  );
});

class FakeGateway implements TextGenerationPort {
  readonly requests: GenerationRequest[] = [];
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(request);
    return {
      request_id: request.request_id,
      text: this.response,
      finish_reason: "stop",
      route_id: "route.test",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 0,
        total_tokens: 150,
        cost_usd: 0.001,
      },
      latency_ms: 20,
      snapshots: {
        ...request.snapshots,
        model: "model:test:v1",
        routing: "routing:test:v1",
      },
    };
  }

  async *stream(_request: GenerationRequest): AsyncIterable<GenerationStreamEvent> {
    throw new Error("not used by this test");
  }
}

function task(): TaskEnvelope {
  return {
    message_id: "task.analyze.scientist-unit",
    message_type: "AnalyzeLearningOutcomeTask",
    schema_version: 1,
    correlation_id: "run.scientist-unit",
    causation_id: learningEvent.event_id,
    trace_id: "trace.scientist-unit",
    producer: "control-plane",
    subject: "learning-scientist",
    idempotency_key: "analyze:scientist-unit",
    created_at: "2026-08-05T10:00:00.000Z",
    deadline: "2026-08-05T10:30:00.000Z",
    cancellation_token: "cancel.scientist-unit",
    lease: { duration_sec: 300, heartbeat_sec: 30 },
    retry_policy: { max_attempts: 3, initial_backoff_ms: 100, max_backoff_ms: 1_000 },
    budget: { max_tokens: 2_000, max_cost_usd: 0.1, max_duration_sec: 30 },
    governance: {
      root_run_id: "run.scientist-unit",
      hop_count: 0,
      max_hops: 8,
      task_fingerprint: `sha256:${"2".repeat(64)}`,
      policy_snapshot: "governance:test:v1",
      epoch: 0,
    },
    artifact_refs: [evidence],
    payload: { learning_events: [learningEvent] as unknown as never, cohort: "synthetic-a" },
  };
}
