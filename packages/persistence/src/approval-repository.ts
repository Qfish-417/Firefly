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
    return this.db
      .selectFrom("questlab.approval")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirstOrThrow();
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

  async findByRunId(runId: string): Promise<readonly ApprovalRecord[]> {
    return this.db
      .selectFrom("questlab.approval")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("requested_at", "asc")
      .execute();
  }
}
