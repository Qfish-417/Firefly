import type {
  AgentResult,
  ArtifactRef,
  JsonObject,
  LearningEvent,
  LearningFinding,
  LearningOutcome,
  TaskEnvelope,
} from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";
import {
  InvalidAgentTaskPayloadError,
  assertTaskAccepted,
  completedAgentResult,
  requireObject,
  requireString,
  type AgentExecutionContext,
  type AgentWorker,
} from "@firefly/agent-kernel";

export class LearningScientistStub implements AgentWorker {
  readonly id = "learning-scientist" as const;
  readonly taskTypes = ["AnalyzeLearningOutcomeTask", "EvaluateCanaryTask"] as const;

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    if (task.message_type === "AnalyzeLearningOutcomeTask") {
      assertTaskAccepted(this, task, "AnalyzeLearningOutcomeTask");
      return this.analyze(task, context.now());
    }
    assertTaskAccepted(this, task, "EvaluateCanaryTask");
    return this.evaluate(task, context.now());
  }

  private analyze(task: TaskEnvelope, now: Date): AgentResult {
    const events = task.payload.learning_events;
    if (!Array.isArray(events) || events.length === 0) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "learning_events must be non-empty");
    }
    const learningEvents = events as unknown as readonly LearningEvent[];
    for (const event of learningEvents) {
      assertContract("LearningEvent", event);
    }
    const misconceptionEvents = learningEvents.filter(
      (event) => event.attributes.misconception === "constant_solar_output",
    );
    if (misconceptionEvents.length === 0 || task.artifact_refs.length === 0) {
      throw new InvalidAgentTaskPayloadError(
        task.message_type,
        "constant_solar_output evidence and an evidence artifact are required",
      );
    }
    const first = learningEvents[0]!;
    const finding: LearningFinding = {
      finding_id: `finding.${task.correlation_id}`,
      scope: {
        world_id: first.world_id,
        ...(first.plugin_exposure ? { plugin_version: first.plugin_exposure.version } : {}),
        cohort: requireString(task.payload.cohort, task.message_type, "cohort"),
      },
      problem: "Learners incorrectly infer that solar panels produce constant output through day and night.",
      evidence_refs: task.artifact_refs,
      affected_concepts: ["physics.energy.power", "physics.energy.solar-cycle"],
      confidence: 0.92,
      severity: "high",
      recommended_change_type: "plugin_and_instruction",
      success_criteria: {
        mastery_delta: 0.1,
        delayed_retention_delta: 0.08,
        transfer_success_delta: 0.05,
        no_harm_constraints: ["assessment_invariance", "accessibility", "no_regression"],
      },
    };
    return completedAgentResult(task, { finding: finding as unknown as JsonObject }, now);
  }

  private evaluate(task: TaskEnvelope, now: Date): AgentResult {
    const planId = requireString(task.payload.plan_id, task.message_type, "plan_id");
    const cohort = requireString(task.payload.cohort, task.message_type, "cohort");
    const pluginArtifact = requireObject(
      task.payload.plugin_artifact,
      task.message_type,
      "plugin_artifact",
    ) as unknown as ArtifactRef;
    assertContract("ArtifactRef", pluginArtifact);
    if (task.artifact_refs.length === 0) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "evaluation evidence is required");
    }
    const outcome: LearningOutcome = {
      outcome_id: `outcome.${task.correlation_id}`,
      plan_id: planId,
      plugin_artifact: pluginArtifact,
      cohort,
      metrics: {
        mastery_delta: 0.14,
        delayed_retention_delta: 0.1,
        transfer_success_delta: 0.08,
        harm_signals: 0,
      },
      decision: "recommend_activate",
      evidence_refs: task.artifact_refs,
    };
    return completedAgentResult(task, { outcome: outcome as unknown as JsonObject }, now);
  }
}
