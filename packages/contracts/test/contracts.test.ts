import assert from "node:assert/strict";
import test from "node:test";

import {
  assertContract,
  validateContract,
  type ArtifactRef,
  type ContractName,
} from "../src/index.ts";

const digest = `sha256:${"a".repeat(64)}` as const;

const evidenceArtifact = {
  artifact_id: "artifact.evidence.01",
  uri: "https://artifacts.firefly.local/evidence/01.json",
  digest,
  media_type: "application/json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: ["learning-event.01"],
} satisfies ArtifactRef;

const pluginArtifact = {
  artifact_id: "artifact.plugin.solar.1.3.0",
  uri: "oci://registry.firefly.local/solar-energy@sha256:aaaaaaaa",
  digest,
  media_type: "application/vnd.oci.image.manifest.v1+json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: ["changeset.01"],
} satisfies ArtifactRef;

const validContracts: Record<ContractName, unknown> = {
  ArtifactRef: evidenceArtifact,
  TaskEnvelope: {
    message_id: "task.build-plugin.01",
    message_type: "BuildPluginChangeTask",
    schema_version: 1,
    correlation_id: "evolution.01",
    causation_id: "event.plan-approved.01",
    trace_id: "trace.01",
    producer: "control-plane",
    subject: "experience-engineer",
    idempotency_key: "build:plan.01:solar-energy@1.2.0",
    created_at: "2026-08-05T10:00:00Z",
    deadline: "2026-08-05T10:30:00Z",
    cancellation_token: "cancel.build.01",
    lease: { duration_sec: 300, heartbeat_sec: 30 },
    retry_policy: {
      max_attempts: 3,
      initial_backoff_ms: 1000,
      max_backoff_ms: 30000,
    },
    budget: { max_tokens: 20000, max_cost_usd: 4, max_duration_sec: 1800 },
    artifact_refs: [evidenceArtifact],
    payload: { plan_id: "plan.01" },
  },
  EventEnvelope: {
    event_id: "event.finding-created.01",
    event_type: "LearningFindingCreated",
    schema_version: 1,
    correlation_id: "evolution.01",
    causation_id: "event.assessment.01",
    trace_id: "trace.01",
    producer: "learning-scientist",
    idempotency_key: "finding:solar-energy@1.2.0:cohort.beginner",
    occurred_at: "2026-08-05T10:05:00Z",
    artifact_refs: [evidenceArtifact],
    payload: { finding_id: "finding.01" },
  },
  AgentResult: {
    result_id: "result.engineer.01",
    task_id: "task.build-plugin.01",
    schema_version: 1,
    status: "completed",
    completed_at: "2026-08-05T10:20:00Z",
    snapshots: {
      input_version: "snapshot.input.01",
      model: "model.code.01",
      prompt: "prompt.engineer.01",
      tools: "tools.engineer.01",
      knowledge: "knowledge.engineer.01",
    },
    artifact_refs: [pluginArtifact],
    output: { changeset_id: "changeset.01" },
  },
  LearningEvent: {
    event_id: "learning-event.01",
    learner_id: "learner.01",
    world_id: "world.mars.01",
    mission_id: "mission.solar.01",
    event_type: "challenge_attempted",
    occurred_at: "2026-08-05T09:00:00Z",
    plugin_exposure: {
      plugin_id: "solar-energy",
      version: "1.2.0",
      digest,
    },
    artifact_refs: [evidenceArtifact],
    attributes: { predicted_constant_output: true },
  },
  LearningFinding: {
    finding_id: "finding.01",
    scope: {
      world_id: "world.mars.01",
      plugin_version: "solar-energy@1.2.0",
      cohort: "cohort.beginner",
    },
    problem: "Learners infer that solar output remains constant throughout the day.",
    evidence_refs: [evidenceArtifact],
    affected_concepts: ["physics.energy.power"],
    confidence: 0.91,
    severity: "high",
    recommended_change_type: "plugin_and_instruction",
    success_criteria: {
      delayed_retention_delta: 0.08,
      transfer_success_delta: 0.05,
      no_harm_constraints: ["assessment_invariance", "accessibility"],
    },
  },
  ImprovementPlan: {
    plan_id: "plan.01",
    finding_id: "finding.01",
    status: "approved",
    change_class: "A3",
    target_artifact: pluginArtifact,
    allowed_paths: ["plugins/solar-energy/src/daylight.ts"],
    risk_level: "high",
    verification_contract: ["physics_invariants", "assessment_invariance", "accessibility"],
    rollback_target: pluginArtifact,
    approved_by: "teacher.01",
    approved_at: "2026-08-05T10:10:00Z",
  },
  ChangeSet: {
    changeset_id: "changeset.01",
    plan_id: "plan.01",
    source_snapshot: pluginArtifact,
    patch_commit: "abcdef0123456789",
    plugin_artifact: pluginArtifact,
    generated_tests: [evidenceArtifact],
    changed_paths: ["plugins/solar-energy/src/daylight.ts"],
    risk_declaration: ["Changes the simulated daylight curve"],
  },
  VerificationReport: {
    report_id: "verification.01",
    changeset_id: "changeset.01",
    status: "passed",
    baseline_snapshot: evidenceArtifact,
    checks: [
      {
        name: "physics_invariants",
        status: "passed",
        evidence_refs: [evidenceArtifact],
      },
      {
        name: "assessment_invariance",
        status: "passed",
        evidence_refs: [evidenceArtifact],
      },
    ],
  },
  LearningOutcome: {
    outcome_id: "outcome.01",
    plan_id: "plan.01",
    plugin_artifact: pluginArtifact,
    cohort: "cohort.synthetic.beginner",
    metrics: {
      mastery_delta: 0.1,
      delayed_retention_delta: 0.09,
      transfer_success_delta: 0.06,
      harm_signals: 0,
    },
    decision: "recommend_activate",
    evidence_refs: [evidenceArtifact],
  },
};

test("all v1 contract examples pass their JSON Schema", () => {
  for (const [contractName, value] of Object.entries(validContracts)) {
    assertContract(contractName as ContractName, value);
  }
});

test("a task without an idempotency key is rejected", () => {
  const task = { ...(validContracts.TaskEnvelope as Record<string, unknown>) };
  delete task.idempotency_key;

  const result = validateContract("TaskEnvelope", task);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.params.missingProperty === "idempotency_key"));
});

test("an approved plan requires approval identity and timestamp", () => {
  const plan = {
    ...(validContracts.ImprovementPlan as Record<string, unknown>),
    approved_by: undefined,
    approved_at: undefined,
  };

  const result = validateContract("ImprovementPlan", plan);
  assert.equal(result.valid, false);
});

test("a failed Agent result requires a structured error", () => {
  const resultValue = {
    ...(validContracts.AgentResult as Record<string, unknown>),
    status: "failed",
  };

  const result = validateContract("AgentResult", resultValue);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.params.missingProperty === "error"));
});

test("artifact digests must be immutable SHA-256 references", () => {
  const result = validateContract("ArtifactRef", {
    ...evidenceArtifact,
    digest: "latest",
  });

  assert.equal(result.valid, false);
});
