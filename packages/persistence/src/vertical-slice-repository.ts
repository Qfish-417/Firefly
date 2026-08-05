import type {
  ChangeSet,
  ImprovementPlan,
  JsonObject,
  LearningEvent,
  LearningFinding,
  LearningOutcome,
  VerificationReport,
} from "@firefly/contracts";
import type { Kysely } from "kysely";

import type { QuestLabDatabase } from "./database.ts";

export interface EvolutionTrace {
  readonly run: unknown;
  readonly transitions: readonly unknown[];
  readonly tasks: readonly unknown[];
  readonly approvals: readonly unknown[];
  readonly learning_events: readonly unknown[];
  readonly agent_results: readonly unknown[];
  readonly finding?: unknown;
  readonly plan?: unknown;
  readonly change_set?: unknown;
  readonly verification?: unknown;
  readonly outcome?: unknown;
  readonly artifacts: readonly unknown[];
}

export class VerticalSliceRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async recordLearningEvents(
    runId: string,
    events: readonly LearningEvent[],
    causationId: string,
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await this.db
      .insertInto("questlab.learning_event")
      .values(
        events.map((event) => ({
          event_id: event.event_id,
          run_id: runId,
          causation_id: causationId,
          payload: event as unknown as JsonObject,
          occurred_at: new Date(event.occurred_at),
        })),
      )
      .onConflict((conflict) => conflict.column("event_id").doNothing())
      .execute();
  }

  async recordFinding(runId: string, causationId: string, finding: LearningFinding): Promise<void> {
    await this.db
      .insertInto("questlab.learning_finding")
      .values({
        finding_id: finding.finding_id,
        run_id: runId,
        causation_id: causationId,
        payload: finding as unknown as JsonObject,
      })
      .onConflict((conflict) => conflict.column("finding_id").doNothing())
      .execute();
  }

  async recordPlan(runId: string, causationId: string, plan: ImprovementPlan): Promise<void> {
    await this.db
      .insertInto("questlab.improvement_plan")
      .values({
        plan_id: plan.plan_id,
        run_id: runId,
        finding_id: plan.finding_id,
        causation_id: causationId,
        status: plan.status,
        payload: plan as unknown as JsonObject,
      })
      .onConflict((conflict) => conflict.column("plan_id").doNothing())
      .execute();
  }

  async findPlanByRunId(runId: string): Promise<ImprovementPlan | undefined> {
    const row = await this.db
      .selectFrom("questlab.improvement_plan")
      .select("payload")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row?.payload as unknown as ImprovementPlan | undefined;
  }

  async recordChangeSet(runId: string, causationId: string, changeSet: ChangeSet): Promise<void> {
    await this.db
      .insertInto("questlab.change_set")
      .values({
        changeset_id: changeSet.changeset_id,
        run_id: runId,
        plan_id: changeSet.plan_id,
        causation_id: causationId,
        payload: changeSet as unknown as JsonObject,
      })
      .onConflict((conflict) => conflict.column("changeset_id").doNothing())
      .execute();
  }

  async recordVerification(
    runId: string,
    causationId: string,
    report: VerificationReport,
  ): Promise<void> {
    await this.db
      .insertInto("questlab.verification_report")
      .values({
        report_id: report.report_id,
        run_id: runId,
        changeset_id: report.changeset_id,
        causation_id: causationId,
        status: report.status,
        payload: report as unknown as JsonObject,
      })
      .onConflict((conflict) => conflict.column("report_id").doNothing())
      .execute();
  }

  async recordOutcome(runId: string, causationId: string, outcome: LearningOutcome): Promise<void> {
    await this.db
      .insertInto("questlab.learning_outcome")
      .values({
        outcome_id: outcome.outcome_id,
        run_id: runId,
        plan_id: outcome.plan_id,
        causation_id: causationId,
        decision: outcome.decision,
        payload: outcome as unknown as JsonObject,
      })
      .onConflict((conflict) => conflict.column("outcome_id").doNothing())
      .execute();
  }

  async getTrace(runId: string): Promise<EvolutionTrace | undefined> {
    const run = await this.db
      .selectFrom("questlab.evolution_run")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run) {
      return undefined;
    }

    const [
      transitions,
      tasks,
      approvals,
      learningEvents,
      agentResults,
      finding,
      plan,
      changeSet,
      verification,
      outcome,
      artifacts,
    ] = await Promise.all([
      this.db.selectFrom("questlab.evolution_transition").selectAll().where("run_id", "=", runId).orderBy("to_version").execute(),
      this.db.selectFrom("questlab.workflow_task").selectAll().where("run_id", "=", runId).orderBy("created_at").execute(),
      this.db.selectFrom("questlab.approval").selectAll().where("run_id", "=", runId).orderBy("requested_at").execute(),
      this.db.selectFrom("questlab.learning_event").selectAll().where("run_id", "=", runId).orderBy("occurred_at").execute(),
      this.db.selectFrom("questlab.agent_result").selectAll().where("run_id", "=", runId).orderBy("completed_at").execute(),
      this.db.selectFrom("questlab.learning_finding").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      this.db.selectFrom("questlab.improvement_plan").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      this.db.selectFrom("questlab.change_set").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      this.db.selectFrom("questlab.verification_report").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      this.db.selectFrom("questlab.learning_outcome").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      this.db
        .selectFrom("questlab.artifact")
        .selectAll()
        .where((expression) =>
          expression.or([
            expression("metadata", "@>", { run_id: runId }),
            expression("owner_id", "=", runId),
          ]),
        )
        .orderBy("created_at")
        .execute(),
    ]);

    return {
      run,
      transitions,
      tasks,
      approvals,
      learning_events: learningEvents,
      agent_results: agentResults,
      ...(finding ? { finding } : {}),
      ...(plan ? { plan } : {}),
      ...(changeSet ? { change_set: changeSet } : {}),
      ...(verification ? { verification } : {}),
      ...(outcome ? { outcome } : {}),
      artifacts,
    };
  }
}
