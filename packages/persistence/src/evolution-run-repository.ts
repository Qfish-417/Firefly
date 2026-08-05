import type { JsonObject } from "@firefly/contracts";
import {
  transitionEvolutionRun,
  type EvolutionRunEvent,
  type EvolutionRunState,
  type TransitionCommand,
} from "@firefly/learning-domain";
import type { Kysely } from "kysely";

import type { QuestLabDatabase } from "./database.ts";

export interface EvolutionRunRecord {
  readonly id: string;
  readonly correlation_id: string;
  readonly state: EvolutionRunState;
  readonly version: number;
  readonly goal: JsonObject;
  readonly budget: JsonObject;
  readonly risk_level: "low" | "medium" | "high";
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateEvolutionRunInput {
  readonly id: string;
  readonly correlation_id: string;
  readonly goal: JsonObject;
  readonly budget: JsonObject;
  readonly risk_level: "low" | "medium" | "high";
}

export interface PersistedTransitionCommand extends TransitionCommand<EvolutionRunEvent> {
  readonly trace_id: string;
  readonly producer: string;
  readonly occurred_at: Date;
}

export interface PersistedTransitionResult {
  readonly run: EvolutionRunRecord;
  readonly changed: boolean;
}

export class EvolutionEventCollisionError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Evolution event ${eventId} is already associated with another run`);
    this.name = "EvolutionEventCollisionError";
    this.eventId = eventId;
  }
}

export class EvolutionRunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Evolution run not found: ${runId}`);
    this.name = "EvolutionRunNotFoundError";
    this.runId = runId;
  }
}

export class EvolutionRunRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async create(input: CreateEvolutionRunInput): Promise<EvolutionRunRecord> {
    return this.db
      .insertInto("questlab.evolution_run")
      .values({
        ...input,
        state: "observed",
        version: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(runId: string): Promise<EvolutionRunRecord | undefined> {
    return this.db
      .selectFrom("questlab.evolution_run")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();
  }

  async transition(
    runId: string,
    command: PersistedTransitionCommand,
  ): Promise<PersistedTransitionResult> {
    return this.db.transaction().execute(async (trx) => {
      const replay = await trx
        .selectFrom("questlab.evolution_transition")
        .select(["run_id"])
        .where("event_id", "=", command.event_id)
        .executeTakeFirst();

      if (replay) {
        if (replay.run_id !== runId) {
          throw new EvolutionEventCollisionError(command.event_id);
        }

        const run = await trx
          .selectFrom("questlab.evolution_run")
          .selectAll()
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
        return { run, changed: false };
      }

      const current = await trx
        .selectFrom("questlab.evolution_run")
        .selectAll()
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        throw new EvolutionRunNotFoundError(runId);
      }

      const transition = transitionEvolutionRun(
        {
          state: current.state,
          version: current.version,
          applied_event_ids: [],
        },
        command,
      );

      const updated = await trx
        .updateTable("questlab.evolution_run")
        .set({
          state: transition.aggregate.state,
          version: transition.aggregate.version,
          updated_at: command.occurred_at,
        })
        .where("id", "=", runId)
        .where("version", "=", current.version)
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("questlab.evolution_transition")
        .values({
          event_id: command.event_id,
          run_id: runId,
          event_type: command.event,
          from_state: current.state,
          to_state: updated.state,
          from_version: current.version,
          to_version: updated.version,
          occurred_at: command.occurred_at,
        })
        .execute();

      await trx
        .insertInto("questlab.outbox_event")
        .values({
          event_id: `outbox.${command.event_id}`,
          event_type: "EvolutionRunTransitioned",
          schema_version: 1,
          correlation_id: current.correlation_id,
          causation_id: command.event_id,
          trace_id: command.trace_id,
          producer: command.producer,
          idempotency_key: `evolution-transition:${command.event_id}`,
          payload: {
            run_id: runId,
            transition_event: command.event,
            from_state: current.state,
            to_state: updated.state,
            version: updated.version,
          },
          artifact_refs: "[]",
          occurred_at: command.occurred_at,
          available_at: command.occurred_at,
          attempts: 0,
          locked_by: null,
          locked_until: null,
          published_at: null,
          last_error: null,
        })
        .execute();

      return { run: updated, changed: true };
    });
  }
}
