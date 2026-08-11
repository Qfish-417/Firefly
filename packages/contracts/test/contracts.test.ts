import assert from "node:assert/strict";
import test from "node:test";

import {
  assertContract,
  validateContract,
  type ArtifactRef,
  type ContractName,
  type EvidencePack,
  type IndexQualityReport,
  type QueryPlan,
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

const validQueryPlan = {
  schema_version: 1,
  query_id: "query.contract.01",
  intent: "count_events",
  structured_query_required: true,
  answer_source: "structured_plus_evidence",
  stages: ["structured", "lexical", "temporal"],
  candidate_k: 24,
  fusion_k: 40,
  rerank_k: 16,
  context_k: 8,
  min_context_k: 3,
  max_context_tokens: 1_400,
  score_floor: 0.35,
  marginal_gain_floor: 0.02,
  evidence_coverage_target: 0.95,
} satisfies QueryPlan;

const validEvidenceCitation = {
  artifact_id: "artifact.retrieval.01",
  uri: "s3://questlab/evidence/retrieval.01",
  digest,
  locator: { page: 3, section: "result" },
} as const;

const validStructuredResult = {
  operation: "count_distinct",
  value: 3,
  included_ids: ["event.trip.01", "event.trip.02", "event.trip.03"],
  excluded_reasons: ["duplicate source evidence was excluded"],
  conflicts: [],
} as const;

const validEvidenceItem = {
  evidence_id: "evidence.trip.01",
  untrusted_content: "The user described the first authorized trip.",
  score: 0.92,
  source_type: "memory.event",
  entity_keys: ["trip.01"],
  citation: validEvidenceCitation,
} as const;

const validEvidencePack = {
  schema_version: 1,
  query_id: "query.contract.01",
  original_query: "How many distinct trips did the user describe?",
  status: "sufficient",
  plan: validQueryPlan,
  structured_result: validStructuredResult,
  evidence: [validEvidenceItem],
  conflicts: [],
  coverage: 1,
  citation_required: true,
  allowed_usage: "answer_current_user",
  generation_allowed: true,
  trace: {
    retrievers: [{ id: "lexical.primary", stage: "lexical", returned: 3, failed: false }],
    fused: 3,
    authorized: 3,
    denied: 0,
    selected: 1,
    stop_reason: "context_k",
  },
} satisfies EvidencePack;

const validIndexBuildTask = {
  schema_version: 1,
  build_id: "index-build.contract.01",
  index_version_id: "index-version.contract.01",
  tenant_id: "tenant.questlab",
  logical_name: "memory.hybrid",
  index_kind: "hybrid",
  provider: "postgres.pgvector",
  source_watermark: "memory-version:42",
  configuration_digest: digest,
  embedding_model: "embedding.contract.v1",
  embedding_dimensions: 3,
  requested_at: "2026-08-10T12:00:00Z",
} as const;

const validIndexQualityReport = {
  schema_version: 1,
  report_id: "index-quality.contract.01",
  build_id: "index-build.contract.01",
  index_version_id: "index-version.contract.01",
  source_watermark: "memory-version:42",
  configuration_digest: digest,
  passed: true,
  checks: [{
    name: "structure",
    passed: true,
    score: 1,
    threshold: 1,
    sample_size: 8,
    summary: "All source documents produced unique Chunks.",
    evidence_refs: [],
  }],
  evaluated_at: "2026-08-10T12:04:00Z",
} satisfies IndexQualityReport;

const validIndexBuildResult = {
  schema_version: 1,
  build_id: "index-build.contract.01",
  index_version_id: "index-version.contract.01",
  status: "ready",
  document_count: 3,
  chunk_count: 8,
  source_watermark: "memory-version:42",
  completed_at: "2026-08-10T12:05:00Z",
  quality_report: validIndexQualityReport,
} as const;

const validDeletionTask = {
  schema_version: 1,
  deletion_id: "deletion.contract.01",
  memory_id: "memory.contract.01",
  tenant_id: "tenant.questlab",
  target: "external_vector",
  content_digest: digest,
  resource_refs: [evidenceArtifact],
  requested_at: "2026-08-10T12:00:00Z",
} as const;

const validDeletionAck = {
  schema_version: 1,
  ack_id: "deletion-ack.contract.01",
  deletion_id: "deletion.contract.01",
  target: "external_vector",
  status: "completed",
  attempt: 1,
  occurred_at: "2026-08-10T12:01:00Z",
  evidence_refs: [evidenceArtifact],
} as const;

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
    governance: {
      root_run_id: "evolution.01",
      parent_task_id: "task.analyze.01",
      hop_count: 2,
      max_hops: 8,
      task_fingerprint: digest,
      policy_snapshot: "governance.default.v1",
      epoch: 0,
      cooldown_key: "plugin-change.solar-energy",
    },
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
    governance: {
      root_run_id: "evolution.01",
      hop_count: 1,
      max_hops: 8,
      task_fingerprint: digest,
      policy_snapshot: "governance.default.v1",
      epoch: 0,
    },
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
  PatchProposal: {
    proposal_id: "patch-proposal.contract-test",
    plan_id: "plan.contract-test",
    source_snapshot: pluginArtifact,
    proposal_artifact: {
      ...pluginArtifact,
      artifact_id: "artifact.patch-proposal.contract-test",
      uri: "urn:firefly:patch-proposal:contract-test",
      lineage_ids: [pluginArtifact.artifact_id],
    },
    files: [
      {
        path: "plugins/solar-energy/src/daylight.mjs",
        content_digest: `sha256:${"d".repeat(64)}`,
        byte_length: 512,
      },
    ],
    risk_declaration: ["physics-behavior-change"],
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
  QueryPlan: validQueryPlan,
  EvidenceCitation: validEvidenceCitation,
  StructuredResult: validStructuredResult,
  EvidenceItem: validEvidenceItem,
  EvidencePack: validEvidencePack,
  IndexBuildTask: validIndexBuildTask,
  IndexQualityReport: validIndexQualityReport,
  IndexBuildResult: validIndexBuildResult,
  DeletionPropagationTask: validDeletionTask,
  DeletionPropagationAck: validDeletionAck,
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

test("evidence citations require an immutable SHA-256 digest", () => {
  const result = validateContract("EvidenceCitation", {
    ...validEvidenceCitation,
    digest: "sha256:not-a-digest",
  });

  assert.equal(result.valid, false);
});

test("structured query intents cannot masquerade as plain RAG", () => {
  const result = validateContract("QueryPlan", {
    ...validQueryPlan,
    structured_query_required: false,
    answer_source: "rag",
    stages: ["lexical", "temporal"],
  });

  assert.equal(result.valid, false);
});

test("structured aggregation results reject duplicate participating IDs", () => {
  const result = validateContract("StructuredResult", {
    ...validStructuredResult,
    included_ids: ["event.trip.01", "event.trip.01"],
  });

  assert.equal(result.valid, false);
});

test("insufficient evidence can never authorize generation", () => {
  const result = validateContract("EvidencePack", {
    ...validEvidencePack,
    status: "insufficient",
    generation_allowed: true,
  });

  assert.equal(result.valid, false);
});

test("a hidden structured conflict can never authorize generation", () => {
  const result = validateContract("EvidencePack", {
    ...validEvidencePack,
    structured_result: {
      ...validStructuredResult,
      conflicts: ["two authorized sources disagree"],
    },
    conflicts: [],
    generation_allowed: true,
  });

  assert.equal(result.valid, false);
});

test("a structured EvidencePack requires its deterministic result", () => {
  const pack = { ...validEvidencePack } as Record<string, unknown>;
  delete pack.structured_result;

  const result = validateContract("EvidencePack", pack);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.params.missingProperty === "structured_result"));
});

test("vector index builds require immutable embedding shape", () => {
  const task = {
    ...validIndexBuildTask,
    index_kind: "vector",
    embedding_model: undefined,
    embedding_dimensions: undefined,
  };

  assert.equal(validateContract("IndexBuildTask", task).valid, false);
});

test("failed index builds require a structured error", () => {
  const result = validateContract("IndexBuildResult", {
    ...validIndexBuildResult,
    status: "failed",
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.params.missingProperty === "error"));
});

test("a ready index cannot carry a failed quality report", () => {
  const result = validateContract("IndexBuildResult", {
    ...validIndexBuildResult,
    quality_report: {
      ...validIndexQualityReport,
      passed: false,
      checks: [{ ...validIndexQualityReport.checks[0], passed: false, score: 0 }],
    },
  });

  assert.equal(result.valid, false);
});

test("a passing quality report cannot hide a failed check", () => {
  const result = validateContract("IndexQualityReport", {
    ...validIndexQualityReport,
    checks: [{ ...validIndexQualityReport.checks[0], passed: false, score: 0 }],
  });

  assert.equal(result.valid, false);
});

test("deletion propagation targets are allowlisted", () => {
  const result = validateContract("DeletionPropagationTask", {
    ...validDeletionTask,
    target: "arbitrary_bucket",
  });

  assert.equal(result.valid, false);
});

test("deletion propagation carries immutable resource identities", () => {
  const result = validateContract("DeletionPropagationTask", {
    ...validDeletionTask,
    resource_refs: [{ ...evidenceArtifact, digest: "latest" }],
  });

  assert.equal(result.valid, false);
});

test("failed deletion acknowledgements require retry semantics", () => {
  const result = validateContract("DeletionPropagationAck", {
    ...validDeletionAck,
    status: "failed",
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.params.missingProperty === "error"));
});
