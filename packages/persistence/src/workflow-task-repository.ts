import type { AgentResult, JsonObject } from "@firefly/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

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

export class WorkflowTaskRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async enqueue(input: EnqueueTaskInput): Promise<WorkflowTaskRecord> {
    const inserted = await this.db
      .insertInto("questlab.workflow_task")
      .values({
        ...input,
        artifact_refs: JSON.stringify(input.artifact_refs),
        status: "pending",
        attempt: 0,
        lease_owner: null,
        lease_expires_at: null,
        cancellation_requested: false,
        result: null,
        last_error: null,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      return inserted;
    }

    const existing = await this.db
      .selectFrom("questlab.workflow_task")
      .selectAll()
      .where("idempotency_key", "=", input.idempotency_key)
      .executeTakeFirstOrThrow();
    if (
      existing.id !== input.id ||
      existing.run_id !== input.run_id ||
      existing.task_type !== input.task_type ||
      existing.subject !== input.subject
    ) {
      throw new TaskIdempotencyConflictError(input.idempotency_key);
    }
    return existing;
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
