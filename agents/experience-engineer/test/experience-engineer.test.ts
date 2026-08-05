import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, ImprovementPlan, TaskEnvelope } from "@firefly/contracts";
import { ExperienceEngineerStub } from "../src/index.ts";

const sourcePlugin: ArtifactRef = {
  artifact_id: "artifact.plugin.source.unit",
  uri: "https://artifacts.firefly.local/plugins/solar-energy/1.2.0.json",
  digest: `sha256:${"a".repeat(64)}`,
  media_type: "application/vnd.firefly.plugin+json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: [],
};

test("Experience Engineer refuses an unapproved plan", async () => {
  const plan: ImprovementPlan = {
    plan_id: "plan.unit",
    finding_id: "finding.unit",
    status: "proposed",
    change_class: "A3",
    target_artifact: sourcePlugin,
    allowed_paths: ["plugins/solar-energy/src/daylight.ts"],
    risk_level: "high",
    verification_contract: ["physics_invariants"],
    rollback_target: sourcePlugin,
  };
  const task: TaskEnvelope = {
    message_id: "task.build.unit",
    message_type: "BuildPluginChangeTask",
    schema_version: 1,
    correlation_id: "run.unit",
    causation_id: "event.plan.unit",
    trace_id: "trace.unit",
    producer: "control-plane",
    subject: "experience-engineer",
    idempotency_key: "build:plan.unit",
    created_at: "2026-08-05T10:00:00.000Z",
    deadline: "2026-08-05T10:30:00.000Z",
    cancellation_token: "cancel.task.build.unit",
    lease: { duration_sec: 300, heartbeat_sec: 30 },
    retry_policy: { max_attempts: 3, initial_backoff_ms: 1000, max_backoff_ms: 30_000 },
    budget: { max_tokens: 0, max_cost_usd: 0, max_duration_sec: 1800 },
    artifact_refs: [sourcePlugin],
    payload: { plan: plan as unknown as Record<string, never> },
  };

  await assert.rejects(
    new ExperienceEngineerStub().execute(task, { now: () => new Date() }),
    /approved plan is required/,
  );
});
