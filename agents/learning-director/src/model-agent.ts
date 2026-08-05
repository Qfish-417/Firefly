import type { AgentResult, JsonObject, TaskEnvelope } from "@firefly/contracts";
import {
  assertTaskAccepted,
  completedAgentResult,
  requireObject,
  requireString,
  type AgentExecutionContext,
  type AgentWorker,
} from "@firefly/agent-kernel";
import {
  snapshotId,
  type GenerationResult,
  type TextGenerationPort,
} from "@firefly/model-gateway";

const MISSION_PROMPT_VERSION = "learning-director.mission-plan.v1";
const MISSION_STAGES = ["predict", "simulate", "explain", "delayed-review", "transfer"] as const;
const MISSION_SYSTEM_PROMPT = `You are the Learning Director in FireFly QuestLab.
Return exactly one JSON object without Markdown. Do not call tools and do not make release decisions.
Create guidance for each trusted mission stage: predict, simulate, explain, delayed-review, transfer.
The object must be {"stage_guidance":{"predict":"...","simulate":"...","explain":"...",
"delayed-review":"...","transfer":"..."}}. Each value must be a concise non-empty instruction.
The application binds learner identity, world, mission, goal, plugin exposure and stage order.`;

export class LearningDirectorAgent implements AgentWorker {
  readonly id = "learning-director" as const;
  readonly taskTypes = ["GenerateMissionPlanTask", "ActivateCanaryMissionTask"] as const;
  private readonly gateway: TextGenerationPort;

  constructor(gateway: TextGenerationPort) {
    this.gateway = gateway;
  }

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    if (task.message_type === "GenerateMissionPlanTask") {
      assertTaskAccepted(this, task, "GenerateMissionPlanTask");
      return await this.generateMissionPlan(task, context);
    }
    assertTaskAccepted(this, task, "ActivateCanaryMissionTask");
    return this.activateCanary(task, context.now());
  }

  private async generateMissionPlan(
    task: TaskEnvelope,
    context: AgentExecutionContext,
  ): Promise<AgentResult> {
    const worldId = requireString(task.payload.world_id, task.message_type, "world_id");
    const missionId = requireString(task.payload.mission_id, task.message_type, "mission_id");
    const goal = requireString(task.payload.goal, task.message_type, "goal");
    const pluginExposure = requireObject(
      task.payload.plugin_exposure,
      task.message_type,
      "plugin_exposure",
    );
    const prompt = snapshotId("prompt", MISSION_PROMPT_VERSION, MISSION_SYSTEM_PROMPT);
    const knowledge = snapshotId("knowledge", "mission-context.v1", {
      world_id: worldId,
      mission_id: missionId,
      plugin_exposure: pluginExposure,
      artifacts: task.artifact_refs.map((artifact) => ({
        artifact_id: artifact.artifact_id,
        digest: artifact.digest,
      })),
    });
    const model = await this.gateway.generate({
      request_id: `model.${task.message_id}`,
      workload: "learning-director.mission-plan",
      system_prompt: MISSION_SYSTEM_PROMPT,
      user_prompt: JSON.stringify({ world_id: worldId, mission_id: missionId, goal, plugin_exposure: pluginExposure }),
      max_output_tokens: Math.min(1_000, task.budget.max_tokens),
      budget: {
        max_tokens: task.budget.max_tokens,
        max_cost_usd: task.budget.max_cost_usd,
        max_duration_ms: task.budget.max_duration_sec * 1_000,
      },
      snapshots: { prompt, tools: "tools:none:model-gateway.v1", knowledge },
      temperature: 0.2,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (model.finish_reason === "length") {
      throw new DirectorModelOutputError("Mission guidance was truncated by the model");
    }
    const stageGuidance = parseStageGuidance(model.text);
    return modelResult(
      task,
      {
        mission_plan: {
          plan_id: `mission-plan.${task.correlation_id}`,
          world_id: worldId,
          mission_id: missionId,
          goal,
          plugin_exposure: pluginExposure,
          stages: MISSION_STAGES,
          stage_guidance: stageGuidance,
        },
      },
      context.now(),
      model,
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

export class DirectorModelOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectorModelOutputError";
  }
}

function parseStageGuidance(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DirectorModelOutputError("Mission guidance must be strict JSON", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isRecord(value) || !isRecord(value.stage_guidance)) {
    throw new DirectorModelOutputError("stage_guidance must be an object");
  }
  const guidance = value.stage_guidance;
  const result: Record<string, string> = {};
  for (const stage of MISSION_STAGES) {
    const instruction = guidance[stage];
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new DirectorModelOutputError(`stage_guidance.${stage} must be a non-empty string`);
    }
    result[stage] = instruction;
  }
  return result;
}

function modelResult(
  task: TaskEnvelope,
  output: JsonObject,
  completedAt: Date,
  model: GenerationResult,
): AgentResult {
  return {
    ...completedAgentResult(task, output, completedAt),
    snapshots: {
      input_version: `task-v${task.schema_version}`,
      model: `${model.snapshots.model}|${model.snapshots.routing}`,
      prompt: model.snapshots.prompt,
      tools: model.snapshots.tools,
      knowledge: model.snapshots.knowledge,
    },
    output: {
      ...output,
      model_execution: {
        route_id: model.route_id,
        latency_ms: model.latency_ms,
        usage: model.usage as unknown as JsonObject,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
