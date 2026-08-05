import type { AgentResult, JsonObject, TaskEnvelope } from "@firefly/contracts";
import {
  assertTaskAccepted,
  completedAgentResult,
  requireObject,
  requireString,
  type AgentExecutionContext,
  type AgentWorker,
} from "@firefly/agent-kernel";

export * from "./model-agent.ts";

export class LearningDirectorStub implements AgentWorker {
  readonly id = "learning-director" as const;
  readonly taskTypes = ["GenerateMissionPlanTask", "ActivateCanaryMissionTask"] as const;

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    if (task.message_type === "GenerateMissionPlanTask") {
      assertTaskAccepted(this, task, "GenerateMissionPlanTask");
      return this.generateMissionPlan(task, context.now());
    }
    assertTaskAccepted(this, task, "ActivateCanaryMissionTask");
    return this.activateCanary(task, context.now());
  }

  private generateMissionPlan(task: TaskEnvelope, now: Date): AgentResult {
    const worldId = requireString(task.payload.world_id, task.message_type, "world_id");
    const missionId = requireString(task.payload.mission_id, task.message_type, "mission_id");
    const goal = requireString(task.payload.goal, task.message_type, "goal");
    const pluginExposure = requireObject(
      task.payload.plugin_exposure,
      task.message_type,
      "plugin_exposure",
    );
    return completedAgentResult(
      task,
      {
        mission_plan: {
          plan_id: `mission-plan.${task.correlation_id}`,
          world_id: worldId,
          mission_id: missionId,
          goal,
          plugin_exposure: pluginExposure,
          stages: ["predict", "simulate", "explain", "delayed-review", "transfer"],
        },
      },
      now,
    );
  }

  private activateCanary(task: TaskEnvelope, now: Date): AgentResult {
    const planId = requireString(task.payload.plan_id, task.message_type, "plan_id");
    const cohort = requireString(task.payload.cohort, task.message_type, "cohort");
    const pluginArtifact = requireObject(
      task.payload.plugin_artifact,
      task.message_type,
      "plugin_artifact",
    );
    return completedAgentResult(
      task,
      {
        canary_assignment: {
          plan_id: planId,
          cohort,
          plugin_artifact: pluginArtifact,
          exposure_percent: 5,
          assessment_policy: "baseline-locked-v1",
        },
      } as JsonObject,
      now,
    );
  }
}
