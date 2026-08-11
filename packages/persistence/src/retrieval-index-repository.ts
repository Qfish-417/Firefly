import {
  assertContract,
  type IndexBuildResult,
  type IndexBuildTask,
  type IndexQualityReport,
  type JsonObject,
} from "@firefly/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type {
  QuestLabDatabase,
  RetrievalIndexRetentionHoldTable,
  RetrievalIndexVersionTable,
} from "./database.ts";
import { enqueueOutbox } from "./event-repositories.ts";

export type RetrievalIndexVersion = Selectable<RetrievalIndexVersionTable>;
export type RetrievalIndexRetentionHold = Selectable<RetrievalIndexRetentionHoldTable>;

export interface RegisterRetrievalIndexRetentionHoldInput {
  readonly hold_id: string;
  readonly index_version_id: string;
  readonly reference_type: string;
  readonly reference_id: string;
  readonly reason: string;
  readonly created_at: Date;
  readonly expires_at?: Date;
}

export interface PurgeRetiredIndexesInput {
  readonly retired_before: Date;
  readonly limit: number;
  readonly now?: Date;
}

export interface PurgedRetrievalIndex {
  readonly index_version_id: string;
  readonly tenant_id: string;
  readonly logical_name: string;
  readonly deleted_chunk_count: number;
  readonly retired_at: string;
  readonly purged_at: string;
}

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
          quality_report: null,
          error: null,
          requested_at: requestedAt,
          ready_at: null,
          activated_at: null,
          retired_at: null,
          purged_at: null,
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
      if (result.quality_report) validateQualityIdentity(version, result);
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
          quality_report: result.quality_report ? (result.quality_report as unknown as JsonObject) : null,
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
      validateActivationQuality(version);

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

  async registerRetentionHold(
    input: RegisterRetrievalIndexRetentionHoldInput,
  ): Promise<RetrievalIndexRetentionHold> {
    const createdAt = input.created_at;
    const expiresAt = input.expires_at ?? null;
    validateHoldInput(input, createdAt, expiresAt);
    return this.db.transaction().execute(async (trx) => {
      const identityLocks = [
        JSON.stringify(["hold", input.hold_id]),
        JSON.stringify(["reference", input.index_version_id, input.reference_type, input.reference_id]),
      ].sort();
      for (const identityLock of identityLocks) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock}, 0))`.execute(trx);
      }
      const version = await trx
        .selectFrom("questlab.retrieval_index_version")
        .select(["index_version_id", "purged_at"])
        .where("index_version_id", "=", input.index_version_id)
        .forUpdate()
        .executeTakeFirst();
      if (!version) throw new RetrievalIndexPolicyError(`Index version does not exist: ${input.index_version_id}`);
      if (version.purged_at) throw new RetrievalIndexPolicyError("A purged index version cannot receive a retention hold");

      const existing = await trx
        .selectFrom("questlab.retrieval_index_retention_hold")
        .selectAll()
        .where((expression) => expression.or([
          expression("hold_id", "=", input.hold_id),
          expression.and([
            expression("index_version_id", "=", input.index_version_id),
            expression("reference_type", "=", input.reference_type),
            expression("reference_id", "=", input.reference_id),
          ]),
        ]))
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (!sameRetentionHold(existing, input, createdAt, expiresAt)) {
          throw new RetrievalIndexPolicyError("Retention hold identity was reused with different immutable inputs");
        }
        return existing;
      }

      return trx
        .insertInto("questlab.retrieval_index_retention_hold")
        .values({
          hold_id: input.hold_id,
          index_version_id: input.index_version_id,
          reference_type: input.reference_type,
          reference_id: input.reference_id,
          reason: input.reason,
          created_at: createdAt,
          expires_at: expiresAt,
          released_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async releaseRetentionHold(holdId: string, releasedAt = new Date()): Promise<RetrievalIndexRetentionHold> {
    if (!holdId.trim() || !Number.isFinite(releasedAt.getTime())) {
      throw new RetrievalIndexPolicyError("A hold identity and valid release time are required");
    }
    return this.db.transaction().execute(async (trx) => {
      const identity = await trx
        .selectFrom("questlab.retrieval_index_retention_hold")
        .select("index_version_id")
        .where("hold_id", "=", holdId)
        .executeTakeFirst();
      if (!identity) throw new RetrievalIndexPolicyError(`Retention hold does not exist: ${holdId}`);
      await trx
        .selectFrom("questlab.retrieval_index_version")
        .select("index_version_id")
        .where("index_version_id", "=", identity.index_version_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const hold = await trx
        .selectFrom("questlab.retrieval_index_retention_hold")
        .selectAll()
        .where("hold_id", "=", holdId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (hold.released_at) return hold;
      if (releasedAt < hold.created_at) {
        throw new RetrievalIndexPolicyError("Retention hold release cannot precede its creation");
      }
      return trx
        .updateTable("questlab.retrieval_index_retention_hold")
        .set({ released_at: releasedAt })
        .where("hold_id", "=", holdId)
        .where("released_at", "is", null)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async purgeRetiredIndexes(input: PurgeRetiredIndexesInput): Promise<readonly PurgedRetrievalIndex[]> {
    const purgedAt = input.now ?? new Date();
    validatePurgeInput(input, purgedAt);
    return this.db.transaction().execute(async (trx) => {
      const candidates = await trx
        .selectFrom("questlab.retrieval_index_version as version")
        .select([
          "version.index_version_id",
          "version.build_id",
          "version.tenant_id",
          "version.logical_name",
          "version.retired_at",
        ])
        .where("version.status", "=", "retired")
        .where("version.purged_at", "is", null)
        .where("version.retired_at", "<=", input.retired_before)
        .where(sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM questlab.retrieval_index_retention_hold AS hold
          WHERE hold.index_version_id = version.index_version_id
            AND hold.released_at IS NULL
            AND (hold.expires_at IS NULL OR hold.expires_at > ${purgedAt})
        )`)
        .orderBy("version.retired_at", "asc")
        .orderBy("version.index_version_id", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();

      const purged: PurgedRetrievalIndex[] = [];
      for (const candidate of candidates) {
        if (!candidate.retired_at) continue;
        const activeHold = await trx
          .selectFrom("questlab.retrieval_index_retention_hold")
          .select("hold_id")
          .where("index_version_id", "=", candidate.index_version_id)
          .where("released_at", "is", null)
          .where((expression) => expression.or([
            expression("expires_at", "is", null),
            expression("expires_at", ">", purgedAt),
          ]))
          .executeTakeFirst();
        if (activeHold) continue;

        const deletion = await trx
          .deleteFrom("questlab.memory_chunk")
          .where("index_version_id", "=", candidate.index_version_id)
          .executeTakeFirst();
        const updated = await trx
          .updateTable("questlab.retrieval_index_version")
          .set({ purged_at: purgedAt, updated_at: purgedAt })
          .where("index_version_id", "=", candidate.index_version_id)
          .where("status", "=", "retired")
          .where("purged_at", "is", null)
          .returning("index_version_id")
          .executeTakeFirst();
        if (!updated) continue;
        const result: PurgedRetrievalIndex = {
          index_version_id: candidate.index_version_id,
          tenant_id: candidate.tenant_id,
          logical_name: candidate.logical_name,
          deleted_chunk_count: Number(deletion.numDeletedRows),
          retired_at: candidate.retired_at.toISOString(),
          purged_at: purgedAt.toISOString(),
        };
        await enqueueOutbox(trx, {
          event_id: `event.index-purged.${candidate.index_version_id}`,
          event_type: "RetrievalIndexPurged",
          correlation_id: candidate.build_id,
          trace_id: candidate.build_id,
          producer: "retrieval-index-repository",
          idempotency_key: `index-purge:${candidate.index_version_id}`,
          occurred_at: purgedAt,
          payload: result as unknown as JsonObject,
          artifact_refs: [],
        });
        purged.push(result);
      }
      return purged;
    });
  }
}

function validateHoldInput(
  input: RegisterRetrievalIndexRetentionHoldInput,
  createdAt: Date,
  expiresAt: Date | null,
): void {
  if (
    !input.hold_id.trim() ||
    !input.index_version_id.trim() ||
    !input.reference_type.trim() ||
    !input.reference_id.trim() ||
    !input.reason.trim()
  ) {
    throw new RetrievalIndexPolicyError("Retention hold identities and reason are required");
  }
  if (!Number.isFinite(createdAt.getTime()) || (expiresAt && !Number.isFinite(expiresAt.getTime()))) {
    throw new RetrievalIndexPolicyError("Retention hold timestamps must be valid");
  }
  if (expiresAt && expiresAt <= createdAt) {
    throw new RetrievalIndexPolicyError("Retention hold expiry must follow its creation");
  }
}

function validatePurgeInput(input: PurgeRetiredIndexesInput, now: Date): void {
  if (!Number.isFinite(input.retired_before.getTime()) || !Number.isFinite(now.getTime())) {
    throw new RetrievalIndexPolicyError("Retired-index garbage collection timestamps must be valid");
  }
  if (input.retired_before > now) {
    throw new RetrievalIndexPolicyError("Retired-index cutoff cannot be in the future");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new RetrievalIndexPolicyError("Retired-index garbage collection limit must be between 1 and 1000");
  }
}

function sameRetentionHold(
  hold: RetrievalIndexRetentionHold,
  input: RegisterRetrievalIndexRetentionHoldInput,
  createdAt: Date,
  expiresAt: Date | null,
): boolean {
  return hold.hold_id === input.hold_id &&
    hold.index_version_id === input.index_version_id &&
    hold.reference_type === input.reference_type &&
    hold.reference_id === input.reference_id &&
    hold.reason === input.reason &&
    hold.created_at.toISOString() === createdAt.toISOString() &&
    hold.expires_at?.toISOString() === expiresAt?.toISOString();
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
    canonicalJson(version.quality_report) === canonicalJson(result.quality_report ?? null) &&
    canonicalJson(version.error) === canonicalJson(result.error ?? null);
}

function validateQualityIdentity(version: RetrievalIndexVersion, result: IndexBuildResult): void {
  const report = result.quality_report!;
  if (
    report.build_id !== result.build_id ||
    report.index_version_id !== version.index_version_id ||
    report.source_watermark !== version.source_watermark ||
    report.configuration_digest !== version.configuration_digest
  ) {
    throw new RetrievalIndexPolicyError("Index quality report does not match its immutable build identity");
  }
  if (report.passed !== (result.status === "ready")) {
    throw new RetrievalIndexPolicyError("Index quality report outcome does not match build status");
  }
}

function validateActivationQuality(version: RetrievalIndexVersion): void {
  if (!version.quality_report) {
    throw new RetrievalIndexPolicyError("A passing index quality report is required for activation");
  }
  try {
    assertContract("IndexQualityReport", version.quality_report);
  } catch {
    throw new RetrievalIndexPolicyError("Persisted index quality report is invalid");
  }
  const report = version.quality_report as unknown as IndexQualityReport;
  const requiredChecks = ["structure", "source_watermark", "acl", "recall", "citation"] as const;
  const names = report.checks.map((check) => check.name);
  if (
    !report.passed ||
    report.build_id !== version.build_id ||
    report.index_version_id !== version.index_version_id ||
    report.source_watermark !== version.source_watermark ||
    report.configuration_digest !== version.configuration_digest ||
    names.length !== requiredChecks.length ||
    new Set(names).size !== names.length ||
    requiredChecks.some((name) => !names.includes(name)) ||
    report.checks.some((check) => !check.passed || check.score < check.threshold)
  ) {
    throw new RetrievalIndexPolicyError("Persisted index quality report cannot authorize activation");
  }
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
