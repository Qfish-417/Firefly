import { isDeepStrictEqual } from "node:util";

import type { JsonObject } from "@firefly/contracts";
import { type Kysely, type Selectable } from "kysely";

import type { MaintenanceCycleTable, QuestLabDatabase } from "./database.ts";

export type MaintenanceCycle = Selectable<MaintenanceCycleTable>;

export interface RecordMaintenanceCycleInput {
  readonly cycle_id: string;
  readonly cycle_kind: MaintenanceCycleTable["cycle_kind"];
  readonly worker_id: string;
  readonly instance_id: string;
  readonly status: MaintenanceCycleTable["status"];
  readonly started_at: Date;
  readonly completed_at: Date;
  readonly payload: JsonObject;
  readonly error?: JsonObject;
}

export interface ListMaintenanceCyclesInput {
  readonly cycle_kind?: MaintenanceCycleTable["cycle_kind"];
  readonly limit?: number;
}

export class MaintenanceCycleIdentityConflictError extends Error {
  readonly cycleId: string;

  constructor(cycleId: string) {
    super(`Maintenance cycle ID was reused with different immutable content: ${cycleId}`);
    this.name = "MaintenanceCycleIdentityConflictError";
    this.cycleId = cycleId;
  }
}

export class MaintenanceCyclePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceCyclePolicyError";
  }
}

export class MaintenanceCycleRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async record(input: RecordMaintenanceCycleInput): Promise<MaintenanceCycle> {
    validateRecord(input);
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("questlab.maintenance_cycle")
        .selectAll()
        .where("cycle_id", "=", input.cycle_id)
        .forUpdate()
        .executeTakeFirst();
      const expectedError = input.error ?? null;
      if (existing) {
        if (
          existing.cycle_kind !== input.cycle_kind ||
          existing.worker_id !== input.worker_id ||
          existing.instance_id !== input.instance_id ||
          existing.status !== input.status ||
          existing.started_at.getTime() !== input.started_at.getTime() ||
          existing.completed_at.getTime() !== input.completed_at.getTime() ||
          !isDeepStrictEqual(existing.payload, input.payload) ||
          !isDeepStrictEqual(existing.error, expectedError)
        ) {
          throw new MaintenanceCycleIdentityConflictError(input.cycle_id);
        }
        return existing;
      }
      return trx
        .insertInto("questlab.maintenance_cycle")
        .values({
          cycle_id: input.cycle_id,
          cycle_kind: input.cycle_kind,
          worker_id: input.worker_id,
          instance_id: input.instance_id,
          status: input.status,
          started_at: input.started_at,
          completed_at: input.completed_at,
          payload: input.payload,
          error: expectedError,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async get(cycleId: string): Promise<MaintenanceCycle | undefined> {
    if (!cycleId.trim()) throw new MaintenanceCyclePolicyError("Maintenance cycle ID is required");
    return this.db
      .selectFrom("questlab.maintenance_cycle")
      .selectAll()
      .where("cycle_id", "=", cycleId)
      .executeTakeFirst();
  }

  async list(input: ListMaintenanceCyclesInput = {}): Promise<readonly MaintenanceCycle[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new MaintenanceCyclePolicyError("Maintenance cycle list limit must be between 1 and 1000");
    }
    let query = this.db
      .selectFrom("questlab.maintenance_cycle")
      .selectAll()
      .orderBy("started_at", "desc")
      .orderBy("cycle_id", "desc")
      .limit(limit);
    if (input.cycle_kind) query = query.where("cycle_kind", "=", input.cycle_kind);
    return query.execute();
  }
}

function validateRecord(input: RecordMaintenanceCycleInput): void {
  if (!input.cycle_id.trim() || !input.worker_id.trim() || !input.instance_id.trim()) {
    throw new MaintenanceCyclePolicyError("Maintenance cycle identity is required");
  }
  if (input.completed_at.getTime() < input.started_at.getTime()) {
    throw new MaintenanceCyclePolicyError("Maintenance cycle completion cannot precede start");
  }
}
