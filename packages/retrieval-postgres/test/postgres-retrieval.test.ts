import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { EmbeddingPort } from "@firefly/model-gateway";
import type { QuestLabDatabase } from "@firefly/persistence";
import type { Kysely } from "kysely";

import {
  PostgresLexicalRetriever,
  PostgresMemoryIndexer,
  PostgresRetrievalPolicyError,
  PostgresVectorRetriever,
} from "../src/index.ts";

const unavailableDb = null as unknown as Kysely<QuestLabDatabase>;

test("PostgreSQL retrievers fail closed on unsupported filters before querying", async () => {
  const retriever = new PostgresLexicalRetriever(unavailableDb);

  await assert.rejects(
    retriever.retrieve({
      query_id: "query.filter.unit",
      query: "solar output",
      principal: { tenant_id: "tenant.unit" },
      purpose: "test",
      max_results: 5,
      filters: { arbitrary_sql: "not allowed" },
    }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

test("zero query embeddings are rejected before pgvector cosine search", async () => {
  const embeddings: EmbeddingPort = {
    embed: async () => ({
      vectors: [[0, 0, 0]],
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        cached_input_tokens: 0,
        total_tokens: 1,
        cost_usd: 0,
      },
    }),
  };
  const retriever = new PostgresVectorRetriever({
    db: unavailableDb,
    embeddings,
    embedding_model: "embedding.unit.v1",
    embedding_budget: { max_tokens: 10, max_cost_usd: 0, max_duration_ms: 100 },
  });

  await assert.rejects(
    retriever.retrieve({
      query_id: "query.vector.unit",
      query: "solar",
      principal: { tenant_id: "tenant.unit" },
      purpose: "test",
      max_results: 5,
      filters: {},
    }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

test("chunk validation rejects duplicate entity keys before indexing", async () => {
  const indexer = new PostgresMemoryIndexer(unavailableDb);

  await assert.rejects(
    indexer.index({
      chunk_id: "chunk.unit",
      memory_id: "memory.unit",
      ordinal: 0,
      content: "content",
      chunk_digest: contentDigest("content"),
      token_count: 1,
      source_type: "document",
      entity_keys: ["concept.unit", "concept.unit"],
      citation: {
        artifact_id: "artifact.unit",
        uri: "s3://unit/content",
        digest: `sha256:${"b".repeat(64)}`,
      },
    }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
