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

export interface GovernanceContext {
  readonly root_run_id: string;
  readonly parent_task_id?: string;
  readonly hop_count: number;
  readonly max_hops: number;
  readonly task_fingerprint: `sha256:${string}`;
  readonly policy_snapshot: string;
  readonly epoch: number;
  readonly cooldown_key?: string;
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
  readonly governance?: GovernanceContext;
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
  readonly governance?: GovernanceContext;
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

export interface PatchProposal {
  readonly proposal_id: string;
  readonly plan_id: string;
  readonly source_snapshot: ArtifactRef;
  readonly proposal_artifact: ArtifactRef;
  readonly files: readonly {
    readonly path: string;
    readonly content_digest: `sha256:${string}`;
    readonly byte_length: number;
  }[];
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

export type QueryIntent =
  | "fact_lookup"
  | "count_events"
  | "comparison"
  | "multi_hop"
  | "exploratory"
  | "temporal"
  | "multimodal";

export type RetrievalStage =
  | "structured"
  | "lexical"
  | "vector"
  | "graph"
  | "temporal"
  | "multimodal";

export type SearchStage = Exclude<RetrievalStage, "structured">;

export interface QueryPlan {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly intent: QueryIntent;
  readonly structured_query_required: boolean;
  readonly answer_source: "rag" | "structured" | "structured_plus_evidence";
  readonly stages: readonly RetrievalStage[];
  readonly candidate_k: number;
  readonly fusion_k: number;
  readonly rerank_k: number;
  readonly context_k: number;
  readonly min_context_k: number;
  readonly max_context_tokens: number;
  readonly score_floor: number;
  readonly marginal_gain_floor: number;
  readonly evidence_coverage_target: number;
}

export interface EvidenceCitation {
  readonly artifact_id: string;
  readonly uri: string;
  readonly digest: `sha256:${string}`;
  readonly locator?: Readonly<Record<string, string | number>>;
}

export interface StructuredResult {
  readonly operation: "count_distinct" | "group_by" | "comparison" | "path" | "temporal";
  readonly value: string | number | boolean | null;
  readonly included_ids: readonly string[];
  readonly excluded_reasons: readonly string[];
  readonly conflicts: readonly string[];
}

export interface EvidenceItem {
  readonly evidence_id: string;
  readonly untrusted_content: string;
  readonly score: number;
  readonly source_type: string;
  readonly entity_keys: readonly string[];
  readonly citation: EvidenceCitation;
}

export interface EvidencePack {
  readonly schema_version: 1;
  readonly query_id: string;
  readonly original_query: string;
  readonly status: "sufficient" | "insufficient";
  readonly plan: QueryPlan;
  readonly structured_result?: StructuredResult;
  readonly evidence: readonly EvidenceItem[];
  readonly conflicts: readonly string[];
  readonly coverage: number;
  readonly citation_required: boolean;
  readonly allowed_usage: string;
  readonly generation_allowed: boolean;
  readonly trace: {
    readonly retrievers: readonly {
      readonly id: string;
      readonly stage: SearchStage;
      readonly returned: number;
      readonly failed: boolean;
    }[];
    readonly fused: number;
    readonly authorized: number;
    readonly denied: number;
    readonly selected: number;
    readonly stop_reason: "context_k" | "token_budget" | "score_floor" | "exhausted";
  };
}

export type RetrievalIndexKind = "lexical" | "vector" | "hybrid" | "multimodal";

export interface IndexBuildTask {
  readonly schema_version: 1;
  readonly build_id: string;
  readonly index_version_id: string;
  readonly tenant_id: string;
  readonly logical_name: string;
  readonly index_kind: RetrievalIndexKind;
  readonly provider: string;
  readonly source_watermark: string;
  readonly configuration_digest: `sha256:${string}`;
  readonly embedding_model?: string;
  readonly embedding_dimensions?: number;
  readonly requested_at: string;
}

export interface IndexBuildResult {
  readonly schema_version: 1;
  readonly build_id: string;
  readonly index_version_id: string;
  readonly status: "ready" | "failed";
  readonly document_count: number;
  readonly chunk_count: number;
  readonly source_watermark: string;
  readonly completed_at: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type DeletionPropagationTarget =
  | "object_store"
  | "external_lexical"
  | "external_vector"
  | "multimodal_index"
  | "cache"
  | "summary"
  | "evaluation";

export interface DeletionPropagationTask {
  readonly schema_version: 1;
  readonly deletion_id: string;
  readonly memory_id: string;
  readonly tenant_id: string;
  readonly target: DeletionPropagationTarget;
  readonly content_digest: `sha256:${string}`;
  readonly resource_refs: readonly ArtifactRef[];
  readonly requested_at: string;
}

export interface DeletionPropagationAck {
  readonly schema_version: 1;
  readonly ack_id: string;
  readonly deletion_id: string;
  readonly target: DeletionPropagationTarget;
  readonly status: "completed" | "failed";
  readonly attempt: number;
  readonly occurred_at: string;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type ContractName =
  | "ArtifactRef"
  | "TaskEnvelope"
  | "EventEnvelope"
  | "AgentResult"
  | "LearningEvent"
  | "LearningFinding"
  | "ImprovementPlan"
  | "PatchProposal"
  | "ChangeSet"
  | "VerificationReport"
  | "LearningOutcome"
  | "QueryPlan"
  | "EvidenceCitation"
  | "StructuredResult"
  | "EvidenceItem"
  | "EvidencePack"
  | "IndexBuildTask"
  | "IndexBuildResult"
  | "DeletionPropagationTask"
  | "DeletionPropagationAck";
