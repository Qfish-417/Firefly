export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type ArtifactScope =
  | "public"
  | "tenant"
  | "agent-private"
  | "user-private"
  | "session";

export interface ArtifactRef {
  readonly artifact_id: string;
  readonly uri: string;
  readonly digest: `sha256:${string}`;
  readonly media_type: string;
  readonly scope: ArtifactScope;
  readonly owner_id: string;
  readonly lineage_ids: readonly string[];
}

export interface RetryPolicy {
  readonly max_attempts: number;
  readonly initial_backoff_ms: number;
  readonly max_backoff_ms: number;
}

export interface TaskLease {
  readonly duration_sec: number;
  readonly heartbeat_sec: number;
}

export interface TaskBudget {
  readonly max_tokens: number;
  readonly max_cost_usd: number;
  readonly max_duration_sec: number;
}

export interface TaskEnvelope<TPayload extends JsonObject = JsonObject> {
  readonly message_id: string;
  readonly message_type: string;
  readonly schema_version: 1;
  readonly correlation_id: string;
  readonly causation_id?: string;
  readonly trace_id: string;
  readonly producer: string;
  readonly subject: string;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly deadline: string;
  readonly cancellation_token: string;
  readonly lease: TaskLease;
  readonly retry_policy: RetryPolicy;
  readonly budget: TaskBudget;
  readonly artifact_refs: readonly ArtifactRef[];
  readonly payload: TPayload;
}

export interface EventEnvelope<TPayload extends JsonObject = JsonObject> {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: 1;
  readonly correlation_id: string;
  readonly causation_id?: string;
  readonly trace_id: string;
  readonly producer: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly artifact_refs: readonly ArtifactRef[];
  readonly payload: TPayload;
}

export interface ExecutionSnapshots {
  readonly input_version: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly tools?: string;
  readonly knowledge?: string;
}

export interface AgentResult<TOutput extends JsonObject = JsonObject> {
  readonly result_id: string;
  readonly task_id: string;
  readonly schema_version: 1;
  readonly status: "completed" | "failed" | "canceled" | "needs_human";
  readonly completed_at: string;
  readonly snapshots: ExecutionSnapshots;
  readonly artifact_refs: readonly ArtifactRef[];
  readonly output: TOutput;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type LearningEventType =
  | "mission_activated"
  | "challenge_attempted"
  | "artifact_submitted"
  | "assessment_completed"
  | "hint_consumed"
  | "delayed_review_completed"
  | "transfer_task_completed";

export interface LearningEvent {
  readonly event_id: string;
  readonly learner_id: string;
  readonly world_id: string;
  readonly mission_id: string;
  readonly event_type: LearningEventType;
  readonly occurred_at: string;
  readonly plugin_exposure?: {
    readonly plugin_id: string;
    readonly version: string;
    readonly digest: `sha256:${string}`;
  };
  readonly artifact_refs: readonly ArtifactRef[];
  readonly attributes: JsonObject;
}

export interface LearningFinding {
  readonly finding_id: string;
  readonly scope: {
    readonly world_id: string;
    readonly plugin_version?: string;
    readonly cohort?: string;
  };
  readonly problem: string;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly affected_concepts: readonly string[];
  readonly confidence: number;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly recommended_change_type: "instruction" | "plugin" | "plugin_and_instruction";
  readonly success_criteria: {
    readonly mastery_delta?: number;
    readonly delayed_retention_delta?: number;
    readonly transfer_success_delta?: number;
    readonly no_harm_constraints: readonly string[];
  };
}

export interface ImprovementPlan {
  readonly plan_id: string;
  readonly finding_id: string;
  readonly status: "proposed" | "approved" | "rejected";
  readonly change_class: "A1" | "A2" | "A3";
  readonly target_artifact: ArtifactRef;
  readonly allowed_paths: readonly string[];
  readonly risk_level: "low" | "medium" | "high";
  readonly verification_contract: readonly string[];
  readonly rollback_target: ArtifactRef;
  readonly approved_by?: string;
  readonly approved_at?: string;
}

export interface ChangeSet {
  readonly changeset_id: string;
  readonly plan_id: string;
  readonly source_snapshot: ArtifactRef;
  readonly patch_commit: string;
  readonly plugin_artifact: ArtifactRef;
  readonly generated_tests: readonly ArtifactRef[];
  readonly changed_paths: readonly string[];
  readonly risk_declaration: readonly string[];
}

export interface VerificationReport {
  readonly report_id: string;
  readonly changeset_id: string;
  readonly status: "passed" | "failed";
  readonly baseline_snapshot: ArtifactRef;
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed" | "failed" | "skipped";
    readonly evidence_refs: readonly ArtifactRef[];
  }[];
}

export interface LearningOutcome {
  readonly outcome_id: string;
  readonly plan_id: string;
  readonly plugin_artifact: ArtifactRef;
  readonly cohort: string;
  readonly metrics: {
    readonly mastery_delta: number;
    readonly delayed_retention_delta: number;
    readonly transfer_success_delta: number;
    readonly harm_signals: number;
  };
  readonly decision: "recommend_activate" | "recommend_rollback" | "needs_human";
  readonly evidence_refs: readonly ArtifactRef[];
}

export type ContractName =
  | "ArtifactRef"
  | "TaskEnvelope"
  | "EventEnvelope"
  | "AgentResult"
  | "LearningEvent"
  | "LearningFinding"
  | "ImprovementPlan"
  | "ChangeSet"
  | "VerificationReport"
  | "LearningOutcome";
