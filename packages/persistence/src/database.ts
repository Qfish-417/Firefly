import { Kysely, PostgresDialect, type Generated, type JSONColumnType } from "kysely";
import { Pool } from "pg";

import type { ArtifactScope, JsonObject } from "@firefly/contracts";
import type { EvolutionRunState, PluginReleaseState } from "@firefly/learning-domain";

export type Timestamp = Date;
export type JsonDocument = JSONColumnType<JsonObject, JsonObject, JsonObject>;
export type JsonList = JSONColumnType<readonly JsonObject[], string, string>;

export interface EvolutionRunTable {
  id: string;
  correlation_id: string;
  state: EvolutionRunState;
  version: number;
  goal: JsonDocument;
  budget: JsonDocument;
  risk_level: "low" | "medium" | "high";
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface EvolutionTransitionTable {
  event_id: string;
  run_id: string;
  event_type: string;
  from_state: EvolutionRunState;
  to_state: EvolutionRunState;
  from_version: number;
  to_version: number;
  occurred_at: Generated<Timestamp>;
}

export interface WorkflowTaskTable {
  id: string;
  run_id: string;
  task_type: string;
  subject: string;
  status: "pending" | "leased" | "completed" | "failed" | "canceled" | "needs_human";
  payload: JsonDocument;
  artifact_refs: JsonList;
  idempotency_key: string;
  available_at: Timestamp;
  deadline: Timestamp;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Timestamp | null;
  cancellation_requested: boolean;
  result: JsonDocument | null;
  last_error: JsonDocument | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
  root_run_id: Generated<string | null>;
  parent_task_id: Generated<string | null>;
  hop_count: Generated<number>;
  max_hops: Generated<number>;
  task_fingerprint: Generated<string | null>;
  policy_snapshot: Generated<string | null>;
  epoch: Generated<number>;
  cooldown_key: Generated<string | null>;
}

export interface TaskCheckpointTable {
  task_id: string;
  sequence: number;
  checkpoint: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface ApprovalTable {
  id: string;
  run_id: string;
  subject_type: string;
  subject_id: string;
  status: "pending" | "approved" | "rejected";
  requested_by: string;
  decided_by: string | null;
  reason: string | null;
  requested_at: Generated<Timestamp>;
  decided_at: Timestamp | null;
}

export interface OutboxEventTable {
  event_id: string;
  event_type: string;
  schema_version: number;
  correlation_id: string;
  causation_id: string | null;
  trace_id: string;
  producer: string;
  idempotency_key: string;
  payload: JsonDocument;
  artifact_refs: JsonList;
  occurred_at: Timestamp;
  available_at: Timestamp;
  attempts: number;
  locked_by: string | null;
  locked_until: Timestamp | null;
  published_at: Timestamp | null;
  last_error: string | null;
  created_at: Generated<Timestamp>;
}

export interface InboxReceiptTable {
  consumer: string;
  event_id: string;
  received_at: Generated<Timestamp>;
}

export interface ArtifactTable {
  id: string;
  uri: string;
  digest: string;
  media_type: string;
  scope: ArtifactScope;
  owner_id: string;
  metadata: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface ArtifactAclTable {
  artifact_id: string;
  principal_type: "user" | "agent" | "tenant" | "role";
  principal_id: string;
  permission: "read" | "write" | "delete";
  created_at: Generated<Timestamp>;
}

export interface ArtifactLineageTable {
  artifact_id: string;
  source_artifact_id: string;
  relation: string;
  created_at: Generated<Timestamp>;
}

export interface LearningEventTable {
  event_id: string;
  run_id: string;
  causation_id: string | null;
  payload: JsonDocument;
  occurred_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface AgentResultTable {
  result_id: string;
  run_id: string;
  task_id: string;
  agent_id: "learning-director" | "learning-scientist" | "experience-engineer";
  status: "completed" | "failed" | "canceled" | "needs_human";
  snapshots: JsonDocument;
  artifact_refs: JsonList;
  output: JsonDocument;
  completed_at: Timestamp;
}

export interface LearningFindingTable {
  finding_id: string;
  run_id: string;
  causation_id: string;
  payload: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface ImprovementPlanTable {
  plan_id: string;
  run_id: string;
  finding_id: string;
  causation_id: string;
  status: "proposed" | "approved" | "rejected";
  payload: JsonDocument;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ChangeSetTable {
  changeset_id: string;
  run_id: string;
  plan_id: string;
  causation_id: string;
  payload: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface VerificationReportTable {
  report_id: string;
  run_id: string;
  changeset_id: string;
  causation_id: string;
  status: "passed" | "failed";
  payload: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface LearningOutcomeTable {
  outcome_id: string;
  run_id: string;
  plan_id: string;
  causation_id: string;
  decision: "recommend_activate" | "recommend_rollback" | "needs_human";
  payload: JsonDocument;
  created_at: Generated<Timestamp>;
}

export interface CausalEdgeTable {
  run_id: string;
  parent_node_id: string;
  child_node_id: string;
  edge_type: "task" | "event" | "artifact" | "transition";
  created_at: Generated<Timestamp>;
}

export interface RunBudgetUsageTable {
  run_id: string;
  tasks_created: Generated<number>;
  transitions_applied: Generated<number>;
  tokens_used: Generated<number>;
  cost_microusd: Generated<number>;
  tool_calls: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface SentinelIncidentTable {
  incident_id: string;
  run_id: string;
  incident_type:
    | "causal_cycle"
    | "hop_limit"
    | "task_repetition"
    | "budget_exhausted"
    | "delegation_violation"
    | "state_oscillation"
    | "event_storm";
  severity: "medium" | "high" | "critical";
  fingerprint: string;
  status: "open" | "acknowledged" | "resolved";
  action: "reject" | "pause" | "quarantine" | "needs_human" | "rollback";
  details: JsonDocument;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  occurrence_count: Generated<number>;
}

export interface QuarantineTable {
  quarantine_id: string;
  run_id: string;
  subject_type: "run" | "agent" | "task" | "plugin" | "tool";
  subject_id: string;
  incident_id: string;
  reason: string;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_by: string | null;
}

export interface SentinelObservationTable {
  observation_id: string;
  run_id: string;
  signal_type: string;
  fingerprint: string;
  observed_at: Timestamp;
}

export interface PluginTable {
  plugin_id: string;
  active_version_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PluginVersionTable {
  version_id: string;
  plugin_id: string;
  version: string;
  digest: string;
  artifact_ref: JsonDocument;
  source_commit: string;
  status: "candidate" | "active" | "inactive" | "quarantined";
  created_at: Generated<Timestamp>;
}

export interface PluginReleaseTable {
  release_id: string;
  run_id: string;
  plugin_id: string;
  candidate_version_id: string;
  rollback_version_id: string;
  changeset_id: string;
  authorized_task_id: string;
  state: PluginReleaseState;
  version: number;
  canary_policy: JsonDocument;
  verification_report_id: string | null;
  approval_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PluginReleaseTransitionTable {
  event_id: string;
  release_id: string;
  event_type: string;
  from_state: PluginReleaseState;
  to_state: PluginReleaseState;
  from_version: number;
  to_version: number;
  evidence: JsonDocument;
  occurred_at: Timestamp;
}

export interface SandboxRunTable {
  sandbox_run_id: string;
  release_id: string;
  status: "passed" | "failed" | "timed_out";
  runner: "docker";
  image: string;
  network_mode: "none";
  read_only: true;
  limits: JsonDocument;
  checks: JsonList;
  started_at: Timestamp;
  completed_at: Timestamp;
}

export interface CanaryEvaluationTable {
  evaluation_id: string;
  release_id: string;
  cohort: string;
  sample_size: number;
  metrics: JsonDocument;
  decision: "activate" | "rollback" | "needs_human";
  evidence_refs: JsonList;
  evaluated_at: Timestamp;
}

export interface ModelInvocationTable {
  invocation_id: string;
  request_id: string;
  workload: string;
  route_id: string;
  transport_id: string;
  provider: string;
  model: string;
  attempt: number;
  status: "succeeded" | "failed";
  started_at: Timestamp;
  completed_at: Timestamp;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  total_tokens: number | null;
  cost_microusd: number | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: boolean | null;
  prompt_snapshot: string;
  tools_snapshot: string;
  knowledge_snapshot: string;
  model_snapshot: string | null;
  routing_snapshot: string | null;
  created_at: Generated<Timestamp>;
}

export type MemoryScope = "public" | "tenant" | "agent_private" | "user_private" | "session";
export type MemoryStage = "raw" | "episodic" | "structured" | "semantic" | "procedural" | "archived";
export type MemoryStatus = "captured" | "normalized" | "structured" | "indexed" | "consolidated" | "active" | "quarantined" | "deleted";

export interface MemoryRecordTable {
  memory_id: string;
  tenant_id: string;
  owner_type: "platform" | "tenant" | "agent" | "user" | "session";
  owner_id: string;
  scope: MemoryScope;
  stage: MemoryStage;
  kind: string;
  content_digest: string;
  source_refs: JsonList;
  metadata: JsonDocument;
  confidence: number;
  sensitivity: "public" | "internal" | "private" | "restricted";
  status: MemoryStatus;
  valid_from: Timestamp | null;
  valid_to: Timestamp | null;
  version: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: Timestamp | null;
}

export interface MemoryAclTable {
  memory_id: string;
  principal_type: "user" | "agent" | "tenant" | "role" | "session";
  principal_id: string;
  permission: "read" | "write" | "delete";
  created_at: Generated<Timestamp>;
}

export interface StructuredEventTable {
  event_id: string;
  tenant_id: string;
  subject_id: string;
  event_type: string;
  object: JsonDocument;
  scope: MemoryScope;
  owner_id: string;
  occurred_from: Timestamp;
  occurred_to: Timestamp | null;
  dedupe_key: string;
  source_memory_ids: JsonList;
  confidence: number;
  conflict_status: "none" | "conflict" | "superseded";
  created_at: Generated<Timestamp>;
}

export interface QuestLabDatabase {
  "questlab.evolution_run": EvolutionRunTable;
  "questlab.evolution_transition": EvolutionTransitionTable;
  "questlab.workflow_task": WorkflowTaskTable;
  "questlab.task_checkpoint": TaskCheckpointTable;
  "questlab.approval": ApprovalTable;
  "questlab.outbox_event": OutboxEventTable;
  "questlab.inbox_receipt": InboxReceiptTable;
  "questlab.artifact": ArtifactTable;
  "questlab.artifact_acl": ArtifactAclTable;
  "questlab.artifact_lineage": ArtifactLineageTable;
  "questlab.learning_event": LearningEventTable;
  "questlab.agent_result": AgentResultTable;
  "questlab.learning_finding": LearningFindingTable;
  "questlab.improvement_plan": ImprovementPlanTable;
  "questlab.change_set": ChangeSetTable;
  "questlab.verification_report": VerificationReportTable;
  "questlab.learning_outcome": LearningOutcomeTable;
  "questlab.causal_edge": CausalEdgeTable;
  "questlab.run_budget_usage": RunBudgetUsageTable;
  "questlab.sentinel_incident": SentinelIncidentTable;
  "questlab.quarantine": QuarantineTable;
  "questlab.sentinel_observation": SentinelObservationTable;
  "questlab.plugin": PluginTable;
  "questlab.plugin_version": PluginVersionTable;
  "questlab.plugin_release": PluginReleaseTable;
  "questlab.plugin_release_transition": PluginReleaseTransitionTable;
  "questlab.sandbox_run": SandboxRunTable;
  "questlab.canary_evaluation": CanaryEvaluationTable;
  "questlab.model_invocation": ModelInvocationTable;
  "questlab.memory_record": MemoryRecordTable;
  "questlab.memory_acl": MemoryAclTable;
  "questlab.structured_event": StructuredEventTable;
}

export function createDatabase(connectionString: string): Kysely<QuestLabDatabase> {
  return new Kysely<QuestLabDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  });
}
