import type { AgentResult, ArtifactRef, GovernanceContext, JsonObject } from "@firefly/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { QuestLabDatabase, WorkflowTaskTable } from "./database.ts";

export interface EnqueueTaskInput {
  readonly id: string;
  readonly run_id: string;
  readonly task_type: string;
  readonly subject: string;
  readonly payload: JsonObject;
  readonly artifact_refs: readonly JsonObject[];
  readonly idempotency_key: string;
  readonly available_at: Date;
  readonly deadline: Date;
  readonly max_attempts: number;
}

export interface GovernedEnqueueTaskInput extends Omit<EnqueueTaskInput, "artifact_refs"> {
  readonly artifact_refs: readonly ArtifactRef[];
  readonly governance: GovernanceContext;
  readonly max_tasks_per_run: number;
}

export type WorkflowTaskRecord = Selectable<WorkflowTaskTable>;

export class TaskIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Task idempotency key was reused for a different task: ${idempotencyKey}`);
    this.name = "TaskIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

export class TaskLeaseError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(`Task ${taskId}: ${message}`);
    this.name = "TaskLeaseError";
    this.taskId = taskId;
  }
}

export type TaskGovernanceViolation =
  | "hop_limit"
  | "task_repetition"
  | "budget_exhausted"
  | "delegation_violation";

export class TaskGovernanceError extends Error {
  readonly violation: TaskGovernanceViolation;
  readonly runId: string;
  readonly fingerprint: string;

  constructor(
    violation: TaskGovernanceViolation,
    runId: string,
    fingerprint: string,
    detail: string,
  ) {
    super(`Governance rejected task for ${runId}: ${detail}`);
    this.name = "TaskGovernanceError";
    this.violation = violation;
    this.runId = runId;
    this.fingerprint = fingerprint;
  }
}

type DatabaseExecutor = Kysely<QuestLabDatabase> | Transaction<QuestLabDatabase>;

export class WorkflowTaskRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async enqueue(input: EnqueueTaskInput): Promise<WorkflowTaskRecord> {
    return this.enqueueWith(this.db, input);
  }

  async enqueueGoverned(input: GovernedEnqueueTaskInput): Promise<WorkflowTaskRecord> {
    const { governance } = input;
    if (governance.root_run_id !== input.run_id) {
      throw new TaskGovernanceError(
        "delegation_violation",
        input.run_id,
        governance.task_fingerprint,
        "root_run_id does not match run_id",
      );
    }
    if (
      governance.hop_count < 0 ||
      governance.max_hops < 1 ||
      governance.hop_count > governance.max_hops
    ) {
      throw new TaskGovernanceError(
        "hop_limit",
        input.run_id,
        governance.task_fingerprint,
        `hop ${governance.hop_count} exceeds maximum ${governance.max_hops}`,
      );
    }
    if (input.max_tasks_per_run < 1) {
      throw new TypeError("max_tasks_per_run must be positive");
    }

    return this.db.transaction().execute(async (trx) => {
      const replay = await trx
        .selectFrom("questlab.workflow_task")
        .selectAll()
        .where("idempotency_key", "=", input.idempotency_key)
        .executeTakeFirst();
      if (replay) {
        this.assertReplayMatches(replay, input);
        return replay;
      }

      await trx
        .insertInto("questlab.run_budget_usage")
        .values({ run_id: input.run_id })
        .onConflict((conflict) => conflict.column("run_id").doNothing())
        .execute();
      const usage = await trx
        .selectFrom("questlab.run_budget_usage")
        .selectAll()
        .where("run_id", "=", input.run_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (usage.tasks_created >= input.max_tasks_per_run) {
        throw new TaskGovernanceError(
          "budget_exhausted",
          input.run_id,
          governance.task_fingerprint,
          `task budget ${input.max_tasks_per_run} is exhausted`,
        );
      }

      const quarantined = await trx
        .selectFrom("questlab.quarantine")
        .select("quarantine_id")
        .where("run_id", "=", input.run_id)
        .where("active", "=", true)
        .where((expression) =>
          expression.or([
            expression.and([
              expression("subject_type", "=", "run"),
              expression("subject_id", "=", input.run_id),
            ]),
            expression.and([
              expression("subject_type", "=", "agent"),
              expression("subject_id", "=", input.subject),
            ]),
          ]),
        )
        .executeTakeFirst();
      if (quarantined) {
        throw new TaskGovernanceError(
          "delegation_violation",
          input.run_id,
          governance.task_fingerprint,
          `${input.subject} is quarantined`,
        );
      }

      const repeated = await trx
        .selectFrom("questlab.workflow_task")
        .select("id")
        .where("run_id", "=", input.run_id)
        .where("epoch", "=", governance.epoch)
        .where("task_fingerprint", "=", governance.task_fingerprint)
        .executeTakeFirst();
      if (repeated) {
        throw new TaskGovernanceError(
          "task_repetition",
          input.run_id,
          governance.task_fingerprint,
          `fingerprint already exists in epoch ${governance.epoch}`,
        );
      }

      if (governance.parent_task_id) {
        const parent = await trx
          .selectFrom("questlab.workflow_task")
          .select(["id", "run_id", "subject", "hop_count", "root_run_id"])
          .where("id", "=", governance.parent_task_id)
          .executeTakeFirst();
        if (
          !parent ||
          parent.run_id !== input.run_id ||
          parent.root_run_id !== governance.root_run_id ||
          governance.hop_count !== parent.hop_count + 1 ||
          parent.subject === input.subject
        ) {
          throw new TaskGovernanceError(
            "delegation_violation",
            input.run_id,
            governance.task_fingerprint,
            "parent task is missing, cross-run, wrong-depth, or delegates to the same Agent",
          );
        }
      } else if (governance.hop_count !== 0) {
        throw new TaskGovernanceError(
          "delegation_violation",
          input.run_id,
          governance.task_fingerprint,
          "a root task must have hop_count 0",
        );
      }

      const inserted = await this.enqueueWith(trx, input);
      if (governance.parent_task_id) {
        await trx
          .insertInto("questlab.causal_edge")
          .values({
            run_id: input.run_id,
            parent_node_id: governance.parent_task_id,
            child_node_id: input.id,
            edge_type: "task",
          })
          .execute();
      }
      await trx
        .updateTable("questlab.run_budget_usage")
        .set({
          tasks_created: sql<number>`tasks_created + 1`,
          updated_at: new Date(),
        })
        .where("run_id", "=", input.run_id)
        .execute();
      return inserted;
    });
  }

  private async enqueueWith(
    db: DatabaseExecutor,
    input: EnqueueTaskInput | GovernedEnqueueTaskInput,
  ): Promise<WorkflowTaskRecord> {
    const governance = "governance" in input ? input.governance : undefined;
    const inserted = await db
      .insertInto("questlab.workflow_task")
      .values({
        id: input.id,
        run_id: input.run_id,
        task_type: input.task_type,
        subject: input.subject,
        payload: input.payload,
        idempotency_key: input.idempotency_key,
        available_at: input.available_at,
        deadline: input.deadline,
        max_attempts: input.max_attempts,
        artifact_refs: JSON.stringify(input.artifact_refs),
        status: "pending",
        attempt: 0,
        lease_owner: null,
        lease_expires_at: null,
        cancellation_requested: false,
        result: null,
        last_error: null,
        completed_at: null,
        ...(governance
          ? {
              root_run_id: governance.root_run_id,
              parent_task_id: governance.parent_task_id ?? null,
              hop_count: governance.hop_count,
              max_hops: governance.max_hops,
              task_fingerprint: governance.task_fingerprint,
              policy_snapshot: governance.policy_snapshot,
              epoch: governance.epoch,
              cooldown_key: governance.cooldown_key ?? null,
            }
          : {}),
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      return inserted;
    }

    const existing = await db
      .selectFrom("questlab.workflow_task")
      .selectAll()
      .where("idempotency_key", "=", input.idempotency_key)
      .executeTakeFirstOrThrow();
    this.assertReplayMatches(existing, input);
    return existing;
  }

  private assertReplayMatches(
    existing: WorkflowTaskRecord,
    input: Pick<EnqueueTaskInput, "id" | "run_id" | "task_type" | "subject" | "idempotency_key">,
  ): void {
    if (
      existing.id !== input.id ||
      existing.run_id !== input.run_id ||
      existing.task_type !== input.task_type ||
      existing.subject !== input.subject
    ) {
      throw new TaskIdempotencyConflictError(input.idempotency_key);
    }
  }

  async findById(taskId: string): Promise<WorkflowTaskRecord | undefined> {
    return this.db
      .selectFrom("questlab.workflow_task")
      .selectAll()
      .where("id", "=", taskId)
      .executeTakeFirst();
  }

  async findByRunId(runId: string): Promise<readonly WorkflowTaskRecord[]> {
    return this.db
      .selectFrom("questlab.workflow_task")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute();
  }

  async requestCancellation(taskId: string, now = new Date()): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom("questlab.workflow_task")
        .select(["id", "status"])
        .where("id", "=", taskId)
        .where("status", "in", ["pending", "leased"])
        .forUpdate()
        .executeTakeFirst();
      if (!task) {
        return false;
      }
      await trx
        .updateTable("questlab.workflow_task")
        .set(
          task.status === "pending"
            ? { status: "canceled", cancellation_requested: true, updated_at: now }
            : { cancellation_requested: true, updated_at: now },
        )
        .where("id", "=", taskId)
        .execute();
      return true;
    });
  }

  async claimNext(
    subject: string,
    workerId: string,
    leaseDurationMs: number,
    now = new Date(),
  ): Promise<WorkflowTaskRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom("questlab.workflow_task")
        .selectAll()
        .where("subject", "=", subject)
        .where("available_at", "<=", now)
        .where("deadline", ">", now)
        .where("cancellation_requested", "=", false)
        .whereRef("attempt", "<", "max_attempts")
        .where((expression) =>
          expression.or([
            expression("status", "=", "pending"),
            expression.and([
              expression("status", "=", "leased"),
              expression("lease_expires_at", "<", now),
            ]),
          ]),
        )
        .orderBy("available_at", "asc")
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!task) {
        return undefined;
      }

      return trx
        .updateTable("questlab.workflow_task")
        .set({
          status: "leased",
          lease_owner: workerId,
          lease_expires_at: new Date(now.getTime() + leaseDurationMs),
          attempt: sql<number>`attempt + 1`,
          updated_at: now,
        })
        .where("id", "=", task.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async heartbeat(
    taskId: string,
    workerId: string,
    leaseDurationMs: number,
    now = new Date(),
  ): Promise<WorkflowTaskRecord> {
    const task = await this.db
      .updateTable("questlab.workflow_task")
      .set({
        lease_expires_at: new Date(now.getTime() + leaseDurationMs),
        updated_at: now,
      })
      .where("id", "=", taskId)
      .where("status", "=", "leased")
      .where("lease_owner", "=", workerId)
      .where("lease_expires_at", ">=", now)
      .returningAll()
      .executeTakeFirst();
    if (!task) {
      throw new TaskLeaseError(taskId, "active lease not found");
    }
    return task;
  }

  async saveCheckpoint(
    taskId: string,
    workerId: string,
    sequence: number,
    checkpoint: JsonObject,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const lease = await trx
        .selectFrom("questlab.workflow_task")
        .select("id")
        .where("id", "=", taskId)
        .where("status", "=", "leased")
        .where("lease_owner", "=", workerId)
        .where("lease_expires_at", ">=", now)
        .forUpdate()
        .executeTakeFirst();
      if (!lease) {
        throw new TaskLeaseError(taskId, "cannot checkpoint without an active lease");
      }

      const inserted = await trx
        .insertInto("questlab.task_checkpoint")
        .values({ task_id: taskId, sequence, checkpoint, created_at: now })
        .onConflict((conflict) => conflict.columns(["task_id", "sequence"]).doNothing())
        .returning("task_id")
        .executeTakeFirst();
      return Boolean(inserted);
    });
  }

  async complete(
    taskId: string,
    workerId: string,
    result: JsonObject,
    now = new Date(),
  ): Promise<WorkflowTaskRecord> {
    const task = await this.db
      .updateTable("questlab.workflow_task")
      .set({
        status: "completed",
        result,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where("id", "=", taskId)
      .where("status", "=", "leased")
      .where("lease_owner", "=", workerId)
      .where("lease_expires_at", ">=", now)
      .returningAll()
      .executeTakeFirst();
    if (!task) {
      throw new TaskLeaseError(taskId, "cannot complete without an active lease");
    }
    return task;
  }

  async completeWithAgentResult(
    runId: string,
    agentId: "learning-director" | "learning-scientist" | "experience-engineer",
    workerId: string,
    result: AgentResult,
    now = new Date(),
  ): Promise<WorkflowTaskRecord> {
    if (result.status !== "completed") {
      throw new TaskLeaseError(result.task_id, `cannot complete from Agent result ${result.status}`);
    }
    return this.db.transaction().execute(async (trx) => {
      const task = await trx
        .updateTable("questlab.workflow_task")
        .set({
          status: "completed",
          result: result.output,
          lease_owner: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", result.task_id)
        .where("run_id", "=", runId)
        .where("status", "=", "leased")
        .where("lease_owner", "=", workerId)
        .where("lease_expires_at", ">=", now)
        .returningAll()
        .executeTakeFirst();
      if (!task) {
        throw new TaskLeaseError(result.task_id, "cannot complete without an active lease");
      }

      await trx
        .insertInto("questlab.agent_result")
        .values({
          result_id: result.result_id,
          run_id: runId,
          task_id: result.task_id,
          agent_id: agentId,
          status: result.status,
          snapshots: result.snapshots as unknown as JsonObject,
          artifact_refs: JSON.stringify(result.artifact_refs),
          output: result.output,
          completed_at: new Date(result.completed_at),
        })
        .execute();
      return task;
    });
  }
}
