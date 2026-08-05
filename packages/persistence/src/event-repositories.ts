import type { JsonObject } from "@firefly/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type { OutboxEventTable, QuestLabDatabase } from "./database.ts";

export type OutboxEventRecord = Selectable<OutboxEventTable>;

export class OutboxRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async claimBatch(
    dispatcherId: string,
    limit: number,
    leaseDurationMs: number,
    now = new Date(),
  ): Promise<readonly OutboxEventRecord[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("questlab.outbox_event")
        .select("event_id")
        .where("published_at", "is", null)
        .where("available_at", "<=", now)
        .where((expression) =>
          expression.or([
            expression("locked_by", "is", null),
            expression("locked_until", "<", now),
          ]),
        )
        .orderBy("available_at", "asc")
        .orderBy("created_at", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) {
        return [];
      }

      return trx
        .updateTable("questlab.outbox_event")
        .set({
          locked_by: dispatcherId,
          locked_until: new Date(now.getTime() + leaseDurationMs),
          attempts: sql<number>`attempts + 1`,
        })
        .where(
          "event_id",
          "in",
          rows.map((row) => row.event_id),
        )
        .returningAll()
        .execute();
    });
  }

  async markPublished(eventId: string, dispatcherId: string, now = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable("questlab.outbox_event")
      .set({
        published_at: now,
        locked_by: null,
        locked_until: null,
        last_error: null,
      })
      .where("event_id", "=", eventId)
      .where("locked_by", "=", dispatcherId)
      .where("published_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async releaseWithError(
    eventId: string,
    dispatcherId: string,
    error: string,
    retryAt: Date,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("questlab.outbox_event")
      .set({
        available_at: retryAt,
        locked_by: null,
        locked_until: null,
        last_error: error,
      })
      .where("event_id", "=", eventId)
      .where("locked_by", "=", dispatcherId)
      .where("published_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}

export class InboxRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async recordOnce(consumer: string, eventId: string, receivedAt = new Date()): Promise<boolean> {
    const inserted = await this.db
      .insertInto("questlab.inbox_receipt")
      .values({ consumer, event_id: eventId, received_at: receivedAt })
      .onConflict((conflict) => conflict.columns(["consumer", "event_id"]).doNothing())
      .returning("event_id")
      .executeTakeFirst();
    return Boolean(inserted);
  }
}

export interface EnqueueOutboxInput {
  readonly event_id: string;
  readonly event_type: string;
  readonly correlation_id: string;
  readonly causation_id?: string;
  readonly trace_id: string;
  readonly producer: string;
  readonly idempotency_key: string;
  readonly payload: JsonObject;
  readonly artifact_refs: readonly JsonObject[];
  readonly occurred_at: Date;
  readonly available_at?: Date;
}

export async function enqueueOutbox(
  db: Kysely<QuestLabDatabase>,
  input: EnqueueOutboxInput,
): Promise<void> {
  await db
    .insertInto("questlab.outbox_event")
    .values({
      ...input,
      artifact_refs: JSON.stringify(input.artifact_refs),
      schema_version: 1,
      causation_id: input.causation_id ?? null,
      available_at: input.available_at ?? input.occurred_at,
      attempts: 0,
      locked_by: null,
      locked_until: null,
      published_at: null,
      last_error: null,
    })
    .execute();
}
