import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { EmbeddingPort } from "@firefly/model-gateway";
import {
  MemoryPolicyError,
  MemoryRepository,
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
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);
      const memories = new MemoryRepository(db);
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
      await indexer.index(chunk("other-dimension", "memory.retrieval.public", "Unrelated dimension probe.", [1, 0], 1));
      const changedPrivateContent = "Changed content under an existing Chunk ID.";
      await assert.rejects(
        indexer.index({
          ...privateChunk,
          content: changedPrivateContent,
          chunk_digest: contentDigest(changedPrivateContent),
        }),
        (error: unknown) => error instanceof ChunkIdentityConflictError,
      );

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
      assert.deepEqual(lexicalHits.map((hit) => hit.id).sort(), ["chunk.private", "chunk.public"]);
      const vectorHits = await vector.retrieve(call);
      assert.deepEqual(vectorHits.map((hit) => hit.id).sort(), ["chunk.private", "chunk.public"]);
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
      assert.deepEqual(pack.evidence.map((item) => item.evidence_id).sort(), ["chunk.private", "chunk.public"]);

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
        }),
        (error: unknown) => error instanceof MemoryPolicyError,
      );

      const receipt = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.01",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "user requested erasure",
        occurred_at: new Date("2026-08-10T12:00:00Z"),
      });
      assert.equal(receipt.removed_chunk_count, 1);
      assert.equal(receipt.invalidated_event_count, 1);
      const replay = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.replay",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "retry",
      });
      assert.equal(replay.deletion_id, receipt.deletion_id);

      const afterDeletion = await lexical.retrieve(call);
      assert.deepEqual(afterDeletion.map((hit) => hit.id), ["chunk.public"]);
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
) {
  return {
    chunk_id: `chunk.${suffix}`,
    memory_id: memoryId,
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
