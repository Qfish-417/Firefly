import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { EmbeddingPort } from "@firefly/model-gateway";
import {
  MemoryPolicyError,
  MemoryRepository,
  RetrievalIndexPolicyError,
  RetrievalIndexRepository,
  createDatabase,
  migrateToLatest,
} from "@firefly/persistence";
import { RetrievalGateway, type RetrievalHit } from "@firefly/retrieval-service";
import { sql } from "kysely";

import {
  ChunkIdentityConflictError,
  PostgresLexicalRetriever,
  PostgresMemoryAuthorization,
  PostgresMemoryIndexer,
  PostgresRetrievalPolicyError,
  PostgresVectorRetriever,
} from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

test(
  "PostgreSQL hybrid retrieval enforces ACL and propagates memory deletion",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);

    try {
      await sql`
        TRUNCATE TABLE
          questlab.outbox_event,
          questlab.structured_event,
          questlab.retrieval_index_version,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);
      const memories = new MemoryRepository(db);
      const indexes = new RetrievalIndexRepository(db);
      const indexer = new PostgresMemoryIndexer(db);
      const principal = { tenant_id: "tenant.retrieval", user_id: "user.retrieval.01" };

      await memories.capture({
        memory_id: "memory.retrieval.public",
        tenant_id: "tenant.retrieval",
        owner_type: "platform",
        owner_id: "platform",
        scope: "public",
        stage: "structured",
        kind: "document",
        content_digest: digest("1"),
        confidence: 1,
        sensitivity: "public",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.user",
        tenant_id: "tenant.retrieval",
        owner_type: "user",
        owner_id: "user.retrieval.01",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: digest("2"),
        confidence: 0.95,
        sensitivity: "private",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.other",
        tenant_id: "tenant.retrieval",
        owner_type: "user",
        owner_id: "user.retrieval.02",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: digest("3"),
        confidence: 0.9,
        sensitivity: "private",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.foreign-public",
        tenant_id: "tenant.other",
        owner_type: "platform",
        owner_id: "platform",
        scope: "public",
        stage: "structured",
        kind: "document",
        content_digest: digest("4"),
        confidence: 1,
        sensitivity: "public",
        status: "active",
      });

      const buildV1 = indexBuild("v1", "tenant.retrieval", "watermark.01");
      const buildReplays = await Promise.all([indexes.createBuild(buildV1), indexes.createBuild(buildV1)]);
      assert.deepEqual(buildReplays.map((version) => version.index_version_id), [buildV1.index_version_id, buildV1.index_version_id]);

      await indexer.index(chunk("public", "memory.retrieval.public", "Solar output changes with daylight.", [1, 0, 0]));
      const privateChunk = chunk(
        "private",
        "memory.retrieval.user",
        "Private solar output observation for the current learner.",
        [0.95, 0.05, 0],
      );
      await indexer.index(privateChunk);
      await indexer.index(privateChunk);
      await indexer.index(chunk("secret", "memory.retrieval.other", "Secret solar output record.", [1, 0, 0]));
      await assert.rejects(
        indexer.index(chunk("other-dimension", "memory.retrieval.public", "Unrelated dimension probe.", [1, 0], 1)),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
      const foreignBuild = indexBuild("foreign", "tenant.other", "watermark.foreign");
      await indexes.createBuild(foreignBuild);
      await assert.rejects(
        indexer.index(chunk("foreign", "memory.retrieval.public", "Cross tenant chunk.", [1, 0, 0], 1, foreignBuild.index_version_id)),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
      await indexer.index(chunk(
        "foreign-public",
        "memory.retrieval.foreign-public",
        "Public solar output reference from another tenant.",
        [1, 0, 0],
        0,
        foreignBuild.index_version_id,
      ));
      await indexes.completeBuild(indexBuildResult(foreignBuild, "ready", 1, 1));
      await indexes.activate(foreignBuild.index_version_id, new Date("2026-08-10T09:00:00Z"));
      const changedPrivateContent = "Changed content under an existing Chunk ID.";
      await assert.rejects(
        indexer.index({
          ...privateChunk,
          content: changedPrivateContent,
          chunk_digest: contentDigest(changedPrivateContent),
        }),
        (error: unknown) => error instanceof ChunkIdentityConflictError,
      );
      await indexes.completeBuild(indexBuildResult(buildV1, "ready", 3, 3));
      await indexes.activate(buildV1.index_version_id, new Date("2026-08-10T09:00:00Z"));
      assert.equal((await indexes.getActive("tenant.retrieval", "memory.hybrid"))?.index_version_id, buildV1.index_version_id);

      const lexical = new PostgresLexicalRetriever(db);
      const embeddings: EmbeddingPort = {
        embed: async ({ inputs }) => ({
          vectors: inputs.map(() => [1, 0, 0]),
          usage: {
            input_tokens: 3,
            output_tokens: 0,
            cached_input_tokens: 0,
            total_tokens: 3,
            cost_usd: 0,
          },
        }),
      };
      const vector = new PostgresVectorRetriever({
        db,
        embeddings,
        embedding_model: "embedding.integration.v1",
        embedding_budget: { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 1_000 },
      });
      const authorization = new PostgresMemoryAuthorization(db);
      const call = {
        query_id: "query.retrieval.integration",
        query: "solar output",
        principal,
        purpose: "answer_current_user",
        max_results: 10,
        filters: {},
      } as const;

      const lexicalHits = await lexical.retrieve(call);
      assert.deepEqual(lexicalHits.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);
      const vectorHits = await vector.retrieve(call);
      assert.deepEqual(vectorHits.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);
      assert.equal(await authorization.canRead({ principal, purpose: call.purpose, hit: secretHit() }), false);
      const publicHit = lexicalHits.find((hit) => hit.id === "chunk.public");
      assert.ok(publicHit);
      assert.equal(
        await authorization.canRead({
          principal,
          purpose: call.purpose,
          hit: { ...publicHit, citation: { ...publicHit.citation, digest: digest("9") } },
        }),
        false,
      );

      const gateway = new RetrievalGateway({
        retrievers: [lexical, vector],
        authorization,
      });
      const pack = await gateway.retrieve({
        query_id: call.query_id,
        original_query: call.query,
        intent: "fact_lookup",
        agent_id: "learning-director",
        principal,
        purpose: call.purpose,
        token_budget: 1_000,
        estimated_chunk_tokens: 80,
        require_citations: true,
      });
      assert.equal(pack.status, "sufficient");
      assert.deepEqual(pack.evidence.map((item) => item.evidence_id).sort(), ["chunk.foreign-public", "chunk.private"]);

      const buildV2 = indexBuild("v2", "tenant.retrieval", "watermark.02");
      await indexes.createBuild(buildV2);
      await indexer.index(chunk(
        "public.v2",
        "memory.retrieval.public",
        "Solar output changes with daylight in the active revision.",
        [1, 0, 0],
        0,
        buildV2.index_version_id,
      ));
      assert.deepEqual((await lexical.retrieve(call)).map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);
      await indexes.completeBuild(indexBuildResult(buildV2, "ready", 1, 1));
      await indexes.activate(buildV2.index_version_id, new Date("2026-08-10T11:00:00Z"));
      assert.deepEqual((await lexical.retrieve(call)).map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.public.v2"]);
      const versions = await db
        .selectFrom("questlab.retrieval_index_version")
        .select(["index_version_id", "status"])
        .where("tenant_id", "=", principal.tenant_id)
        .where("logical_name", "=", "memory.hybrid")
        .execute();
      assert.deepEqual(
        Object.fromEntries(versions.map((version) => [version.index_version_id, version.status])),
        { "index.memory.v1": "retired", "index.memory.v2": "active" },
      );
      await assert.rejects(
        indexes.completeBuild({ ...indexBuildResult(buildV2, "ready", 2, 2), chunk_count: 2 }),
        (error: unknown) => error instanceof RetrievalIndexPolicyError,
      );

      await memories.recordEvent({
        event_id: "event.retrieval.private",
        tenant_id: principal.tenant_id,
        subject_id: principal.user_id,
        event_type: "solar_observation",
        object: { output_changed: true },
        scope: "user_private",
        owner_id: principal.user_id,
        occurred_from: new Date("2026-08-10T10:00:00Z"),
        dedupe_key: "solar:user.retrieval.01:2026-08-10",
        source_memory_ids: [privateChunk.memory_id],
        confidence: 0.95,
      });
      await assert.rejects(
        memories.deleteMemory({
          deletion_id: "deletion.retrieval.unauthorized",
          memory_id: privateChunk.memory_id,
          principal: { tenant_id: principal.tenant_id, user_id: "user.retrieval.02" },
          requested_by: "user.retrieval.02",
          reason: "unauthorized test",
          propagation_targets: ["object_store", "cache"],
        }),
        (error: unknown) => error instanceof MemoryPolicyError,
      );

      const receipt = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.01",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "user requested erasure",
        propagation_targets: ["object_store", "cache"],
        occurred_at: new Date("2026-08-10T12:00:00Z"),
      });
      assert.equal(receipt.removed_chunk_count, 1);
      assert.equal(receipt.invalidated_event_count, 1);
      assert.equal(receipt.propagation_status, "pending");
      assert.equal(receipt.propagation_completed_at, null);

      let deletionStatus = await memories.acknowledgeDeletion({
        schema_version: 1,
        ack_id: "ack.deletion.cache.01",
        deletion_id: receipt.deletion_id,
        target: "cache",
        status: "failed",
        attempt: 1,
        occurred_at: "2026-08-10T12:01:00.000Z",
        evidence_refs: [],
        error: { code: "cache.timeout", message: "Cache deletion timed out", retryable: true },
      });
      assert.equal(deletionStatus.receipt.propagation_status, "failed");
      deletionStatus = await memories.acknowledgeDeletion({
        schema_version: 1,
        ack_id: "ack.deletion.object-store.01",
        deletion_id: receipt.deletion_id,
        target: "object_store",
        status: "completed",
        attempt: 1,
        occurred_at: "2026-08-10T12:02:00.000Z",
        evidence_refs: [],
      });
      assert.equal(deletionStatus.receipt.propagation_status, "failed");
      const cacheRetry = {
        schema_version: 1,
        ack_id: "ack.deletion.cache.02",
        deletion_id: receipt.deletion_id,
        target: "cache",
        status: "completed",
        attempt: 2,
        occurred_at: "2026-08-10T12:03:00.000Z",
        evidence_refs: [],
      } as const;
      deletionStatus = await memories.acknowledgeDeletion(cacheRetry);
      assert.equal(deletionStatus.receipt.propagation_status, "completed");
      assert.equal(deletionStatus.receipt.propagation_completed_at?.toISOString(), cacheRetry.occurred_at);
      const acknowledgementReplay = await memories.acknowledgeDeletion(cacheRetry);
      assert.equal(acknowledgementReplay.receipt.propagation_status, "completed");
      await assert.rejects(
        memories.acknowledgeDeletion({ ...cacheRetry, occurred_at: "2026-08-10T12:04:00.000Z" }),
        (error: unknown) => error instanceof MemoryPolicyError,
      );

      const replay = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.replay",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "retry",
        propagation_targets: ["cache", "object_store"],
      });
      assert.equal(replay.deletion_id, receipt.deletion_id);
      assert.equal(replay.propagation_status, "completed");

      const afterDeletion = await lexical.retrieve(call);
      assert.deepEqual(afterDeletion.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.public.v2"]);
      const aggregate = await memories.aggregateReadableEvents(principal, {
        subject_id: principal.user_id,
        event_type: "solar_observation",
      });
      assert.equal(aggregate.value, 0);
      const deletionEvents = await db
        .selectFrom("questlab.outbox_event")
        .select(["event_type", "payload"])
        .where("event_type", "=", "MemoryDeleted")
        .execute();
      assert.equal(deletionEvents.length, 1);
      assert.equal(deletionEvents[0]?.payload.memory_id, privateChunk.memory_id);
      const propagationEvents = await db
        .selectFrom("questlab.outbox_event")
        .select(["event_type", "payload"])
        .where("event_type", "=", "MemoryDeletionPropagationRequested")
        .execute();
      assert.equal(propagationEvents.length, 2);
      assert.deepEqual(propagationEvents.map((event) => event.payload.target).sort(), ["cache", "object_store"]);
      const completedEvents = await db
        .selectFrom("questlab.outbox_event")
        .select("event_id")
        .where("event_type", "=", "MemoryDeletionPropagationCompleted")
        .execute();
      assert.equal(completedEvents.length, 1);
    } finally {
      await db.destroy();
    }
  },
);

function chunk(
  suffix: string,
  memoryId: string,
  content: string,
  embedding: readonly number[],
  ordinal = 0,
  indexVersionId = "index.memory.v1",
) {
  return {
    chunk_id: `chunk.${suffix}`,
    memory_id: memoryId,
    index_version_id: indexVersionId,
    ordinal,
    content,
    chunk_digest: contentDigest(content),
    token_count: 20,
    source_type: "memory.document",
    entity_keys: [`concept.${suffix}`],
    citation: {
      artifact_id: `artifact.${suffix}`,
      uri: `s3://retrieval-test/${suffix}.json`,
      digest: digest(suffix === "public" ? "d" : suffix === "private" ? "e" : "f"),
      locator: { section: suffix },
    },
    embedding,
    embedding_model: "embedding.integration.v1",
  } as const;
}

function indexBuild(suffix: string, tenantId: string, watermark: string) {
  return {
    schema_version: 1,
    build_id: `build.memory.${suffix}`,
    index_version_id: `index.memory.${suffix}`,
    tenant_id: tenantId,
    logical_name: "memory.hybrid",
    index_kind: "hybrid",
    provider: "postgres",
    source_watermark: watermark,
    configuration_digest: digest("a"),
    embedding_model: "embedding.integration.v1",
    embedding_dimensions: 3,
    requested_at: "2026-08-10T08:00:00.000Z",
  } as const;
}

function indexBuildResult(
  build: ReturnType<typeof indexBuild>,
  status: "ready" | "failed",
  documentCount: number,
  chunkCount: number,
) {
  return {
    schema_version: 1,
    build_id: build.build_id,
    index_version_id: build.index_version_id,
    status,
    document_count: documentCount,
    chunk_count: chunkCount,
    source_watermark: build.source_watermark,
    completed_at: "2026-08-10T08:30:00.000Z",
    quality_report: {
      schema_version: 1,
      report_id: `quality.${build.build_id}`,
      build_id: build.build_id,
      index_version_id: build.index_version_id,
      source_watermark: build.source_watermark,
      configuration_digest: build.configuration_digest,
      passed: status === "ready",
      checks: (["structure", "source_watermark", "acl", "recall", "citation"] as const).map((name) => ({
        name,
        passed: status === "ready",
        score: status === "ready" ? 1 : 0,
        threshold: 1,
        sample_size: chunkCount,
        summary: status === "ready" ? `${name} passed` : `${name} failed`,
        evidence_refs: [],
      })),
      evaluated_at: "2026-08-10T08:30:00.000Z",
    },
    ...(status === "failed"
      ? { error: { code: "build.failed", message: "Index build failed", retryable: true } }
      : {}),
  } as const;
}

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function secretHit(): RetrievalHit {
  return {
    id: "chunk.secret",
    content: "must not be visible",
    score: 1,
    token_count: 20,
    source_type: "memory.document",
    entity_keys: ["concept.secret"],
    citation: {
      artifact_id: "artifact.secret",
      uri: "s3://retrieval-test/secret.json",
      digest: digest("f"),
    },
  };
}
