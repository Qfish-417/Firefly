import { Kysely, PostgresDialect, type Generated, type JSONColumnType } from "kysely";
import { Pool } from "pg";

import type { ArtifactScope, JsonObject } from "@firefly/contracts";
import type { EvolutionRunState } from "@firefly/learning-domain";

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
}

export function createDatabase(connectionString: string): Kysely<QuestLabDatabase> {
  return new Kysely<QuestLabDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
    }),
  });
}
