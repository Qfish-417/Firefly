import {
  assertContract,
  type IndexBuildResult,
  type IndexBuildTask,
  type JsonObject,
} from "@firefly/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type { QuestLabDatabase, RetrievalIndexVersionTable } from "./database.ts";
import { enqueueOutbox } from "./event-repositories.ts";

export type RetrievalIndexVersion = Selectable<RetrievalIndexVersionTable>;

export class RetrievalIndexPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalIndexPolicyError";
  }
}

export class RetrievalIndexRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async createBuild(task: IndexBuildTask): Promise<RetrievalIndexVersion> {
    assertContract("IndexBuildTask", task);
    return this.db.transaction().execute(async (trx) => {
      const identityLocks = [
        JSON.stringify(["build", task.build_id]),
        JSON.stringify(["version", task.index_version_id]),
      ].sort();
      for (const identityLock of identityLocks) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`.execute(trx);
      }
      const existing = await trx
        .selectFrom("questlab.retrieval_index_version")
        .selectAll()
        .where((expression) =>
          expression.or([
            expression("index_version_id", "=", task.index_version_id),
            expression("build_id", "=", task.build_id),
          ]),
        )
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (!sameBuildIdentity(existing, task)) {
          throw new RetrievalIndexPolicyError("Build or index version ID was reused with different immutable inputs");
        }
        return existing;
      }

      const requestedAt = parseDate(task.requested_at, "requested_at");
      const created = await trx
        .insertInto("questlab.retrieval_index_version")
        .values({
          index_version_id: task.index_version_id,
          build_id: task.build_id,
          tenant_id: task.tenant_id,
          logical_name: task.logical_name,
          index_kind: task.index_kind,
          provider: task.provider,
          configuration_digest: task.configuration_digest,
          embedding_model: task.embedding_model ?? null,
          embedding_dimensions: task.embedding_dimensions ?? null,
          source_watermark: task.source_watermark,
          status: "building",
          document_count: 0,
          chunk_count: 0,
          error: null,
          requested_at: requestedAt,
          ready_at: null,
          activated_at: null,
          retired_at: null,
          updated_at: requestedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await enqueueOutbox(trx, {
        event_id: `event.index-build-requested.${task.build_id}`,
        event_type: "RetrievalIndexBuildRequested",
        correlation_id: task.build_id,
        trace_id: task.build_id,
        producer: "retrieval-index-repository",
        idempotency_key: `index-build-request:${task.build_id}`,
        occurred_at: requestedAt,
        payload: task as unknown as JsonObject,
        artifact_refs: [],
      });
      return created;
    });
  }

  async completeBuild(result: IndexBuildResult): Promise<RetrievalIndexVersion> {
    assertContract("IndexBuildResult", result);
    return this.db.transaction().execute(async (trx) => {
      const version = await trx
        .selectFrom("questlab.retrieval_index_version")
        .selectAll()
        .where("index_version_id", "=", result.index_version_id)
        .forUpdate()
        .executeTakeFirst();
      if (!version) throw new RetrievalIndexPolicyError(`Index version does not exist: ${result.index_version_id}`);
      if (version.build_id !== result.build_id || version.source_watermark !== result.source_watermark) {
        throw new RetrievalIndexPolicyError("Build result does not match its immutable build identity");
      }
      if (version.status !== "building") {
        if (sameBuildResult(version, result)) return version;
        throw new RetrievalIndexPolicyError(`Index build cannot complete from status ${version.status}`);
      }

      const completedAt = parseDate(result.completed_at, "completed_at");
      const updated = await trx
        .updateTable("questlab.retrieval_index_version")
        .set({
          status: result.status,
          document_count: result.document_count,
          chunk_count: result.chunk_count,
          error: result.error ? (result.error as JsonObject) : null,
          ready_at: result.status === "ready" ? completedAt : null,
          updated_at: completedAt,
        })
        .where("index_version_id", "=", result.index_version_id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await enqueueOutbox(trx, {
        event_id: `event.index-build-${result.status}.${result.build_id}`,
        event_type: result.status === "ready" ? "RetrievalIndexBuildReady" : "RetrievalIndexBuildFailed",
        correlation_id: result.build_id,
        trace_id: result.build_id,
        producer: "retrieval-index-repository",
        idempotency_key: `index-build-result:${result.build_id}`,
        occurred_at: completedAt,
        payload: result as unknown as JsonObject,
        artifact_refs: [],
      });
      return updated;
    });
  }

  async activate(indexVersionId: string, activatedAt = new Date()): Promise<RetrievalIndexVersion> {
    return this.db.transaction().execute(async (trx) => {
      const identity = await trx
        .selectFrom("questlab.retrieval_index_version")
        .select(["tenant_id", "logical_name"])
        .where("index_version_id", "=", indexVersionId)
        .executeTakeFirst();
      if (!identity) throw new RetrievalIndexPolicyError(`Index version does not exist: ${indexVersionId}`);

      const activationLockKey = JSON.stringify([identity.tenant_id, identity.logical_name]);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${activationLockKey}, 0))`.execute(trx);
      const version = await trx
        .selectFrom("questlab.retrieval_index_version")
        .selectAll()
        .where("index_version_id", "=", indexVersionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (version.status === "active") return version;
      if (version.status !== "ready") {
        throw new RetrievalIndexPolicyError(`Only a ready index may be activated, received ${version.status}`);
      }

      await trx
        .updateTable("questlab.retrieval_index_version")
        .set({ status: "retired", retired_at: activatedAt, updated_at: activatedAt })
        .where("tenant_id", "=", version.tenant_id)
        .where("logical_name", "=", version.logical_name)
        .where("status", "=", "active")
        .execute();
      const activated = await trx
        .updateTable("questlab.retrieval_index_version")
        .set({ status: "active", activated_at: activatedAt, retired_at: null, updated_at: activatedAt })
        .where("index_version_id", "=", indexVersionId)
        .where("status", "=", "ready")
        .returningAll()
        .executeTakeFirstOrThrow();
      await enqueueOutbox(trx, {
        event_id: `event.index-activated.${indexVersionId}`,
        event_type: "RetrievalIndexActivated",
        correlation_id: version.build_id,
        trace_id: version.build_id,
        producer: "retrieval-index-repository",
        idempotency_key: `index-activate:${indexVersionId}`,
        occurred_at: activatedAt,
        payload: {
          index_version_id: indexVersionId,
          tenant_id: version.tenant_id,
          logical_name: version.logical_name,
          activated_at: activatedAt.toISOString(),
        },
        artifact_refs: [],
      });
      return activated;
    });
  }

  async getActive(tenantId: string, logicalName: string): Promise<RetrievalIndexVersion | undefined> {
    return this.db
      .selectFrom("questlab.retrieval_index_version")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("logical_name", "=", logicalName)
      .where("status", "=", "active")
      .executeTakeFirst();
  }

  async getById(indexVersionId: string): Promise<RetrievalIndexVersion | undefined> {
    return this.db
      .selectFrom("questlab.retrieval_index_version")
      .selectAll()
      .where("index_version_id", "=", indexVersionId)
      .executeTakeFirst();
  }
}

function sameBuildIdentity(version: RetrievalIndexVersion, task: IndexBuildTask): boolean {
  return version.index_version_id === task.index_version_id &&
    version.build_id === task.build_id &&
    version.tenant_id === task.tenant_id &&
    version.logical_name === task.logical_name &&
    version.index_kind === task.index_kind &&
    version.provider === task.provider &&
    version.configuration_digest === task.configuration_digest &&
    version.embedding_model === (task.embedding_model ?? null) &&
    version.embedding_dimensions === (task.embedding_dimensions ?? null) &&
    version.source_watermark === task.source_watermark &&
    version.requested_at.toISOString() === parseDate(task.requested_at, "requested_at").toISOString();
}

function sameBuildResult(version: RetrievalIndexVersion, result: IndexBuildResult): boolean {
  if (version.status !== result.status && !(result.status === "ready" && ["active", "retired"].includes(version.status))) {
    return false;
  }
  const completedAt = parseDate(result.completed_at, "completed_at").toISOString();
  const storedCompletedAt = result.status === "ready"
    ? version.ready_at?.toISOString()
    : version.updated_at.toISOString();
  return storedCompletedAt === completedAt &&
    version.document_count === result.document_count &&
    version.chunk_count === result.chunk_count &&
    canonicalJson(version.error) === canonicalJson(result.error ?? null);
}

function parseDate(value: string, field: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new RetrievalIndexPolicyError(`${field} is not a valid timestamp`);
  return result;
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
