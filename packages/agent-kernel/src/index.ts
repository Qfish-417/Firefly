import type { AgentResult, JsonObject, TaskEnvelope } from "@firefly/contracts";

export type AgentId = "learning-director" | "learning-scientist" | "experience-engineer";

export type AgentTaskType =
  | "GenerateMissionPlanTask"
  | "AnalyzeLearningOutcomeTask"
  | "BuildPluginChangeTask"
  | "ActivateCanaryMissionTask"
  | "EvaluateCanaryTask";

export interface AgentExecutionContext {
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}

export interface AgentWorker {
  readonly id: AgentId;
  readonly taskTypes: readonly AgentTaskType[];
  execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult>;
}

export class UnsupportedAgentTaskError extends Error {
  constructor(agentId: AgentId, task: TaskEnvelope) {
    super(`Agent ${agentId} cannot execute ${task.message_type} for ${task.subject}`);
    this.name = "UnsupportedAgentTaskError";
  }
}

export class InvalidAgentTaskPayloadError extends Error {
  constructor(taskType: string, detail: string) {
    super(`Invalid ${taskType} payload: ${detail}`);
    this.name = "InvalidAgentTaskPayloadError";
  }
}

export function assertTaskAccepted(
  worker: AgentWorker,
  task: TaskEnvelope,
  expectedType: AgentTaskType,
): void {
  if (task.subject !== worker.id || task.message_type !== expectedType) {
    throw new UnsupportedAgentTaskError(worker.id, task);
  }
}

export function completedAgentResult(
  task: TaskEnvelope,
  output: JsonObject,
  completedAt: Date,
): AgentResult {
  return {
    result_id: `result.${task.message_id}`,
    task_id: task.message_id,
    schema_version: 1,
    status: "completed",
    completed_at: completedAt.toISOString(),
    snapshots: { input_version: `task-v${task.schema_version}`, tools: "stub-tools-v1" },
    artifact_refs: task.artifact_refs,
    output,
  };
}

export function requireObject(value: unknown, taskType: string, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidAgentTaskPayloadError(taskType, `${field} must be an object`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, taskType: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidAgentTaskPayloadError(taskType, `${field} must be a non-empty string`);
  }
  return value;
}
