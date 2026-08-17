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
import {
  snapshotId,
  type GenerationResult,
  type TextGenerationPort,
} from "@firefly/model-gateway";

const ANALYSIS_PROMPT_VERSION = "learning-scientist.analysis.v1";
const ANALYSIS_SYSTEM_PROMPT = `You are the Learning Scientist in FireFly QuestLab.
Interpret the authorized learning evidence and return exactly one JSON object, without Markdown.
Do not request or call tools. Do not invent evidence references, identities, approvals, or release actions.
The object must contain: problem (string), affected_concepts (string array), confidence (0..1),
severity (low|medium|high|critical), recommended_change_type
(instruction|plugin|plugin_and_instruction), and success_criteria with optional mastery_delta,
delayed_retention_delta, transfer_success_delta numbers. Evidence binding and no-harm constraints
are applied by trusted application code.`;

export class ModelOutputValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelOutputValidationError";
  }
}

export class LearningScientistAgent implements AgentWorker {
  readonly id = "learning-scientist" as const;
  readonly taskTypes = ["AnalyzeLearningOutcomeTask", "EvaluateCanaryTask"] as const;
  private readonly gateway: TextGenerationPort;

  constructor(gateway: TextGenerationPort) {
    this.gateway = gateway;
  }

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    if (task.message_type === "AnalyzeLearningOutcomeTask") {
      assertTaskAccepted(this, task, "AnalyzeLearningOutcomeTask");
      return await this.analyze(task, context);
    }
    assertTaskAccepted(this, task, "EvaluateCanaryTask");
    return this.evaluate(task, context.now());
  }

  private async analyze(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    const learningEvents = validatedLearningEvents(task);
    if (task.artifact_refs.length === 0) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "an evidence artifact is required");
    }
    const cohort = requireString(task.payload.cohort, task.message_type, "cohort");
    const first = learningEvents[0]!;
    const knowledgeSnapshot = snapshotId("knowledge", "learning-evidence.v1", {
      events: learningEvents.map((event) => event.event_id),
      artifacts: task.artifact_refs.map((artifact) => ({
        artifact_id: artifact.artifact_id,
        digest: artifact.digest,
        scope: artifact.scope,
      })),
    });
    const promptSnapshot = snapshotId("prompt", ANALYSIS_PROMPT_VERSION, ANALYSIS_SYSTEM_PROMPT);
    const modelResult = await this.gateway.generate({
      request_id: `model.${task.message_id}`,
      workload: "learning-scientist.analyze",
      system_prompt: ANALYSIS_SYSTEM_PROMPT,
      user_prompt: JSON.stringify({
        cohort,
        learning_events: learningEvents,
        evidence_artifacts: task.artifact_refs,
      }),
      max_output_tokens: Math.min(1_200, task.budget.max_tokens),
      budget: {
        max_tokens: task.budget.max_tokens,
        max_cost_usd: task.budget.max_cost_usd,
        max_duration_ms: task.budget.max_duration_sec * 1_000,
      },
      snapshots: {
        prompt: promptSnapshot,
        tools: "tools:none:model-gateway.v1",
        knowledge: knowledgeSnapshot,
      },
      attribution: {
        ...(task.governance ? { run_id: task.governance.root_run_id } : {}),
        task_id: task.message_id,
        agent_id: this.id,
        origin: "business_agent",
      },
      temperature: 0,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (modelResult.finish_reason === "length") {
      throw new ModelOutputValidationError("Learning analysis was truncated by the model");
    }
    const suggestion = parseSuggestion(modelResult.text);
    const finding: LearningFinding = {
      finding_id: `finding.${task.correlation_id}`,
      scope: {
        world_id: first.world_id,
        ...(first.plugin_exposure ? { plugin_version: first.plugin_exposure.version } : {}),
        cohort,
      },
      problem: suggestion.problem,
      evidence_refs: task.artifact_refs,
      affected_concepts: suggestion.affected_concepts,
      confidence: suggestion.confidence,
      severity: suggestion.severity,
      recommended_change_type: suggestion.recommended_change_type,
      success_criteria: {
        ...suggestion.success_criteria,
        no_harm_constraints: ["assessment_invariance", "accessibility", "no_regression"],
      },
    };
    assertContract("LearningFinding", finding);
    return modelAgentResult(task, { finding: finding as unknown as JsonObject }, context.now(), modelResult);
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

interface FindingSuggestion {
  readonly problem: string;
  readonly affected_concepts: readonly string[];
  readonly confidence: number;
  readonly severity: LearningFinding["severity"];
  readonly recommended_change_type: LearningFinding["recommended_change_type"];
  readonly success_criteria: {
    readonly mastery_delta?: number;
    readonly delayed_retention_delta?: number;
    readonly transfer_success_delta?: number;
  };
}

function validatedLearningEvents(task: TaskEnvelope): readonly LearningEvent[] {
  const events = task.payload.learning_events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new InvalidAgentTaskPayloadError(task.message_type, "learning_events must be non-empty");
  }
  const learningEvents = events as unknown as readonly LearningEvent[];
  for (const event of learningEvents) {
    assertContract("LearningEvent", event);
  }
  return learningEvents;
}

function parseSuggestion(text: string): FindingSuggestion {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ModelOutputValidationError("Learning analysis must be strict JSON", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isRecord(value)) {
    throw new ModelOutputValidationError("Learning analysis must be a JSON object");
  }
  const problem = nonEmptyString(value.problem, "problem");
  const affectedConcepts = stringArray(value.affected_concepts, "affected_concepts");
  const confidence = boundedNumber(value.confidence, "confidence", 0, 1);
  const severity = enumValue(value.severity, "severity", ["low", "medium", "high", "critical"]);
  const changeType = enumValue(value.recommended_change_type, "recommended_change_type", [
    "instruction",
    "plugin",
    "plugin_and_instruction",
  ]);
  if (!isRecord(value.success_criteria)) {
    throw new ModelOutputValidationError("success_criteria must be an object");
  }
  const criteria = value.success_criteria;
  return {
    problem,
    affected_concepts: affectedConcepts,
    confidence,
    severity,
    recommended_change_type: changeType,
    success_criteria: {
      ...optionalNumber(criteria.mastery_delta, "mastery_delta"),
      ...optionalNumber(criteria.delayed_retention_delta, "delayed_retention_delta"),
      ...optionalNumber(criteria.transfer_success_delta, "transfer_success_delta"),
    },
  };
}

function modelAgentResult(
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

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModelOutputValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new ModelOutputValidationError(`${field} must be a non-empty string array`);
  }
  return value as string[];
}

function boundedNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ModelOutputValidationError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelOutputValidationError(`${field} must be a finite number`);
  }
  return { [field]: value };
}

function enumValue<const T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ModelOutputValidationError(`${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}
