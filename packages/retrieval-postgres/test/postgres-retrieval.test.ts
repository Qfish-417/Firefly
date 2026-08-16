import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { EmbeddingPort } from "@firefly/model-gateway";
import type { QuestLabDatabase } from "@firefly/persistence";
import type { Kysely } from "kysely";

import {
  findDeterministicRelationPath,
  PostgresLexicalRetriever,
  PostgresMemoryIndexer,
  PostgresRelationExpansionCandidateSource,
  PostgresRetrievalPolicyError,
  PostgresStructuredEventAggregator,
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
      index_version_id: "index.unit.v1",
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

test("Parent Chunk validation rejects retrieval embeddings before database access", async () => {
  const indexer = new PostgresMemoryIndexer(unavailableDb);

  await assert.rejects(
    indexer.index({
      chunk_id: "chunk.parent.unit",
      memory_id: "memory.unit",
      index_version_id: "index.unit.v1",
      ordinal: 0,
      chunk_level: "parent",
      content: "parent context",
      chunk_digest: contentDigest("parent context"),
      token_count: 4,
      source_type: "document",
      citation: {
        artifact_id: "artifact.unit",
        uri: "s3://unit/content",
        digest: `sha256:${"b".repeat(64)}`,
      },
      embedding: [1, 0, 0],
      embedding_model: "embedding.unit.v1",
    }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

test("relation expansion candidate source validates policy before querying", async () => {
  assert.throws(
    () => new PostgresRelationExpansionCandidateSource({ db: unavailableDb, region_locator_key: "" }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
  const source = new PostgresRelationExpansionCandidateSource({ db: unavailableDb });
  assert.deepEqual(await source.listCandidates({
    hits: [],
    principal: { tenant_id: "tenant.unit" },
    purpose: "test",
    max_candidates_per_anchor: 4,
  }), []);
  await assert.rejects(
    source.listCandidates({
      hits: [],
      principal: { tenant_id: "tenant.unit" },
      purpose: "",
      max_candidates_per_anchor: 4,
    }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

test("structured aggregation validates direct callers before database access", async () => {
  const aggregator = new PostgresStructuredEventAggregator(unavailableDb);
  const base = {
    query_id: "query.structured.unit",
    original_query: "first attempt",
    agent_id: "learning-scientist",
    principal: { tenant_id: "tenant.unit" },
    purpose: "test",
    token_budget: 100,
    estimated_chunk_tokens: 10,
    require_citations: false,
  };
  await assert.rejects(
    aggregator.aggregate({ request: {
      ...base,
      intent: "temporal",
      structured_query: { kind: "select_event_time", subject_id: "learner", event_type: "attempt", selector: "middle" },
    } as never }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
  await assert.rejects(
    aggregator.aggregate({ request: {
      ...base,
      intent: "comparison",
      structured_query: {
        kind: "compare_event_counts",
        left_subject_id: "learner.left",
        right_subject_id: "learner.right",
        event_type: "attempt",
        from: "2026-08-02T00:00:00Z",
        to: "2026-08-01T00:00:00Z",
      },
    } as never }),
    (error: unknown) => error instanceof PostgresRetrievalPolicyError,
  );
});

test("relation path search is deterministic, bounded, conflict-aware and cycle-safe", () => {
  const edge = (edgeId: string, source: string, target: string, conflict = false) => ({
    edge_id: edgeId,
    schema_version: 1 as const,
    tenant_id: "tenant.unit",
    source_node_id: source,
    predicate: "depends_on",
    target_node_id: target,
    direction: "directed" as const,
    scope: "tenant" as const,
    owner_id: "tenant.unit",
    valid_from: new Date("2026-08-01T00:00:00Z"),
    valid_to: null,
    dedupe_key: edgeId,
    source_memory_ids: ["memory.unit"],
    confidence: 1,
    conflict_status: conflict ? "conflict" as const : "none" as const,
    created_at: new Date("2026-08-01T00:00:00Z"),
  });
  const edges = [
    edge("edge.d-c", "node.d", "node.c"),
    edge("edge.c-a", "node.c", "node.a"),
    edge("edge.a-d", "node.a", "node.d"),
    edge("edge.b-c", "node.b", "node.c", true),
    edge("edge.a-b", "node.a", "node.b"),
  ];
  const safe = findDeterministicRelationPath(edges, {
    start_node_id: "node.a", target_node_id: "node.c", direction: "outbound", max_hops: 3, include_conflicts: false,
  });
  assert.equal(safe.found, true);
  assert.deepEqual(safe.node_ids, ["node.a", "node.d", "node.c"]);
  assert.deepEqual(safe.path_hops.map((hop) => hop.edge_id), ["edge.a-d", "edge.d-c"]);
  assert.deepEqual(safe.conflict_ids, ["edge.b-c"]);
  assert.equal(safe.excluded_conflict_count, 1);

  const includingConflict = findDeterministicRelationPath(edges, {
    start_node_id: "node.a", target_node_id: "node.c", direction: "outbound", max_hops: 3, include_conflicts: true,
  });
  assert.deepEqual(includingConflict.path_hops.map((hop) => hop.edge_id), ["edge.a-b", "edge.b-c"]);
  assert.deepEqual(includingConflict.conflict_ids, ["edge.b-c"]);
  assert.equal(findDeterministicRelationPath(edges, {
    start_node_id: "node.a", target_node_id: "node.c", direction: "outbound", max_hops: 1, include_conflicts: false,
  }).found, false);
  assert.deepEqual(findDeterministicRelationPath(edges, {
    start_node_id: "node.c", target_node_id: "node.a", direction: "inbound", max_hops: 3, include_conflicts: false,
  }).node_ids, ["node.c", "node.d", "node.a"]);
});

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
