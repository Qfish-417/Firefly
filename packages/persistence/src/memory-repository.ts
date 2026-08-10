import {
  assertContract,
  type DeletionPropagationAck,
  type DeletionPropagationTarget,
  type DeletionPropagationTask,
  type JsonObject,
} from "@firefly/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type {
  MemoryDeletionReceiptTable,
  MemoryDeletionTargetTable,
  MemoryAclTable,
  MemoryRecordTable,
  QuestLabDatabase,
  StructuredEventTable,
} from "./database.ts";
import { enqueueOutbox } from "./event-repositories.ts";

export type MemoryRecord = Selectable<MemoryRecordTable>;
export type StructuredEvent = Selectable<StructuredEventTable>;
export type MemoryDeletionReceipt = Selectable<MemoryDeletionReceiptTable>;
export type MemoryDeletionTarget = Selectable<MemoryDeletionTargetTable>;

export interface MemoryPrincipal {
  readonly tenant_id: string;
  readonly user_id?: string;
  readonly agent_id?: string;
  readonly session_id?: string;
  readonly role_ids?: readonly string[];
}

export interface CaptureMemoryInput {
  readonly memory_id: string;
  readonly tenant_id: string;
  readonly owner_type: MemoryRecordTable["owner_type"];
  readonly owner_id: string;
  readonly scope: MemoryRecordTable["scope"];
  readonly stage: MemoryRecordTable["stage"];
  readonly kind: string;
  readonly content_digest: string;
  readonly source_refs?: readonly JsonObject[];
  readonly metadata?: JsonObject;
  readonly confidence: number;
  readonly sensitivity: MemoryRecordTable["sensitivity"];
  readonly status?: MemoryRecordTable["status"];
  readonly valid_from?: Date;
  readonly valid_to?: Date;
}

export interface EventQuery {
  readonly subject_id?: string;
  readonly event_type?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly include_conflicts?: boolean;
}

export interface EventAggregate {
  readonly operation: "count_distinct";
  readonly field: "dedupe_key";
  readonly value: number;
  readonly included_event_ids: readonly string[];
  readonly excluded_conflict_count: number;
}

export interface DeleteMemoryInput {
  readonly deletion_id: string;
  readonly memory_id: string;
  readonly principal: MemoryPrincipal;
  readonly requested_by: string;
  readonly reason: string;
  readonly propagation_targets: readonly DeletionPropagationTarget[];
  readonly occurred_at?: Date;
}

export interface MemoryDeletionStatus {
  readonly receipt: MemoryDeletionReceipt;
  readonly targets: readonly MemoryDeletionTarget[];
}

export class MemoryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPolicyError";
  }
}

export class MemoryIdentityConflictError extends Error {
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(`Memory ID was reused for different immutable content: ${memoryId}`);
    this.name = "MemoryIdentityConflictError";
    this.memoryId = memoryId;
  }
}

export class MemoryRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async capture(input: CaptureMemoryInput): Promise<MemoryRecord> {
    const row = {
      memory_id: input.memory_id,
      tenant_id: input.tenant_id,
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      scope: input.scope,
      stage: input.stage,
      kind: input.kind,
      content_digest: input.content_digest,
      source_refs: JSON.stringify(input.source_refs ?? []),
      metadata: input.metadata ?? {},
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      status: input.status ?? "captured",
      valid_from: input.valid_from ?? null,
      valid_to: input.valid_to ?? null,
      version: 1,
      deleted_at: null,
    };
    const inserted = await this.db
      .insertInto("questlab.memory_record")
      .values(row)
      .onConflict((conflict) => conflict.column("memory_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    const existing = await this.db
      .selectFrom("questlab.memory_record")
      .selectAll()
      .where("memory_id", "=", input.memory_id)
      .executeTakeFirstOrThrow();
    if (
      existing.content_digest !== input.content_digest ||
      existing.tenant_id !== input.tenant_id ||
      existing.scope !== input.scope ||
      existing.owner_id !== input.owner_id
    ) {
      throw new MemoryIdentityConflictError(input.memory_id);
    }
    return existing;
  }

  async grant(
    memoryId: string,
    principal: { readonly type: MemoryAclTable["principal_type"]; readonly id: string },
    permission: MemoryAclTable["permission"] = "read",
  ): Promise<void> {
    await this.db
      .insertInto("questlab.memory_acl")
      .values({
        memory_id: memoryId,
        principal_type: principal.type,
        principal_id: principal.id,
        permission,
      })
      .onConflict((conflict) =>
        conflict.columns(["memory_id", "principal_type", "principal_id", "permission"]).doNothing(),
      )
      .execute();
  }

  async listReadable(
    principal: MemoryPrincipal,
    options: { readonly scopes?: readonly MemoryRecordTable["scope"][]; readonly limit?: number } = {},
  ): Promise<readonly MemoryRecord[]> {
    const scopes = options.scopes ?? ["public", "tenant", "agent_private", "user_private", "session"];
    const identities = [
      principal.user_id ? { type: "user" as const, id: principal.user_id } : undefined,
      principal.agent_id ? { type: "agent" as const, id: principal.agent_id } : undefined,
      principal.session_id ? { type: "session" as const, id: principal.session_id } : undefined,
      ...((principal.role_ids ?? []).map((id) => ({ type: "role" as const, id }))),
      { type: "tenant" as const, id: principal.tenant_id },
    ].filter((value): value is { type: "user" | "agent" | "session" | "role" | "tenant"; id: string } => Boolean(value));
    const rows = await this.db
      .selectFrom("questlab.memory_record as memory")
      .selectAll("memory")
      .where((expression) =>
        expression.or([
          expression("memory.scope", "=", "public"),
          expression("memory.tenant_id", "=", principal.tenant_id),
        ]),
      )
      .where("memory.status", "=", "active")
      .where("memory.scope", "in", scopes)
      .where((expression) =>
        expression.or([
          expression("memory.scope", "=", "public"),
          expression.and([
            expression("memory.scope", "=", "tenant"),
            expression("memory.owner_id", "=", principal.tenant_id),
          ]),
          ...(principal.user_id
            ? [expression.and([expression("memory.scope", "=", "user_private"), expression("memory.owner_id", "=", principal.user_id)])]
            : []),
          ...(principal.agent_id
            ? [expression.and([expression("memory.scope", "=", "agent_private"), expression("memory.owner_id", "=", principal.agent_id)])]
            : []),
          ...(principal.session_id
            ? [expression.and([expression("memory.scope", "=", "session"), expression("memory.owner_id", "=", principal.session_id)])]
            : []),
          expression.exists(
            expression
              .selectFrom("questlab.memory_acl as acl")
              .select("acl.memory_id")
              .whereRef("acl.memory_id", "=", "memory.memory_id")
              .where("acl.permission", "=", "read")
              .where((aclExpression) =>
                aclExpression.or(
                  identities.map((identity) =>
                    aclExpression.and([
                      aclExpression("acl.principal_type", "=", identity.type),
                      aclExpression("acl.principal_id", "=", identity.id),
                    ]),
                  ),
                ),
              ),
          ),
        ]),
      )
      .orderBy("memory.created_at", "desc")
      .limit(options.limit ?? 100)
      .execute();
    return rows;
  }

  async recordEvent(input: {
    readonly event_id: string;
    readonly tenant_id: string;
    readonly subject_id: string;
    readonly event_type: string;
    readonly object: JsonObject;
    readonly scope: StructuredEventTable["scope"];
    readonly owner_id: string;
    readonly occurred_from: Date;
    readonly occurred_to?: Date;
    readonly dedupe_key: string;
    readonly source_memory_ids: readonly string[];
    readonly confidence: number;
    readonly conflict_status?: StructuredEventTable["conflict_status"];
  }): Promise<StructuredEvent> {
    await this.assertEventVisibility(input);
    const inserted = await this.db
      .insertInto("questlab.structured_event")
      .values({
        ...input,
        object: input.object,
        occurred_to: input.occurred_to ?? null,
        source_memory_ids: JSON.stringify(input.source_memory_ids),
        conflict_status: input.conflict_status ?? "none",
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    return this.db
      .selectFrom("questlab.structured_event")
      .selectAll()
      .where("event_id", "=", input.event_id)
      .executeTakeFirstOrThrow();
  }

  async deleteMemory(input: DeleteMemoryInput): Promise<MemoryDeletionReceipt> {
    if (new Set(input.propagation_targets).size !== input.propagation_targets.length) {
      throw new MemoryPolicyError("Deletion propagation targets must be unique");
    }
    return this.db.transaction().execute(async (trx) => {
      const memory = await trx
        .selectFrom("questlab.memory_record")
        .selectAll()
        .where("memory_id", "=", input.memory_id)
        .forUpdate()
        .executeTakeFirst();
      if (!memory) throw new MemoryPolicyError(`Memory does not exist: ${input.memory_id}`);
      if (!(await canDeleteMemory(trx, memory, input.principal))) {
        throw new MemoryPolicyError("Principal is not authorized to delete this memory");
      }

      const priorReceipt = await trx
        .selectFrom("questlab.memory_deletion_receipt")
        .selectAll()
        .where("memory_id", "=", input.memory_id)
        .executeTakeFirst();
      if (priorReceipt) {
        const existingTargets = await trx
          .selectFrom("questlab.memory_deletion_target")
          .select("target")
          .where("deletion_id", "=", priorReceipt.deletion_id)
          .orderBy("target")
          .execute();
        const requestedTargets = [...input.propagation_targets].sort();
        if (!sameStrings(existingTargets.map((row) => row.target), requestedTargets)) {
          throw new MemoryPolicyError("Deletion replay changed its propagation target set");
        }
        return priorReceipt;
      }

      const occurredAt = input.occurred_at ?? new Date();
      const removedChunks = await trx
        .deleteFrom("questlab.memory_chunk")
        .where("memory_id", "=", input.memory_id)
        .executeTakeFirst();
      const invalidatedEvents = await trx
        .deleteFrom("questlab.structured_event")
        .where(sql<boolean>`source_memory_ids @> ${JSON.stringify([input.memory_id])}::jsonb`)
        .executeTakeFirst();
      await trx
        .updateTable("questlab.memory_record")
        .set({
          status: "deleted",
          deleted_at: occurredAt,
          updated_at: occurredAt,
          version: sql<number>`version + 1`,
        })
        .where("memory_id", "=", input.memory_id)
        .executeTakeFirstOrThrow();

      const receipt = await trx
        .insertInto("questlab.memory_deletion_receipt")
        .values({
          deletion_id: input.deletion_id,
          memory_id: input.memory_id,
          tenant_id: memory.tenant_id,
          requested_by: input.requested_by,
          reason: input.reason,
          removed_chunk_count: Number(removedChunks.numDeletedRows),
          invalidated_event_count: Number(invalidatedEvents.numDeletedRows),
          completed_at: occurredAt,
          propagation_status: input.propagation_targets.length > 0 ? "pending" : "completed",
          propagation_completed_at: input.propagation_targets.length > 0 ? null : occurredAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const target of input.propagation_targets) {
        const task: DeletionPropagationTask = {
          schema_version: 1,
          deletion_id: input.deletion_id,
          memory_id: input.memory_id,
          tenant_id: memory.tenant_id,
          target,
          content_digest: memory.content_digest as `sha256:${string}`,
          requested_at: occurredAt.toISOString(),
        };
        assertContract("DeletionPropagationTask", task);
        await trx
          .insertInto("questlab.memory_deletion_target")
          .values({
            deletion_id: input.deletion_id,
            target,
            status: "pending",
            attempt: 0,
            ack_id: null,
            evidence_refs: JSON.stringify([]),
            last_error: null,
            updated_at: occurredAt,
            acknowledged_at: null,
          })
          .execute();
        await enqueueOutbox(trx, {
          event_id: `event.memory-deletion-propagation.${input.deletion_id}.${target}`,
          event_type: "MemoryDeletionPropagationRequested",
          correlation_id: input.deletion_id,
          trace_id: input.deletion_id,
          producer: "memory-repository",
          idempotency_key: `memory-delete-propagate:${input.deletion_id}:${target}`,
          occurred_at: occurredAt,
          payload: task as unknown as JsonObject,
          artifact_refs: [],
        });
      }
      await enqueueOutbox(trx, {
        event_id: `event.memory-deleted.${input.deletion_id}`,
        event_type: "MemoryDeleted",
        correlation_id: input.deletion_id,
        trace_id: input.deletion_id,
        producer: "memory-repository",
        idempotency_key: `memory-delete:${input.memory_id}`,
        occurred_at: occurredAt,
        payload: {
          deletion_id: input.deletion_id,
          memory_id: input.memory_id,
          tenant_id: memory.tenant_id,
          content_digest: memory.content_digest,
          removed_chunk_count: receipt.removed_chunk_count,
          invalidated_event_count: receipt.invalidated_event_count,
        },
        artifact_refs: [],
      });
      return receipt;
    });
  }

  async acknowledgeDeletion(ack: DeletionPropagationAck): Promise<MemoryDeletionStatus> {
    assertContract("DeletionPropagationAck", ack);
    return this.db.transaction().execute(async (trx) => {
      const receipt = await trx
        .selectFrom("questlab.memory_deletion_receipt")
        .selectAll()
        .where("deletion_id", "=", ack.deletion_id)
        .forUpdate()
        .executeTakeFirst();
      if (!receipt) throw new MemoryPolicyError(`Deletion does not exist: ${ack.deletion_id}`);
      const target = await trx
        .selectFrom("questlab.memory_deletion_target")
        .selectAll()
        .where("deletion_id", "=", ack.deletion_id)
        .where("target", "=", ack.target)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new MemoryPolicyError(`Deletion target was not requested: ${ack.target}`);

      if (target.ack_id === ack.ack_id) {
        if (!sameDeletionAck(target, ack)) {
          throw new MemoryPolicyError("Deletion acknowledgement ID was reused with different content");
        }
        return this.getDeletionStatusWith(trx, ack.deletion_id);
      }
      if (target.status === "completed") {
        throw new MemoryPolicyError("A completed deletion target cannot accept a different acknowledgement");
      }
      if (ack.attempt <= target.attempt) {
        throw new MemoryPolicyError("Deletion acknowledgement attempt must increase monotonically");
      }

      const occurredAt = new Date(ack.occurred_at);
      await trx
        .updateTable("questlab.memory_deletion_target")
        .set({
          status: ack.status,
          attempt: ack.attempt,
          ack_id: ack.ack_id,
          evidence_refs: JSON.stringify(ack.evidence_refs),
          last_error: ack.error ? (ack.error as JsonObject) : null,
          updated_at: occurredAt,
          acknowledged_at: occurredAt,
        })
        .where("deletion_id", "=", ack.deletion_id)
        .where("target", "=", ack.target)
        .executeTakeFirstOrThrow();

      const targets = await trx
        .selectFrom("questlab.memory_deletion_target")
        .selectAll()
        .where("deletion_id", "=", ack.deletion_id)
        .orderBy("target")
        .execute();
      const propagationStatus = targets.some((item) => item.status === "failed")
        ? "failed"
        : targets.some((item) => item.status === "pending")
          ? "pending"
          : "completed";
      await trx
        .updateTable("questlab.memory_deletion_receipt")
        .set({
          propagation_status: propagationStatus,
          propagation_completed_at: propagationStatus === "completed" ? occurredAt : null,
        })
        .where("deletion_id", "=", ack.deletion_id)
        .executeTakeFirstOrThrow();
      await enqueueOutbox(trx, {
        event_id: `event.memory-deletion-ack.${ack.ack_id}`,
        event_type: "MemoryDeletionPropagationAcknowledged",
        correlation_id: ack.deletion_id,
        trace_id: ack.deletion_id,
        producer: "memory-repository",
        idempotency_key: `memory-delete-ack:${ack.ack_id}`,
        occurred_at: occurredAt,
        payload: ack as unknown as JsonObject,
        artifact_refs: ack.evidence_refs as unknown as readonly JsonObject[],
      });
      if (propagationStatus === "completed") {
        await enqueueOutbox(trx, {
          event_id: `event.memory-deletion-completed.${ack.deletion_id}`,
          event_type: "MemoryDeletionPropagationCompleted",
          correlation_id: ack.deletion_id,
          trace_id: ack.deletion_id,
          producer: "memory-repository",
          idempotency_key: `memory-delete-complete:${ack.deletion_id}`,
          occurred_at: occurredAt,
          payload: {
            deletion_id: ack.deletion_id,
            memory_id: receipt.memory_id,
            tenant_id: receipt.tenant_id,
            propagation_completed_at: occurredAt.toISOString(),
          },
          artifact_refs: [],
        });
      }
      return this.getDeletionStatusWith(trx, ack.deletion_id);
    });
  }

  async getDeletionStatus(deletionId: string): Promise<MemoryDeletionStatus | undefined> {
    const receipt = await this.db
      .selectFrom("questlab.memory_deletion_receipt")
      .selectAll()
      .where("deletion_id", "=", deletionId)
      .executeTakeFirst();
    if (!receipt) return undefined;
    const targets = await this.db
      .selectFrom("questlab.memory_deletion_target")
      .selectAll()
      .where("deletion_id", "=", deletionId)
      .orderBy("target")
      .execute();
    return { receipt, targets };
  }

  private async getDeletionStatusWith(
    db: Kysely<QuestLabDatabase>,
    deletionId: string,
  ): Promise<MemoryDeletionStatus> {
    const receipt = await db
      .selectFrom("questlab.memory_deletion_receipt")
      .selectAll()
      .where("deletion_id", "=", deletionId)
      .executeTakeFirstOrThrow();
    const targets = await db
      .selectFrom("questlab.memory_deletion_target")
      .selectAll()
      .where("deletion_id", "=", deletionId)
      .orderBy("target")
      .execute();
    return { receipt, targets };
  }

  private async assertEventVisibility(input: {
    readonly tenant_id: string;
    readonly scope: StructuredEventTable["scope"];
    readonly owner_id: string;
    readonly source_memory_ids: readonly string[];
  }): Promise<void> {
    if (input.source_memory_ids.length === 0) {
      throw new MemoryPolicyError("Structured events must retain at least one source memory");
    }
    const sources = await this.db
      .selectFrom("questlab.memory_record")
      .select(["memory_id", "tenant_id", "scope", "owner_id", "status"])
      .where("memory_id", "in", input.source_memory_ids)
      .execute();
    if (
      new Set(input.source_memory_ids).size !== input.source_memory_ids.length ||
      sources.length !== input.source_memory_ids.length
    ) {
      throw new MemoryPolicyError("Structured event references a missing source memory");
    }
    for (const source of sources) {
      if ((source.scope !== "public" && source.tenant_id !== input.tenant_id) || source.status === "deleted") {
        throw new MemoryPolicyError("Structured event source crosses tenant or deletion boundary");
      }
      const allowed =
        input.scope === "public"
          ? source.scope === "public"
          : input.scope === "tenant"
            ? source.scope === "public" || (source.scope === "tenant" && source.owner_id === input.owner_id)
            : input.scope === "user_private"
              ? source.scope === "public" ||
                (source.scope === "tenant" && source.tenant_id === input.tenant_id) ||
                (source.scope === "user_private" && source.owner_id === input.owner_id)
              : input.scope === "agent_private"
                ? source.scope === "public" ||
                  (source.scope === "tenant" && source.tenant_id === input.tenant_id) ||
                  (source.scope === "agent_private" && source.owner_id === input.owner_id)
                : source.scope === "public" ||
                  (source.scope === "session" && source.owner_id === input.owner_id);
      if (!allowed) {
        throw new MemoryPolicyError("Structured event visibility is broader than a source memory");
      }
    }
  }

  async aggregateReadableEvents(
    principal: MemoryPrincipal,
    query: EventQuery = {},
  ): Promise<EventAggregate> {
    const rows = await this.db
      .selectFrom("questlab.structured_event as event")
      .selectAll("event")
      .where((expression) =>
        expression.or([
          expression("event.scope", "=", "public"),
          expression("event.tenant_id", "=", principal.tenant_id),
        ]),
      )
      .$if(Boolean(query.subject_id), (builder) => builder.where("event.subject_id", "=", query.subject_id!))
      .$if(Boolean(query.event_type), (builder) => builder.where("event.event_type", "=", query.event_type!))
      .$if(Boolean(query.from), (builder) => builder.where("event.occurred_from", ">=", query.from!))
      .$if(Boolean(query.to), (builder) => builder.where("event.occurred_from", "<", query.to!))
      .$if(!query.include_conflicts, (builder) => builder.where("event.conflict_status", "=", "none"))
      .where((expression) =>
        expression.or([
          expression("event.scope", "=", "public"),
          expression.and([expression("event.scope", "=", "tenant"), expression("event.owner_id", "=", principal.tenant_id)]),
          ...(principal.user_id
            ? [expression.and([expression("event.scope", "=", "user_private"), expression("event.owner_id", "=", principal.user_id)])]
            : []),
          ...(principal.agent_id
            ? [expression.and([expression("event.scope", "=", "agent_private"), expression("event.owner_id", "=", principal.agent_id)])]
            : []),
          ...(principal.session_id
            ? [expression.and([expression("event.scope", "=", "session"), expression("event.owner_id", "=", principal.session_id)])]
            : []),
        ]),
      )
      .orderBy("event.occurred_from", "asc")
      .execute();
    const unique = new Map<string, StructuredEvent>();
    for (const row of rows) unique.set(row.dedupe_key, row);
    const included = [...unique.values()];
    return {
      operation: "count_distinct",
      field: "dedupe_key",
      value: included.length,
      included_event_ids: included.map((event) => event.event_id),
      excluded_conflict_count: rows.filter((event) => event.conflict_status !== "none").length,
    };
  }
}

function sameDeletionAck(target: MemoryDeletionTarget, ack: DeletionPropagationAck): boolean {
  return target.attempt === ack.attempt &&
    target.status === ack.status &&
    target.acknowledged_at?.toISOString() === new Date(ack.occurred_at).toISOString() &&
    canonicalJson(target.evidence_refs) === canonicalJson(ack.evidence_refs) &&
    canonicalJson(target.last_error) === canonicalJson(ack.error ?? null);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

async function canDeleteMemory(
  db: Kysely<QuestLabDatabase>,
  memory: MemoryRecord,
  principal: MemoryPrincipal,
): Promise<boolean> {
  if (memory.scope !== "public" && memory.tenant_id !== principal.tenant_id) return false;
  const ownerAllowed =
    (memory.scope === "tenant" && memory.owner_id === principal.tenant_id) ||
    (memory.scope === "user_private" && memory.owner_id === principal.user_id) ||
    (memory.scope === "agent_private" && memory.owner_id === principal.agent_id) ||
    (memory.scope === "session" && memory.owner_id === principal.session_id);
  if (ownerAllowed) return true;
  const identities = principalIdentities(principal);
  if (identities.length === 0) return false;
  const grant = await db
    .selectFrom("questlab.memory_acl")
    .select("memory_id")
    .where("memory_id", "=", memory.memory_id)
    .where("permission", "=", "delete")
    .where((expression) =>
      expression.or(
        identities.map((identity) =>
          expression.and([
            expression("principal_type", "=", identity.type),
            expression("principal_id", "=", identity.id),
          ]),
        ),
      ),
    )
    .executeTakeFirst();
  return Boolean(grant);
}

function principalIdentities(
  principal: MemoryPrincipal,
): readonly { readonly type: MemoryAclTable["principal_type"]; readonly id: string }[] {
  return [
    principal.user_id ? { type: "user" as const, id: principal.user_id } : undefined,
    principal.agent_id ? { type: "agent" as const, id: principal.agent_id } : undefined,
    principal.session_id ? { type: "session" as const, id: principal.session_id } : undefined,
    ...(principal.role_ids ?? []).map((id) => ({ type: "role" as const, id })),
    { type: "tenant" as const, id: principal.tenant_id },
  ].filter(
    (identity): identity is { type: MemoryAclTable["principal_type"]; id: string } => Boolean(identity),
  );
}
