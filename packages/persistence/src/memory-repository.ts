import {
  assertContract,
  type DeletionPropagationAck,
  type DeletionPropagationTarget,
  type DeletionPropagationTask,
  type ArtifactRef,
  type JsonObject,
  type StructuredEdge as StructuredEdgeContract,
} from "@firefly/contracts";
import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  type SqlBool,
  type Transaction,
} from "kysely";

import type {
  MemoryDeletionReceiptTable,
  MemoryDeletionTargetTable,
  MemoryAclTable,
  MemoryRecordTable,
  QuestLabDatabase,
  StructuredEdgeTable,
  StructuredEventTable,
} from "./database.ts";
import { enqueueOutbox } from "./event-repositories.ts";

type MemoryExecutor = Kysely<QuestLabDatabase> | Transaction<QuestLabDatabase>;

export type MemoryRecord = Selectable<MemoryRecordTable>;
export type StructuredEvent = Selectable<StructuredEventTable>;
export type StructuredEdge = Selectable<StructuredEdgeTable>;
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
  readonly source_refs?: readonly ArtifactRef[];
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
  /**
   * Row cap. Unbounded reads load an entire tenant's `structured_event` table into the Retrieval
   * API process, so the query always applies a limit; hitting it is reported as truncation rather
   * than silently under-counting.
   */
  readonly limit?: number;
}

/** Default event row cap; one over the reporting threshold so truncation is detectable. */
export const defaultEventQueryLimit = 5_001;
export const maxEventQueryLimit = 20_001;

function eventQueryLimit(query: EventQuery): number {
  const limit = query.limit ?? defaultEventQueryLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxEventQueryLimit) {
    throw new MemoryPolicyError("Event query limit is invalid");
  }
  return limit;
}

/**
 * Who may read a `structured_event` row.
 *
 * Shared by the listing query and the vocabulary probes so both answer under one rule. Written once
 * because a second copy is how a probe ends up able to confirm that an event type exists in a tenant
 * the caller cannot read — the probe returns a boolean, so such a leak would be silent.
 *
 * The tenant/public check is intentionally applied twice: once as a coarse filter and once inside the
 * per-scope branch, because `scope = 'tenant'` additionally requires `owner_id` to match, which the
 * coarse filter does not establish.
 */
function eventVisibility(
  expression: ExpressionBuilder<QuestLabDatabase & { event: StructuredEventTable }, "event">,
  principal: MemoryPrincipal,
): Expression<SqlBool> {
  return expression.and([
    expression.or([
      expression("event.scope", "=", "public"),
      expression("event.tenant_id", "=", principal.tenant_id),
    ]),
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
  ]);
}

export interface EventAggregate {
  readonly operation: "count_distinct";
  readonly field: "dedupe_key";
  readonly value: number;
  readonly included_event_ids: readonly string[];
  readonly excluded_conflict_count: number;
  readonly conflict_event_ids: readonly string[];
  /** True when the row cap was reached, so `value` is a lower bound, not an exact count. */
  readonly truncated: boolean;
}

/**
 * Whether the vocabulary a structured query filtered on exists at all for this principal.
 *
 * An empty result set is ambiguous: "this subject genuinely never did this" and "this event type
 * does not exist, so the filter matched nothing" both produce zero rows. Callers that cannot tell
 * them apart report the first when the truth is the second, and a fabricated `event_type` becomes a
 * confident `count = 0` or, worse, a `difference = 0` that reads as "the two subjects are equal".
 *
 * Resolved with two existence probes rather than by inspecting the empty result, because absence is
 * not observable from the rows that are missing. Both probes respect the same visibility rules as
 * the aggregate itself: an event type the principal cannot read must count as unknown, not as
 * non-existent, otherwise the answer would leak which vocabulary exists in another tenant.
 */
export interface EventVocabularyPresence {
  /** False when no readable event of this type exists for any subject. */
  readonly event_type_known: boolean;
  /** False when the subject has no readable events of any type. */
  readonly subject_known: boolean;
}

export interface EdgeQuery {
  readonly predicates?: readonly string[];
  readonly as_of: Date;
  readonly limit?: number;
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
    for (const sourceRef of input.source_refs ?? []) assertContract("ArtifactRef", sourceRef);
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
    return this.db.transaction().execute(async (trx) => {
      await this.assertStructuredSourceVisibility(input, "event", trx);
      const inserted = await trx
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
      return trx
        .selectFrom("questlab.structured_event")
        .selectAll()
        .where("event_id", "=", input.event_id)
        .executeTakeFirstOrThrow();
    });
  }

  async recordEdge(input: {
    readonly edge_id: string;
    readonly tenant_id: string;
    readonly source_node_id: string;
    readonly predicate: string;
    readonly target_node_id: string;
    readonly direction: StructuredEdgeTable["direction"];
    readonly scope: StructuredEdgeTable["scope"];
    readonly owner_id: string;
    readonly valid_from: Date;
    readonly valid_to?: Date;
    readonly dedupe_key: string;
    readonly source_memory_ids: readonly string[];
    readonly confidence: number;
    readonly conflict_status?: StructuredEdgeTable["conflict_status"];
  }): Promise<StructuredEdge> {
    const contract: StructuredEdgeContract = {
      schema_version: 1,
      edge_id: input.edge_id,
      tenant_id: input.tenant_id,
      source_node_id: input.source_node_id,
      predicate: input.predicate,
      target_node_id: input.target_node_id,
      direction: input.direction,
      scope: input.scope,
      owner_id: input.owner_id,
      valid_from: input.valid_from.toISOString(),
      valid_to: input.valid_to?.toISOString() ?? null,
      dedupe_key: input.dedupe_key,
      source_memory_ids: input.source_memory_ids,
      confidence: input.confidence,
      conflict_status: input.conflict_status ?? "none",
    };
    assertContract("StructuredEdge", contract);
    if (input.source_node_id === input.target_node_id) throw new MemoryPolicyError("Structured edges cannot be self-referential");
    if (input.valid_to && input.valid_to < input.valid_from) throw new MemoryPolicyError("Structured edge validity range is reversed");
    return this.db.transaction().execute(async (trx) => {
      await this.assertStructuredSourceVisibility(input, "edge", trx);
      const inserted = await trx
        .insertInto("questlab.structured_edge")
        .values({
          ...input,
          schema_version: 1,
          valid_to: input.valid_to ?? null,
          source_memory_ids: JSON.stringify(input.source_memory_ids),
          conflict_status: input.conflict_status ?? "none",
        })
        .onConflict((conflict) => conflict.column("edge_id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return inserted;
      const existing = await trx.selectFrom("questlab.structured_edge").selectAll().where("edge_id", "=", input.edge_id).executeTakeFirstOrThrow();
      if (
        existing.tenant_id !== input.tenant_id || existing.source_node_id !== input.source_node_id ||
        existing.predicate !== input.predicate || existing.target_node_id !== input.target_node_id ||
        existing.direction !== input.direction || existing.scope !== input.scope || existing.owner_id !== input.owner_id ||
        existing.valid_from.getTime() !== input.valid_from.getTime() || existing.valid_to?.getTime() !== input.valid_to?.getTime() ||
        existing.dedupe_key !== input.dedupe_key || !sameStrings(existing.source_memory_ids, input.source_memory_ids) ||
        existing.confidence !== input.confidence || existing.conflict_status !== (input.conflict_status ?? "none")
      ) {
        throw new MemoryPolicyError(`Structured edge ID was reused with different content: ${input.edge_id}`);
      }
      return existing;
    });
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
      const invalidatedEdges = await trx
        .deleteFrom("questlab.structured_edge")
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
          invalidated_edge_count: Number(invalidatedEdges.numDeletedRows),
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
          resource_refs: memory.source_refs as unknown as readonly ArtifactRef[],
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
          invalidated_edge_count: receipt.invalidated_edge_count,
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

  async reconcileFailedDeletionTargets(input: {
    readonly stale_before: Date;
    readonly limit: number;
    readonly now?: Date;
  }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new MemoryPolicyError("Deletion reconciliation limit must be between 1 and 1000");
    }
    const candidates = await this.db
      .selectFrom("questlab.memory_deletion_target")
      .select(["deletion_id", "target"])
      .where("status", "=", "failed")
      .where("updated_at", "<=", input.stale_before)
      .orderBy("updated_at")
      .limit(input.limit)
      .execute();
    let requeued = 0;
    for (const candidate of candidates) {
      if (await this.requeueDeletionTarget(candidate.deletion_id, candidate.target, input.now ?? new Date())) {
        requeued += 1;
      }
    }
    return requeued;
  }

  private async requeueDeletionTarget(
    deletionId: string,
    targetName: DeletionPropagationTarget,
    now: Date,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const target = await trx
        .selectFrom("questlab.memory_deletion_target")
        .selectAll()
        .where("deletion_id", "=", deletionId)
        .where("target", "=", targetName)
        .forUpdate()
        .executeTakeFirst();
      if (!target || target.status !== "failed") return false;
      const receipt = await trx
        .selectFrom("questlab.memory_deletion_receipt")
        .innerJoin("questlab.memory_record", "questlab.memory_record.memory_id", "questlab.memory_deletion_receipt.memory_id")
        .select([
          "questlab.memory_deletion_receipt.memory_id",
          "questlab.memory_deletion_receipt.tenant_id",
          "questlab.memory_record.content_digest",
          "questlab.memory_record.source_refs",
        ])
        .where("questlab.memory_deletion_receipt.deletion_id", "=", deletionId)
        .executeTakeFirstOrThrow();
      const task: DeletionPropagationTask = {
        schema_version: 1,
        deletion_id: deletionId,
        memory_id: receipt.memory_id,
        tenant_id: receipt.tenant_id,
        target: targetName,
        content_digest: receipt.content_digest as `sha256:${string}`,
        resource_refs: receipt.source_refs as unknown as readonly ArtifactRef[],
        requested_at: now.toISOString(),
      };
      assertContract("DeletionPropagationTask", task);
      await enqueueOutbox(trx, {
        event_id: `event.memory-deletion-retry.${deletionId}.${targetName}.${target.attempt + 1}`,
        event_type: "MemoryDeletionPropagationRequested",
        correlation_id: deletionId,
        trace_id: deletionId,
        producer: "memory-repository-reconciler",
        idempotency_key: `memory-delete-retry:${deletionId}:${targetName}:${target.attempt + 1}`,
        occurred_at: now,
        payload: task as unknown as JsonObject,
        artifact_refs: task.resource_refs as unknown as readonly JsonObject[],
      });
      await trx
        .updateTable("questlab.memory_deletion_target")
        .set({ status: "pending", updated_at: now, acknowledged_at: null })
        .where("deletion_id", "=", deletionId)
        .where("target", "=", targetName)
        .executeTakeFirstOrThrow();
      const stillFailed = await trx
        .selectFrom("questlab.memory_deletion_target")
        .select("target")
        .where("deletion_id", "=", deletionId)
        .where("status", "=", "failed")
        .executeTakeFirst();
      await trx
        .updateTable("questlab.memory_deletion_receipt")
        .set({
          propagation_status: stillFailed ? "failed" : "pending",
          propagation_completed_at: null,
        })
        .where("deletion_id", "=", deletionId)
        .executeTakeFirstOrThrow();
      return true;
    });
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

  private async assertStructuredSourceVisibility(input: {
    readonly tenant_id: string;
    readonly scope: StructuredEventTable["scope"];
    readonly owner_id: string;
    readonly source_memory_ids: readonly string[];
  }, factKind: "event" | "edge", executor: MemoryExecutor = this.db): Promise<void> {
    if (input.source_memory_ids.length === 0) {
      throw new MemoryPolicyError(`Structured ${factKind}s must retain at least one source memory`);
    }
    // FOR SHARE keeps a concurrent deleteMemory from committing between this check and the
    // insert, which would otherwise leave a structured fact derived from an erased memory.
    const sources = await executor
      .selectFrom("questlab.memory_record")
      .select(["memory_id", "tenant_id", "scope", "owner_id", "status"])
      .where("memory_id", "in", input.source_memory_ids)
      .forShare()
      .execute();
    if (
      new Set(input.source_memory_ids).size !== input.source_memory_ids.length ||
      sources.length !== input.source_memory_ids.length
    ) {
      throw new MemoryPolicyError(`Structured ${factKind} references a missing source memory`);
    }
    for (const source of sources) {
      if ((source.scope !== "public" && source.tenant_id !== input.tenant_id) || source.status === "deleted") {
        throw new MemoryPolicyError(`Structured ${factKind} source crosses tenant or deletion boundary`);
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
        throw new MemoryPolicyError(`Structured ${factKind} visibility is broader than a source memory`);
      }
    }
  }

  async aggregateReadableEvents(
    principal: MemoryPrincipal,
    query: EventQuery = {},
  ): Promise<EventAggregate> {
    const limit = eventQueryLimit(query);
    const rows = await this.listReadableEvents(principal, { ...query, limit });
    const truncated = rows.length >= limit;
    const conflicts = rows.filter((event) => event.conflict_status !== "none");
    const unique = new Map<string, StructuredEvent>();
    for (const row of rows) {
      if ((query.include_conflicts || row.conflict_status === "none") && !unique.has(row.dedupe_key)) {
        unique.set(row.dedupe_key, row);
      }
    }
    const included = [...unique.values()];
    return {
      operation: "count_distinct",
      field: "dedupe_key",
      value: included.length,
      included_event_ids: included.map((event) => event.event_id),
      excluded_conflict_count: conflicts.length,
      conflict_event_ids: conflicts.map((event) => event.event_id),
      truncated,
    };
  }

  async listReadableEvents(
    principal: MemoryPrincipal,
    query: EventQuery = {},
  ): Promise<readonly StructuredEvent[]> {
    return this.db
      .selectFrom("questlab.structured_event as event")
      .selectAll("event")
      .where((expression) => eventVisibility(expression, principal))
      .$if(Boolean(query.subject_id), (builder) => builder.where("event.subject_id", "=", query.subject_id!))
      .$if(Boolean(query.event_type), (builder) => builder.where("event.event_type", "=", query.event_type!))
      .$if(Boolean(query.from), (builder) => builder.where("event.occurred_from", ">=", query.from!))
      .$if(Boolean(query.to), (builder) => builder.where("event.occurred_from", "<", query.to!))
      .orderBy("event.occurred_from", "asc")
      .orderBy("event.event_id", "asc")
      .limit(eventQueryLimit(query))
      .execute();
  }

  /**
   * Probes whether the subject and event type a query filtered on are readable at all.
   *
   * Deliberately ignores the time range: a count of zero inside a window is a real answer when the
   * event type exists, and narrowing it further would make every empty window look like a typo.
   * What this distinguishes is only vocabulary that does not exist from facts that did not happen.
   *
   * Two bounded `limit(1)` probes rather than one grouped scan: the aggregate query has already been
   * executed by the time a caller needs this, so the cost only lands on the empty-result path.
   */
  async probeEventVocabulary(
    principal: MemoryPrincipal,
    filters: { readonly subject_id?: string; readonly event_type?: string },
  ): Promise<EventVocabularyPresence> {
    const probe = (apply: (builder: ReturnType<MemoryRepository["eventProbeQuery"]>) => ReturnType<MemoryRepository["eventProbeQuery"]>) =>
      apply(this.eventProbeQuery(principal)).executeTakeFirst();
    const [eventTypeRow, subjectRow] = await Promise.all([
      filters.event_type === undefined
        ? Promise.resolve(undefined)
        : probe((builder) => builder.where("event.event_type", "=", filters.event_type!)),
      filters.subject_id === undefined
        ? Promise.resolve(undefined)
        : probe((builder) => builder.where("event.subject_id", "=", filters.subject_id!)),
    ]);
    return {
      // Absent filters are reported as known: nothing was asserted, so nothing can be wrong.
      event_type_known: filters.event_type === undefined ? true : Boolean(eventTypeRow),
      subject_known: filters.subject_id === undefined ? true : Boolean(subjectRow),
    };
  }

  private eventProbeQuery(principal: MemoryPrincipal) {
    return this.db
      .selectFrom("questlab.structured_event as event")
      .select("event.event_id")
      .where((expression) => eventVisibility(expression, principal))
      .limit(1);
  }

  /**
   * The event types this principal can actually read.
   *
   * Exists because a caller composing a structured query otherwise has to guess the vocabulary. A
   * model asked "is A doing better than B?" translated the word 表现 ("performance") straight into
   * `event_type: "表现"` on 3 of 3 samples — a value that passes request validation and then yields
   * a confident zero. Guessing is the only available strategy when nothing enumerates the real
   * values, so this turns an unanswerable question into a lookup.
   *
   * Bounded by `limit` because the result is meant for a prompt or a picker, not bulk export: a
   * tenant with thousands of event types would otherwise produce an unusable list and a heavy
   * query. Visibility reuses the read path predicate, so it cannot reveal another tenant's
   * vocabulary.
   */
  async listReadableEventTypes(
    principal: MemoryPrincipal,
    options: { readonly limit?: number } = {},
  ): Promise<readonly string[]> {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new MemoryPolicyError("Event type limit must be between 1 and 1000");
    }
    const rows = await this.db
      .selectFrom("questlab.structured_event as event")
      .select("event.event_type")
      .distinct()
      .where((expression) => eventVisibility(expression, principal))
      .orderBy("event.event_type", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => row.event_type);
  }

  async listReadableEdges(principal: MemoryPrincipal, query: EdgeQuery): Promise<readonly StructuredEdge[]> {
    if (!Number.isFinite(query.as_of.getTime())) throw new MemoryPolicyError("Edge query as_of must be a valid timestamp");
    if (query.predicates && (query.predicates.length > 32 || new Set(query.predicates).size !== query.predicates.length)) {
      throw new MemoryPolicyError("Edge query predicates must be unique and contain at most 32 values");
    }
    const limit = query.limit ?? 5_001;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20_001) throw new MemoryPolicyError("Edge query limit is invalid");
    return this.db
      .selectFrom("questlab.structured_edge as edge")
      .selectAll("edge")
      .where((expression) => expression.or([
        expression("edge.scope", "=", "public"),
        expression("edge.tenant_id", "=", principal.tenant_id),
      ]))
      .$if(Boolean(query.predicates?.length), (builder) => builder.where("edge.predicate", "in", query.predicates!))
      .where("edge.valid_from", "<=", query.as_of)
      .where((expression) => expression.or([
        expression("edge.valid_to", "is", null),
        expression("edge.valid_to", ">", query.as_of),
      ]))
      .where((expression) => expression.or([
        expression("edge.scope", "=", "public"),
        expression.and([expression("edge.scope", "=", "tenant"), expression("edge.owner_id", "=", principal.tenant_id)]),
        ...(principal.user_id ? [expression.and([expression("edge.scope", "=", "user_private"), expression("edge.owner_id", "=", principal.user_id)])] : []),
        ...(principal.agent_id ? [expression.and([expression("edge.scope", "=", "agent_private"), expression("edge.owner_id", "=", principal.agent_id)])] : []),
        ...(principal.session_id ? [expression.and([expression("edge.scope", "=", "session"), expression("edge.owner_id", "=", principal.session_id)])] : []),
      ]))
      .orderBy("edge.source_node_id")
      .orderBy("edge.predicate")
      .orderBy("edge.target_node_id")
      .orderBy("edge.edge_id")
      .limit(limit)
      .execute();
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
