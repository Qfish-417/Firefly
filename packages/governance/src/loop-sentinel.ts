import { createHash } from "node:crypto";

import type { TaskEnvelope } from "@firefly/contracts";
import {
  CausalCycleError,
  CausalGraphRepository,
  SentinelRepository,
  TaskGovernanceError,
  WorkflowTaskRepository,
  type CausalEdgeTable,
  type GovernedEnqueueTaskInput,
  type QuestLabDatabase,
  type SentinelIncidentRecord,
  type WorkflowTaskRecord,
} from "@firefly/persistence";
import type { Kysely } from "kysely";

import { fingerprintTask } from "./fingerprint.ts";
import { defaultGovernancePolicy, type GovernancePolicy } from "./policy.ts";

export class MissingGovernanceContextError extends Error {
  constructor(taskId: string) {
    super(`Governed task ${taskId} is missing governance context`);
    this.name = "MissingGovernanceContextError";
  }
}

export class EventStormError extends Error {
  readonly runId: string;
  readonly count: number;

  constructor(runId: string, signalType: string, count: number) {
    super(`Event storm detected for ${signalType} in ${runId}: ${count} observations`);
    this.name = "EventStormError";
    this.runId = runId;
    this.count = count;
  }
}

export class LoopSentinel {
  private readonly taskRepository: WorkflowTaskRepository;
  private readonly graphRepository: CausalGraphRepository;
  private readonly sentinelRepository: SentinelRepository;
  private readonly policy: GovernancePolicy;
  private readonly now: () => Date;

  constructor(
    db: Kysely<QuestLabDatabase>,
    policy: GovernancePolicy = defaultGovernancePolicy,
    now: () => Date = () => new Date(),
  ) {
    this.taskRepository = new WorkflowTaskRepository(db);
    this.graphRepository = new CausalGraphRepository(db);
    this.sentinelRepository = new SentinelRepository(db);
    this.policy = policy;
    this.now = now;
  }

  async dispatch(
    task: TaskEnvelope,
    input: Omit<GovernedEnqueueTaskInput, "governance" | "max_tasks_per_run">,
  ): Promise<WorkflowTaskRecord> {
    const governance = task.governance;
    if (!governance) {
      throw new MissingGovernanceContextError(task.message_id);
    }
    const expectedFingerprint = fingerprintTask({
      task_type: task.message_type,
      subject: task.subject,
      payload: task.payload,
      artifact_refs: task.artifact_refs,
    });
    const persistedFingerprint = fingerprintTask({
      task_type: input.task_type,
      subject: input.subject,
      payload: input.payload,
      artifact_refs: input.artifact_refs,
    });
    if (
      governance.task_fingerprint !== expectedFingerprint ||
      persistedFingerprint !== expectedFingerprint ||
      input.id !== task.message_id ||
      input.run_id !== task.correlation_id ||
      governance.root_run_id !== task.correlation_id ||
      input.idempotency_key !== task.idempotency_key ||
      governance.policy_snapshot !== this.policy.snapshot ||
      governance.max_hops !== this.policy.max_hops
    ) {
      const error = new TaskGovernanceError(
        "delegation_violation",
        input.run_id,
        governance.task_fingerprint,
        "task fingerprint or policy snapshot does not match the active policy",
      );
      await this.handleTaskViolation(error, task.subject);
      throw error;
    }

    try {
      return await this.taskRepository.enqueueGoverned({
        ...input,
        id: task.message_id,
        run_id: task.correlation_id,
        task_type: task.message_type,
        subject: task.subject,
        payload: task.payload,
        artifact_refs: task.artifact_refs,
        idempotency_key: task.idempotency_key,
        deadline: new Date(task.deadline),
        max_attempts: Math.min(
          task.retry_policy.max_attempts,
          this.policy.max_retries_per_task,
        ),
        governance,
        max_tasks_per_run: this.policy.max_tasks_per_run,
      });
    } catch (error) {
      if (error instanceof TaskGovernanceError) {
        await this.handleTaskViolation(error, task.subject);
      }
      throw error;
    }
  }

  async link(input: {
    readonly run_id: string;
    readonly parent_node_id: string;
    readonly child_node_id: string;
    readonly edge_type: CausalEdgeTable["edge_type"];
  }): Promise<void> {
    try {
      await this.graphRepository.addEdge(input);
    } catch (error) {
      if (error instanceof CausalCycleError) {
        const fingerprint = digestText(
          `${input.run_id}:${input.parent_node_id}:${input.child_node_id}:${input.edge_type}`,
        );
        const incident = await this.sentinelRepository.reportIncident({
          incident_id: incidentId(input.run_id, "causal_cycle", fingerprint),
          run_id: input.run_id,
          incident_type: "causal_cycle",
          severity: "critical",
          fingerprint,
          action: "quarantine",
          details: {
            parent_node_id: input.parent_node_id,
            child_node_id: input.child_node_id,
            edge_type: input.edge_type,
          },
          observed_at: this.now(),
        });
        await this.quarantineRun(input.run_id, incident, error.message);
      }
      throw error;
    }
  }

  async observeEvent(input: {
    readonly observation_id: string;
    readonly run_id: string;
    readonly event_type: string;
    readonly fingerprint: string;
    readonly max_occurrences: number;
    readonly window_ms: number;
  }): Promise<number> {
    if (input.max_occurrences < 1 || input.window_ms < 1) {
      throw new TypeError("event storm thresholds must be positive");
    }
    const observedAt = this.now();
    const count = await this.sentinelRepository.recordObservation({
      observation_id: input.observation_id,
      run_id: input.run_id,
      signal_type: input.event_type,
      fingerprint: input.fingerprint,
      observed_at: observedAt,
      window_started_at: new Date(observedAt.getTime() - input.window_ms),
    });
    if (count <= input.max_occurrences) {
      return count;
    }

    const incident = await this.sentinelRepository.reportIncident({
      incident_id: incidentId(input.run_id, "event_storm", input.fingerprint),
      run_id: input.run_id,
      incident_type: "event_storm",
      severity: "critical",
      fingerprint: input.fingerprint,
      action: "quarantine",
      details: {
        event_type: input.event_type,
        count,
        window_ms: input.window_ms,
      },
      observed_at: observedAt,
    });
    const error = new EventStormError(input.run_id, input.event_type, count);
    await this.quarantineRun(input.run_id, incident, error.message);
    throw error;
  }

  private async handleTaskViolation(error: TaskGovernanceError, agentId: string): Promise<void> {
    const policy = violationPolicy(error.violation);
    const incident = await this.sentinelRepository.reportIncident({
      incident_id: incidentId(error.runId, error.violation, error.fingerprint),
      run_id: error.runId,
      incident_type: error.violation,
      severity: policy.severity,
      fingerprint: error.fingerprint,
      action: policy.action,
      details: { message: error.message, agent_id: agentId },
      observed_at: this.now(),
    });
    if (policy.quarantine === "run") {
      await this.quarantineRun(error.runId, incident, error.message);
    } else if (policy.quarantine === "agent") {
      await this.sentinelRepository.quarantine({
        quarantine_id: `quarantine.${incident.incident_id}.agent`,
        run_id: error.runId,
        subject_type: "agent",
        subject_id: agentId,
        incident_id: incident.incident_id,
        reason: error.message,
      });
    }
  }

  private async quarantineRun(
    runId: string,
    incident: SentinelIncidentRecord,
    reason: string,
  ): Promise<void> {
    await this.sentinelRepository.quarantine({
      quarantine_id: `quarantine.${incident.incident_id}.run`,
      run_id: runId,
      subject_type: "run",
      subject_id: runId,
      incident_id: incident.incident_id,
      reason,
    });
  }
}

function violationPolicy(violation: TaskGovernanceError["violation"]): {
  readonly severity: "medium" | "high" | "critical";
  readonly action: "reject" | "quarantine" | "needs_human";
  readonly quarantine?: "run" | "agent";
} {
  switch (violation) {
    case "task_repetition":
      return { severity: "medium", action: "reject" };
    case "delegation_violation":
      return { severity: "high", action: "quarantine", quarantine: "agent" };
    case "hop_limit":
      return { severity: "high", action: "needs_human", quarantine: "run" };
    case "budget_exhausted":
      return { severity: "high", action: "needs_human", quarantine: "run" };
  }
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function incidentId(runId: string, type: string, fingerprint: string): string {
  const suffix = createHash("sha256")
    .update(`${runId}:${type}:${fingerprint}`)
    .digest("hex")
    .slice(0, 24);
  return `incident.${type}.${suffix}`;
}
