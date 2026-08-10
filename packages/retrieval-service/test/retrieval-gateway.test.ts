import assert from "node:assert/strict";
import test from "node:test";

import {
  RetrievalGateway,
  RetrievalPolicyError,
  type RetrievalHit,
  type RetrievalRequest,
  type Retriever,
} from "../src/index.ts";

const baseRequest: RetrievalRequest = {
  query_id: "query.test.01",
  original_query: "What changed in solar output?",
  intent: "fact_lookup",
  agent_id: "learning-director",
  principal: { tenant_id: "tenant.test", user_id: "user.test" },
  purpose: "answer_current_user",
  token_budget: 1_000,
  estimated_chunk_tokens: 100,
  require_citations: true,
};

test("gateway fuses independent ranks, deduplicates hits and rechecks ACL", async () => {
  const calls: number[] = [];
  const gateway = new RetrievalGateway({
    retrievers: [
      fakeRetriever("lexical", [hit("ev.a", 10, "concept:a"), hit("shared", 8, "concept:shared"), hit("secret", 7, "secret")], calls),
      fakeRetriever("vector", [hit("shared", 0.99, "concept:shared"), hit("ev.b", 0.95, "concept:b")], calls),
    ],
    authorization: { canRead: ({ hit: candidate }) => candidate.id !== "secret" },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.equal(pack.status, "sufficient");
  assert.equal(pack.schema_version, 1);
  assert.equal(pack.plan.schema_version, 1);
  assert.equal(pack.plan.query_id, baseRequest.query_id);
  assert.equal(pack.generation_allowed, true);
  assert.equal(pack.evidence[0]?.evidence_id, "shared");
  assert.equal(pack.evidence.some((item) => item.evidence_id === "secret"), false);
  assert.equal(pack.trace.denied, 1);
  assert.equal(pack.trace.fused, 4);
  assert.ok(calls.every((value) => value === pack.plan.candidate_k));
  assert.ok(pack.evidence.every((item) => item.untrusted_content.length > 0));
});

test("aggregation intent uses structured truth and keeps RAG as citation evidence", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [
      fakeRetriever("lexical", [hit("e1", 1, "trip:1"), hit("e2", 0.8, "trip:2"), hit("e3", 0.6, "trip:3")]),
      fakeRetriever("temporal", [hit("e1", 1, "trip:1"), hit("e2", 0.9, "trip:2"), hit("e3", 0.8, "trip:3")]),
    ],
    authorization: { canRead: () => true },
    aggregator: {
      aggregate: async () => ({
        operation: "count_distinct",
        value: 3,
        included_ids: ["trip:1", "trip:2", "trip:3"],
        excluded_reasons: [],
        conflicts: [],
      }),
    },
  });

  const pack = await gateway.retrieve({
    ...baseRequest,
    query_id: "query.count.01",
    original_query: "How many times did the user travel?",
    intent: "count_events",
    agent_id: "learning-scientist",
    token_budget: 2_000,
  });

  assert.equal(pack.plan.structured_query_required, true);
  assert.equal(pack.structured_result?.value, 3);
  assert.equal(pack.status, "sufficient");
  assert.equal(pack.generation_allowed, true);
});

test("structured intents fail closed without an aggregator", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("e1", 1, "trip:1")])],
    authorization: { canRead: () => true },
  });

  await assert.rejects(
    gateway.retrieve({ ...baseRequest, intent: "count_events" }),
    (error: unknown) => error instanceof RetrievalPolicyError,
  );
});

test("insufficient authorized evidence blocks generation", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("only", 1, "concept:only")])],
    authorization: { canRead: () => true },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.equal(pack.status, "insufficient");
  assert.equal(pack.generation_allowed, false);
  assert.equal(pack.coverage, 0.5);
});

test("conflicting immutable evidence identities fail closed", async () => {
  const original = hit("same", 1, "concept:same");
  const gateway = new RetrievalGateway({
    retrievers: [
      fakeRetriever("lexical", [original]),
      fakeRetriever("vector", [{
        ...original,
        content: "Different content under the same evidence ID",
      }]),
    ],
    authorization: { canRead: () => true },
  });

  await assert.rejects(
    gateway.retrieve(baseRequest),
    (error: unknown) => error instanceof RetrievalPolicyError,
  );
});

test("invalid structured aggregator output is blocked at the contract boundary", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [
      fakeRetriever("lexical", [hit("event.1", 1, "trip:1"), hit("event.2", 0.9, "trip:2"), hit("event.3", 0.8, "trip:3")]),
      fakeRetriever("temporal", [hit("event.1", 1, "trip:1"), hit("event.2", 0.9, "trip:2"), hit("event.3", 0.8, "trip:3")]),
    ],
    authorization: { canRead: () => true },
    aggregator: {
      aggregate: async () => ({
        operation: "count_distinct",
        value: 2,
        included_ids: ["trip:1", "trip:1"],
        excluded_reasons: [],
        conflicts: [],
      }),
    },
  });

  await assert.rejects(
    gateway.retrieve({ ...baseRequest, intent: "count_events", token_budget: 2_000 }),
    (error: unknown) => error instanceof TypeError && error.message.includes("EvidencePack validation failed"),
  );
});

function fakeRetriever(
  stage: "lexical" | "vector" | "temporal",
  hits: readonly RetrievalHit[],
  calls?: number[],
): Retriever {
  return {
    id: `${stage}.test`,
    stage,
    retrieve: async (call) => {
      calls?.push(call.max_results);
      return hits;
    },
  };
}

function hit(id: string, score: number, entity: string): RetrievalHit {
  return {
    id,
    content: `Untrusted evidence for ${id}`,
    score,
    token_count: 80,
    source_type: id.startsWith("e") ? "event" : "document",
    entity_keys: [entity],
    citation: {
      artifact_id: `artifact.${id}`,
      uri: `s3://test/${id}`,
      digest: `sha256:${"a".repeat(64)}`,
      locator: { page: 1 },
    },
  };
}
