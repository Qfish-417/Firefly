import assert from "node:assert/strict";
import test from "node:test";

import type { TaskEnvelope } from "@firefly/contracts";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationStreamEvent,
  TextGenerationPort,
} from "@firefly/model-gateway";

import { LearningDirectorAgent } from "../src/index.ts";

test("model Director adds guidance but cannot alter trusted mission stages or plugin exposure", async () => {
  const gateway = new FakeGateway();
  const result = await new LearningDirectorAgent(gateway).execute(task(), {
    now: () => new Date("2026-08-05T10:01:00.000Z"),
  });
  const plan = result.output.mission_plan as unknown as {
    stages: readonly string[];
    plugin_exposure: { version: string };
    stage_guidance: Record<string, string>;
  };

  assert.deepEqual(plan.stages, ["predict", "simulate", "explain", "delayed-review", "transfer"]);
  assert.equal(plan.plugin_exposure.version, "1.2.0");
  assert.equal(plan.stage_guidance.predict, "Ask for a prediction.");
  assert.equal(gateway.requests.length, 1);
  assert.match(result.snapshots.prompt ?? "", /^prompt:learning-director\.mission-plan\.v1:sha256:/);
});

class FakeGateway implements TextGenerationPort {
  readonly requests: GenerationRequest[] = [];

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(request);
    const guidance = Object.fromEntries(
      ["predict", "simulate", "explain", "delayed-review", "transfer"].map((stage) => [
        stage,
        stage === "predict" ? "Ask for a prediction." : `Guide ${stage}.`,
      ]),
    );
    return {
      request_id: request.request_id,
      text: JSON.stringify({
        stage_guidance: guidance,
        stages: ["model-controlled-stage"],
        plugin_exposure: { version: "malicious" },
      }),
      finish_reason: "stop",
      route_id: "route.test",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 0,
        total_tokens: 150,
        cost_usd: 0.001,
      },
      latency_ms: 10,
      snapshots: {
        ...request.snapshots,
        model: "model:test:v1",
        routing: "routing:test:v1",
      },
    };
  }

  async *stream(_request: GenerationRequest): AsyncIterable<GenerationStreamEvent> {
    throw new Error("not used");
  }
}

function task(): TaskEnvelope {
  return {
    message_id: "task.mission.director-unit",
    message_type: "GenerateMissionPlanTask",
    schema_version: 1,
    correlation_id: "run.director-unit",
    trace_id: "trace.director-unit",
    producer: "control-plane",
    subject: "learning-director",
    idempotency_key: "mission:director-unit",
    created_at: "2026-08-05T10:00:00.000Z",
    deadline: "2026-08-05T10:30:00.000Z",
    cancellation_token: "cancel.director-unit",
    lease: { duration_sec: 300, heartbeat_sec: 30 },
    retry_policy: { max_attempts: 3, initial_backoff_ms: 100, max_backoff_ms: 1_000 },
    budget: { max_tokens: 2_000, max_cost_usd: 0.1, max_duration_sec: 30 },
    artifact_refs: [],
    payload: {
      world_id: "world.mars-base",
      mission_id: "mission.solar-energy",
      goal: "Understand solar output cycles",
      plugin_exposure: {
        plugin_id: "solar-energy",
        version: "1.2.0",
        digest: `sha256:${"b".repeat(64)}`,
      },
    },
  };
}
