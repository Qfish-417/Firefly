import type { ImprovementPlan, JsonObject } from "@firefly/contracts";
import type { Kysely, Selectable } from "kysely";

import type { ApprovalTable, QuestLabDatabase } from "./database.ts";

export type ApprovalRecord = Selectable<ApprovalTable>;

export class ApprovalDecisionError extends Error {
  constructor(approvalId: string) {
    super(`Approval ${approvalId} is missing or no longer pending`);
    this.name = "ApprovalDecisionError";
  }
}

/** An approval ID was reused for a different run or subject. */
export class ApprovalIdentityConflictError extends Error {
  readonly approvalId: string;

  constructor(approvalId: string) {
    super(`Approval ID was reused for a different subject: ${approvalId}`);
    this.name = "ApprovalIdentityConflictError";
    this.approvalId = approvalId;
  }
}

export class ApprovalRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async request(input: {
    readonly id: string;
    readonly run_id: string;
    readonly subject_type: string;
    readonly subject_id: string;
    readonly requested_by: string;
  }): Promise<ApprovalRecord> {
    const inserted = await this.db
      .insertInto("questlab.approval")
      .values({
        ...input,
        status: "pending",
        decided_by: null,
        reason: null,
        decided_at: null,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      return inserted;
    }
    const existing = await this.db
      .selectFrom("questlab.approval")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirstOrThrow();
    // A replay must be the *same* request. Returning the stored row unchecked means an approval
    // granted for one subject can be replayed to authorize a different one, which is a decision
    // the human approver never made.
    if (
      existing.run_id !== input.run_id ||
      existing.subject_type !== input.subject_type ||
      existing.subject_id !== input.subject_id
    ) {
      throw new ApprovalIdentityConflictError(input.id);
    }
    return existing;
  }

  async approvePlan(
    approvalId: string,
    plan: ImprovementPlan,
    decidedBy: string,
    reason: string,
    now = new Date(),
  ): Promise<ApprovalRecord> {
    return this.db.transaction().execute(async (trx) => {
      const approval = await trx
        .updateTable("questlab.approval")
        .set({
          status: "approved",
          decided_by: decidedBy,
          reason,
          decided_at: now,
        })
        .where("id", "=", approvalId)
        .where("subject_type", "=", "ImprovementPlan")
        .where("subject_id", "=", plan.plan_id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!approval) {
        throw new ApprovalDecisionError(approvalId);
      }

      const updatedPlan = await trx
        .updateTable("questlab.improvement_plan")
        .set({
          status: "approved",
          payload: plan as unknown as JsonObject,
          updated_at: now,
        })
        .where("plan_id", "=", plan.plan_id)
        .where("status", "=", "proposed")
        .returning("plan_id")
        .executeTakeFirst();
      if (!updatedPlan) {
        throw new ApprovalDecisionError(approvalId);
      }
      return approval;
    });
  }

  async approveSubject(
    approvalId: string,
    subjectType: string,
    subjectId: string,
    decidedBy: string,
    reason: string,
    now = new Date(),
  ): Promise<ApprovalRecord> {
    const approval = await this.db
      .updateTable("questlab.approval")
      .set({
        status: "approved",
        decided_by: decidedBy,
        reason,
        decided_at: now,
      })
      .where("id", "=", approvalId)
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!approval) {
      throw new ApprovalDecisionError(approvalId);
    }
    return approval;
  }

  async findByRunId(runId: string): Promise<readonly ApprovalRecord[]> {
    return this.db
      .selectFrom("questlab.approval")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("requested_at", "asc")
      .execute();
  }
}
