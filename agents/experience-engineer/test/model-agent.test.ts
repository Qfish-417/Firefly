import assert from "node:assert/strict";
import test from "node:test";

import type {
  ArtifactRef,
  ChangeSet,
  ImprovementPlan,
  TaskEnvelope,
  VerificationReport,
} from "@firefly/contracts";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationStreamEvent,
  TextGenerationPort,
} from "@firefly/model-gateway";
import type {
  PluginEngineeringTool,
  PluginSourceFile,
  VerifiedPluginCandidate,
  WorktreePatchFile,
} from "@firefly/plugin-platform";

import { EngineerModelOutputError, ExperienceEngineerAgent } from "../src/index.ts";

const sourceArtifact: ArtifactRef = {
  artifact_id: "artifact.plugin.engineer-source",
  uri: "urn:firefly:plugin:solar-energy:1.2.0",
  digest: `sha256:${"a".repeat(64)}`,
  media_type: "application/vnd.firefly.plugin+json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: [],
};

const plan: ImprovementPlan = {
  plan_id: "plan.engineer-model-unit",
  finding_id: "finding.engineer-model-unit",
  status: "approved",
  change_class: "A3",
  target_artifact: sourceArtifact,
  allowed_paths: [
    "plugins/solar-energy/manifest.json",
    "plugins/solar-energy/src/daylight.mjs",
  ],
  risk_level: "high",
  verification_contract: ["physics_invariants", "assessment_invariance"],
  rollback_target: sourceArtifact,
  approved_by: "teacher.unit",
  approved_at: "2026-08-06T09:00:00.000Z",
};

test("model Engineer turns an approved patch proposal into real tool evidence", async () => {
  const gateway = new FakeGateway({
    patch_files: [
      {
        path: "plugins/solar-energy/src/daylight.mjs",
        content: "export const output = 0;\n",
      },
    ],
    risk_declaration: ["changes daylight behavior"],
  });
  const engineering = new FakeEngineeringTool();
  const result = await new ExperienceEngineerAgent(gateway, engineering).execute(task(), {
    now: () => new Date("2026-08-06T09:01:00.000Z"),
  });

  assert.equal(engineering.buildCalls.length, 1);
  assert.deepEqual(gateway.requests[0]?.attribution, {
    run_id: "run.engineer-model-unit",
    task_id: "task.engineer-model-unit",
    agent_id: "experience-engineer",
    origin: "business_agent",
  });
  assert.equal(engineering.buildCalls[0]?.[0]?.path, "plugins/solar-energy/src/daylight.mjs");
  assert.equal((result.output.change_set as unknown as ChangeSet).patch_commit, "a".repeat(40));
  assert.equal((result.output.verification_report as unknown as VerificationReport).status, "passed");
  assert.match(result.snapshots.tools ?? "", /plugin-engineering:isolated-worktree-sandbox\.v1/);
  assert.ok(result.artifact_refs.some((artifact) => artifact.artifact_id.startsWith("artifact.patch-proposal")));
});

test("model Engineer rejects an unapproved path before invoking the engineering tool", async () => {
  const gateway = new FakeGateway({
    patch_files: [{ path: "packages/governance/src/policy.ts", content: "export {}" }],
    risk_declaration: [],
  });
  const engineering = new FakeEngineeringTool();

  await assert.rejects(
    new ExperienceEngineerAgent(gateway, engineering).execute(task(), { now: () => new Date() }),
    EngineerModelOutputError,
  );
  assert.equal(engineering.buildCalls.length, 0);
});

class FakeGateway implements TextGenerationPort {
  readonly requests: GenerationRequest[] = [];
  private readonly response: unknown;

  constructor(response: unknown) {
    this.response = response;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(request);
    return {
      request_id: request.request_id,
      text: JSON.stringify(this.response),
      finish_reason: "stop",
      route_id: "route.engineer.test",
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cached_input_tokens: 0,
        total_tokens: 700,
        cost_usd: 0.01,
      },
      latency_ms: 50,
      snapshots: {
        ...request.snapshots,
        model: "model:engineer-test:v1",
        routing: "routing:engineer-test:v1",
      },
    };
  }

  async *stream(_request: GenerationRequest): AsyncIterable<GenerationStreamEvent> {
    throw new Error("not used");
  }
}

class FakeEngineeringTool implements PluginEngineeringTool {
  readonly buildCalls: (readonly WorktreePatchFile[])[] = [];

  async loadApprovedSource(
    _plan: ImprovementPlan,
    _signal?: AbortSignal,
  ): Promise<readonly PluginSourceFile[]> {
    return [
      {
        path: "plugins/solar-energy/src/daylight.mjs",
        content: "export const output = 1;\n",
      },
    ];
  }

  async buildAndVerify(input: {
    readonly run_id: string;
    readonly plan: ImprovementPlan;
    readonly patch_files: readonly WorktreePatchFile[];
    readonly signal?: AbortSignal;
  }): Promise<VerifiedPluginCandidate> {
    this.buildCalls.push(input.patch_files);
    const candidate: ArtifactRef = {
      artifact_id: "artifact.plugin.engineer-candidate",
      uri: "urn:firefly:plugin:solar-energy:1.3.0",
      digest: `sha256:${"b".repeat(64)}`,
      media_type: "application/vnd.firefly.plugin+json",
      scope: "tenant",
      owner_id: "tenant.questlab",
      lineage_ids: [sourceArtifact.artifact_id],
    };
    const evidence: ArtifactRef = {
      artifact_id: "artifact.sandbox.engineer-unit.physics",
      uri: "urn:firefly:sandbox:engineer-unit:physics",
      digest: `sha256:${"c".repeat(64)}`,
      media_type: "application/json",
      scope: "tenant",
      owner_id: "tenant.questlab",
      lineage_ids: [candidate.artifact_id],
    };
    const changeSet: ChangeSet = {
      changeset_id: `changeset.${input.run_id}`,
      plan_id: input.plan.plan_id,
      source_snapshot: input.plan.target_artifact,
      patch_commit: "a".repeat(40),
      plugin_artifact: candidate,
      generated_tests: [],
      changed_paths: input.patch_files.map((file) => file.path),
      risk_declaration: ["isolated-worktree", "requires-independent-gates"],
    };
    const verification: VerificationReport = {
      report_id: `verification.${input.run_id}`,
      changeset_id: changeSet.changeset_id,
      status: "passed",
      baseline_snapshot: sourceArtifact,
      checks: [
        { name: "physics_invariants", status: "passed", evidence_refs: [evidence] },
        { name: "assessment_invariance", status: "passed", evidence_refs: [evidence] },
      ],
    };
    return {
      change_set: changeSet,
      verification,
      sandbox: {
        status: "passed",
        runner: "docker",
        image: `node@sha256:${"d".repeat(64)}`,
        network: "none",
        read_only: true,
        limits: { timeout_ms: 30_000, memory_mb: 128, cpus: 1, pids: 64 },
        checks: verification.checks.map((check) => ({
          name: check.name,
          status: "passed" as const,
          exit_code: 0,
          stdout: "",
          stderr: "",
          evidence,
        })),
      },
    };
  }
}

function task(): TaskEnvelope {
  return {
    message_id: "task.engineer-model-unit",
    message_type: "BuildPluginChangeTask",
    schema_version: 1,
    correlation_id: "run.engineer-model-unit",
    trace_id: "trace.engineer-model-unit",
    producer: "control-plane",
    subject: "experience-engineer",
    idempotency_key: "build:engineer-model-unit",
    created_at: "2026-08-06T09:00:00.000Z",
    deadline: "2026-08-06T09:10:00.000Z",
    cancellation_token: "cancel.engineer-model-unit",
    lease: { duration_sec: 300, heartbeat_sec: 30 },
    retry_policy: { max_attempts: 1, initial_backoff_ms: 100, max_backoff_ms: 1_000 },
    budget: { max_tokens: 20_000, max_cost_usd: 1, max_duration_sec: 120 },
    governance: {
      root_run_id: "run.engineer-model-unit",
      hop_count: 2,
      max_hops: 8,
      task_fingerprint: `sha256:${"3".repeat(64)}`,
      policy_snapshot: "governance:test:v1",
      epoch: 0,
    },
    artifact_refs: [sourceArtifact],
    payload: { plan: plan as unknown as never },
  };
}
