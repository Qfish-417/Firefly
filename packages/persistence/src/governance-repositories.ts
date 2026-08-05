import type { JsonObject } from "@firefly/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type {
  CausalEdgeTable,
  QuestLabDatabase,
  QuarantineTable,
  RunBudgetUsageTable,
  SentinelIncidentTable,
  SentinelObservationTable,
} from "./database.ts";

export type CausalEdgeRecord = Selectable<CausalEdgeTable>;
export type RunBudgetUsageRecord = Selectable<RunBudgetUsageTable>;
export type SentinelIncidentRecord = Selectable<SentinelIncidentTable>;
export type QuarantineRecord = Selectable<QuarantineTable>;

export class CausalCycleError extends Error {
  readonly runId: string;
  readonly parentNodeId: string;
  readonly childNodeId: string;

  constructor(runId: string, parentNodeId: string, childNodeId: string) {
    super(`Causal edge ${parentNodeId} -> ${childNodeId} creates a cycle in ${runId}`);
    this.name = "CausalCycleError";
    this.runId = runId;
    this.parentNodeId = parentNodeId;
    this.childNodeId = childNodeId;
  }
}

export class CausalGraphRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async addEdge(input: {
    readonly run_id: string;
    readonly parent_node_id: string;
    readonly child_node_id: string;
    readonly edge_type: CausalEdgeTable["edge_type"];
  }): Promise<CausalEdgeRecord> {
    if (input.parent_node_id === input.child_node_id) {
      throw new CausalCycleError(input.run_id, input.parent_node_id, input.child_node_id);
    }
    return this.db.transaction().execute(async (trx) => {
      // Serialize graph mutations per Run so concurrent opposite edges cannot both pass cycle checks.
      await trx
        .selectFrom("questlab.evolution_run")
        .select("id")
        .where("id", "=", input.run_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const cycleCheck = await sql<{ readonly creates_cycle: boolean }>`
        WITH RECURSIVE descendants(node_id) AS (
          SELECT child_node_id
          FROM questlab.causal_edge
          WHERE run_id = ${input.run_id} AND parent_node_id = ${input.child_node_id}
          UNION
          SELECT edge.child_node_id
          FROM questlab.causal_edge AS edge
          JOIN descendants ON edge.parent_node_id = descendants.node_id
          WHERE edge.run_id = ${input.run_id}
        )
        SELECT EXISTS (
          SELECT 1 FROM descendants WHERE node_id = ${input.parent_node_id}
        ) AS creates_cycle
      `.execute(trx);
      if (cycleCheck.rows[0]?.creates_cycle) {
        throw new CausalCycleError(input.run_id, input.parent_node_id, input.child_node_id);
      }

      const inserted = await trx
        .insertInto("questlab.causal_edge")
        .values(input)
        .onConflict((conflict) =>
          conflict
            .columns(["run_id", "parent_node_id", "child_node_id", "edge_type"])
            .doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        return inserted;
      }
      return trx
        .selectFrom("questlab.causal_edge")
        .selectAll()
        .where("run_id", "=", input.run_id)
        .where("parent_node_id", "=", input.parent_node_id)
        .where("child_node_id", "=", input.child_node_id)
        .where("edge_type", "=", input.edge_type)
        .executeTakeFirstOrThrow();
    });
  }

  async listByRunId(runId: string): Promise<readonly CausalEdgeRecord[]> {
    return this.db
      .selectFrom("questlab.causal_edge")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute();
  }
}

export interface ReportIncidentInput {
  readonly incident_id: string;
  readonly run_id: string;
  readonly incident_type: SentinelIncidentTable["incident_type"];
  readonly severity: SentinelIncidentTable["severity"];
  readonly fingerprint: string;
  readonly action: SentinelIncidentTable["action"];
  readonly details: JsonObject;
  readonly observed_at: Date;
}

export class SentinelRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async reportIncident(input: ReportIncidentInput): Promise<SentinelIncidentRecord> {
    return this.db
      .insertInto("questlab.sentinel_incident")
      .values({
        incident_id: input.incident_id,
        run_id: input.run_id,
        incident_type: input.incident_type,
        severity: input.severity,
        fingerprint: input.fingerprint,
        status: "open",
        action: input.action,
        details: input.details,
        first_seen_at: input.observed_at,
        last_seen_at: input.observed_at,
      })
      .onConflict((conflict) =>
        conflict
          .column("incident_id")
          .doUpdateSet({
            last_seen_at: input.observed_at,
            occurrence_count: sql<number>`"sentinel_incident"."occurrence_count" + 1`,
            details: input.details,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async recordObservation(input: {
    readonly observation_id: string;
    readonly run_id: string;
    readonly signal_type: string;
    readonly fingerprint: string;
    readonly observed_at: Date;
    readonly window_started_at: Date;
  }): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("questlab.sentinel_observation")
        .values({
          observation_id: input.observation_id,
          run_id: input.run_id,
          signal_type: input.signal_type,
          fingerprint: input.fingerprint,
          observed_at: input.observed_at,
        })
        .onConflict((conflict) => conflict.column("observation_id").doNothing())
        .execute();
      const row = await trx
        .selectFrom("questlab.sentinel_observation")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("run_id", "=", input.run_id)
        .where("signal_type", "=", input.signal_type)
        .where("fingerprint", "=", input.fingerprint)
        .where("observed_at", ">=", input.window_started_at)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    });
  }

  async quarantine(input: {
    readonly quarantine_id: string;
    readonly run_id: string;
    readonly subject_type: QuarantineTable["subject_type"];
    readonly subject_id: string;
    readonly incident_id: string;
    readonly reason: string;
  }): Promise<QuarantineRecord> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("questlab.quarantine")
        .selectAll()
        .where("run_id", "=", input.run_id)
        .where("subject_type", "=", input.subject_type)
        .where("subject_id", "=", input.subject_id)
        .where("active", "=", true)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        return existing;
      }
      return trx
        .insertInto("questlab.quarantine")
        .values({ ...input, active: true, released_at: null, released_by: null })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async isQuarantined(
    runId: string,
    subjectType: QuarantineTable["subject_type"],
    subjectId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("questlab.quarantine")
      .select("quarantine_id")
      .where("run_id", "=", runId)
      .where("subject_type", "=", subjectType)
      .where("subject_id", "=", subjectId)
      .where("active", "=", true)
      .executeTakeFirst();
    return Boolean(row);
  }

  async listIncidents(runId: string): Promise<readonly SentinelIncidentRecord[]> {
    return this.db
      .selectFrom("questlab.sentinel_incident")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("first_seen_at", "asc")
      .execute();
  }

  async getBudgetUsage(runId: string): Promise<RunBudgetUsageRecord | undefined> {
    return this.db
      .selectFrom("questlab.run_budget_usage")
      .selectAll()
      .where("run_id", "=", runId)
      .executeTakeFirst();
  }
}
