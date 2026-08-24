import type {
  ChangeSet,
  ImprovementPlan,
  JsonObject,
  LearningEvent,
  LearningFinding,
  LearningOutcome,
  VerificationReport,
} from "@firefly/contracts";
import type { Kysely, Transaction } from "kysely";

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
  readonly causal_edges: readonly unknown[];
  readonly sentinel_incidents: readonly unknown[];
  readonly quarantines: readonly unknown[];
  readonly budget_usage?: unknown;
  readonly plugin_release?: unknown;
  readonly plugin_release_transitions: readonly unknown[];
  readonly sandbox_runs: readonly unknown[];
  readonly canary_evaluations: readonly unknown[];
  readonly active_plugin_version?: unknown;
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

  /**
   * Reads a whole run trace as one consistent snapshot.
   *
   * The 21 reads below used to run as independent statements, each seeing a different committed
   * state. A trace fetched while the run advanced could therefore show, for example, a released
   * plugin with no verification report — an audit record of a state that never existed. REPEATABLE
   * READ pins every read to a single snapshot; it is read-only, so it cannot conflict.
   */
  async getTrace(runId: string): Promise<EvolutionTrace | undefined> {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute((trx) => this.readTrace(trx, runId));
  }

  private async readTrace(
    db: Kysely<QuestLabDatabase> | Transaction<QuestLabDatabase>,
    runId: string,
  ): Promise<EvolutionTrace | undefined> {
    const run = await db
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
      causalEdges,
      sentinelIncidents,
      quarantines,
      budgetUsage,
      pluginRelease,
      pluginReleaseTransitions,
      sandboxRuns,
      canaryEvaluations,
      activePluginVersion,
    ] = await Promise.all([
      db.selectFrom("questlab.evolution_transition").selectAll().where("run_id", "=", runId).orderBy("to_version").execute(),
      db.selectFrom("questlab.workflow_task").selectAll().where("run_id", "=", runId).orderBy("created_at").execute(),
      db.selectFrom("questlab.approval").selectAll().where("run_id", "=", runId).orderBy("requested_at").execute(),
      db.selectFrom("questlab.learning_event").selectAll().where("run_id", "=", runId).orderBy("occurred_at").execute(),
      db.selectFrom("questlab.agent_result").selectAll().where("run_id", "=", runId).orderBy("completed_at").execute(),
      db.selectFrom("questlab.learning_finding").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db.selectFrom("questlab.improvement_plan").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db.selectFrom("questlab.change_set").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db.selectFrom("questlab.verification_report").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db.selectFrom("questlab.learning_outcome").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db
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
      db.selectFrom("questlab.causal_edge").selectAll().where("run_id", "=", runId).orderBy("created_at").execute(),
      db.selectFrom("questlab.sentinel_incident").selectAll().where("run_id", "=", runId).orderBy("first_seen_at").execute(),
      db.selectFrom("questlab.quarantine").selectAll().where("run_id", "=", runId).orderBy("created_at").execute(),
      db.selectFrom("questlab.run_budget_usage").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db.selectFrom("questlab.plugin_release").selectAll().where("run_id", "=", runId).executeTakeFirst(),
      db
        .selectFrom("questlab.plugin_release_transition")
        .innerJoin(
          "questlab.plugin_release",
          "questlab.plugin_release.release_id",
          "questlab.plugin_release_transition.release_id",
        )
        .selectAll("questlab.plugin_release_transition")
        .where("questlab.plugin_release.run_id", "=", runId)
        .orderBy("questlab.plugin_release_transition.to_version")
        .execute(),
      db
        .selectFrom("questlab.sandbox_run")
        .innerJoin(
          "questlab.plugin_release",
          "questlab.plugin_release.release_id",
          "questlab.sandbox_run.release_id",
        )
        .selectAll("questlab.sandbox_run")
        .where("questlab.plugin_release.run_id", "=", runId)
        .orderBy("questlab.sandbox_run.started_at")
        .execute(),
      db
        .selectFrom("questlab.canary_evaluation")
        .innerJoin(
          "questlab.plugin_release",
          "questlab.plugin_release.release_id",
          "questlab.canary_evaluation.release_id",
        )
        .selectAll("questlab.canary_evaluation")
        .where("questlab.plugin_release.run_id", "=", runId)
        .orderBy("questlab.canary_evaluation.evaluated_at")
        .execute(),
      db
        .selectFrom("questlab.plugin_release")
        .innerJoin(
          "questlab.plugin",
          "questlab.plugin.plugin_id",
          "questlab.plugin_release.plugin_id",
        )
        .innerJoin(
          "questlab.plugin_version",
          "questlab.plugin_version.version_id",
          "questlab.plugin.active_version_id",
        )
        .selectAll("questlab.plugin_version")
        .where("questlab.plugin_release.run_id", "=", runId)
        .executeTakeFirst(),
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
      causal_edges: causalEdges,
      sentinel_incidents: sentinelIncidents,
      quarantines,
      ...(budgetUsage ? { budget_usage: budgetUsage } : {}),
      ...(pluginRelease ? { plugin_release: pluginRelease } : {}),
      plugin_release_transitions: pluginReleaseTransitions,
      sandbox_runs: sandboxRuns,
      canary_evaluations: canaryEvaluations,
      ...(activePluginVersion ? { active_plugin_version: activePluginVersion } : {}),
    };
  }
}
