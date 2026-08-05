import { createHash } from "node:crypto";

import type {
  AgentResult,
  ArtifactRef,
  ChangeSet,
  ImprovementPlan,
  JsonObject,
  TaskEnvelope,
} from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";
import {
  InvalidAgentTaskPayloadError,
  assertTaskAccepted,
  completedAgentResult,
  requireObject,
  type AgentExecutionContext,
  type AgentWorker,
} from "@firefly/agent-kernel";

export class ExperienceEngineerStub implements AgentWorker {
  readonly id = "experience-engineer" as const;
  readonly taskTypes = ["BuildPluginChangeTask"] as const;

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    assertTaskAccepted(this, task, "BuildPluginChangeTask");
    const plan = requireObject(task.payload.plan, task.message_type, "plan") as unknown as ImprovementPlan;
    assertContract("ImprovementPlan", plan);
    if (plan.status !== "approved" || !plan.approved_by || !plan.approved_at) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "an approved plan is required");
    }
    const disallowed = plan.allowed_paths.filter(
      (path) => !path.startsWith("plugins/solar-energy/src/") && !path.startsWith("plugins/solar-energy/test/"),
    );
    if (disallowed.length > 0) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "allowed_paths escape the plugin boundary");
    }

    const contentDigest = createHash("sha256")
      .update(`${plan.plan_id}:solar-energy@1.3.0`)
      .digest("hex");
    const pluginArtifact: ArtifactRef = {
      artifact_id: `artifact.plugin-candidate.${task.correlation_id}`,
      uri: `https://artifacts.firefly.local/plugins/solar-energy/${task.correlation_id}/1.3.0.json`,
      digest: `sha256:${contentDigest}`,
      media_type: "application/vnd.firefly.plugin+json",
      scope: "tenant",
      owner_id: "tenant.questlab",
      lineage_ids: [plan.target_artifact.artifact_id],
    };
    const testDigest = createHash("sha256").update(`${plan.plan_id}:generated-tests`).digest("hex");
    const generatedTest: ArtifactRef = {
      artifact_id: `artifact.generated-tests.${task.correlation_id}`,
      uri: `https://artifacts.firefly.local/tests/${task.correlation_id}/solar-energy.json`,
      digest: `sha256:${testDigest}`,
      media_type: "application/json",
      scope: "tenant",
      owner_id: "tenant.questlab",
      lineage_ids: [pluginArtifact.artifact_id],
    };
    const changeSet: ChangeSet = {
      changeset_id: `changeset.${task.correlation_id}`,
      plan_id: plan.plan_id,
      source_snapshot: plan.target_artifact,
      patch_commit: contentDigest.slice(0, 40),
      plugin_artifact: pluginArtifact,
      generated_tests: [generatedTest],
      changed_paths: [...plan.allowed_paths],
      risk_declaration: ["day-night-model-change", "learning-content-behavior-change"],
    };
    return {
      ...completedAgentResult(task, { change_set: changeSet as unknown as JsonObject }, context.now()),
      artifact_refs: [pluginArtifact, generatedTest],
    };
  }
}
