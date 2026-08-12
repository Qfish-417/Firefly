import assert from "node:assert/strict";
import test from "node:test";

import {
  CandidateSourceEvidenceExpander,
  DeterministicEvidenceExpander,
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

test("expanded Parent evidence is reauthorized before entering the EvidencePack", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("child.allowed", 1, "concept:a"), hit("child.denied", 0.9, "concept:b")])],
    authorization: { canRead: ({ hit: candidate }) => candidate.id !== "parent.denied" },
    expander: {
      expand: async ({ hits }) => hits.map((candidate) => ({
        ...candidate,
        id: candidate.id.replace("child", "parent"),
        content: `Expanded context for ${candidate.id}`,
      })),
    },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.deepEqual(pack.evidence.map((item) => item.evidence_id), ["parent.allowed"]);
  assert.equal(pack.trace.denied, 1);
  assert.equal(pack.generation_allowed, false);
});

test("an Evidence Expander cannot exceed the context token budget", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("child.a", 1, "concept:a"), hit("child.b", 0.9, "concept:b")])],
    authorization: { canRead: () => true },
    expander: {
      expand: async ({ hits }) => hits.map((candidate) => ({ ...candidate, token_count: 10_000 })),
    },
  });

  await assert.rejects(gateway.retrieve(baseRequest), /exceeded the context token budget/);
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

test("deterministic expansion applies relation priority and stable score/id ordering", async () => {
  const anchor = hit("anchor", 1, "concept:anchor");
  const expander = new DeterministicEvidenceExpander({
    candidates: [
      { anchor_id: anchor.id, relation: "entity", hit: hit("entity.z", 0.95, "concept:z") },
      { anchor_id: anchor.id, relation: "region", hit: hit("region.low", 0.2, "concept:r1") },
      { anchor_id: anchor.id, relation: "region", hit: hit("region.high", 0.9, "concept:r2") },
      { anchor_id: anchor.id, relation: "neighbor", hit: hit("neighbor", 1, "concept:n") },
      { anchor_id: anchor.id, relation: "entity", hit: hit("entity.a", 0.95, "concept:a") },
    ],
  });

  const expanded = await expander.expand({
    hits: [anchor],
    principal: baseRequest.principal,
    purpose: baseRequest.purpose,
    max_tokens: 1_000,
  });

  assert.deepEqual(expanded.map((candidate) => candidate.id), [
    "anchor",
    "region.high",
    "region.low",
    "neighbor",
    "entity.a",
    "entity.z",
  ]);
});

test("deterministic expansion truncates candidates at the remaining token budget", async () => {
  const anchor = hit("anchor", 1, "concept:anchor");
  const first = hit("first", 0.9, "concept:first");
  const second = hit("second", 0.8, "concept:second");
  const expander = new DeterministicEvidenceExpander({
    candidates: [
      { anchor_id: anchor.id, relation: "neighbor", hit: first },
      { anchor_id: anchor.id, relation: "neighbor", hit: second },
    ],
  });

  const expanded = await expander.expand({
    hits: [anchor],
    principal: baseRequest.principal,
    purpose: baseRequest.purpose,
    max_tokens: anchor.token_count + first.token_count,
  });

  assert.deepEqual(expanded.map((candidate) => candidate.id), ["anchor", "first"]);
});

test("deterministic expansion rejects conflicting immutable evidence IDs", async () => {
  const anchor = hit("anchor", 1, "concept:anchor");
  const original = hit("same", 0.9, "concept:same");
  const conflicting = { ...original, content: "different immutable content" };
  const expander = new DeterministicEvidenceExpander({
    candidates: [
      { anchor_id: anchor.id, relation: "neighbor", hit: original },
      { anchor_id: anchor.id, relation: "entity", hit: conflicting },
    ],
  });

  await assert.rejects(
    expander.expand({
      hits: [anchor],
      principal: baseRequest.principal,
      purpose: baseRequest.purpose,
      max_tokens: 1_000,
    }),
    (error: unknown) => error instanceof RetrievalPolicyError && error.message.includes("conflicting immutable content"),
  );
});

test("deterministic expansion honors AbortSignal", async () => {
  const anchor = hit("anchor", 1, "concept:anchor");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const expander = new DeterministicEvidenceExpander({ candidates: [] });

  await assert.rejects(
    expander.expand({
      hits: [anchor],
      principal: baseRequest.principal,
      purpose: baseRequest.purpose,
      max_tokens: 1_000,
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

test("candidate-source expansion resolves provider candidates through the deterministic policy", async () => {
  const anchor = hit("anchor", 1, "concept:anchor");
  let requestedLimit = 0;
  const expander = new CandidateSourceEvidenceExpander({
    listCandidates: async (input) => {
      requestedLimit = input.max_candidates_per_anchor;
      return [
        { anchor_id: anchor.id, relation: "entity", hit: hit("entity", 1, "concept:entity") },
        { anchor_id: anchor.id, relation: "region", hit: hit("region", 0.2, "concept:region") },
      ];
    },
  }, { max_candidates_per_anchor: 4 });

  const expanded = await expander.expand({
    hits: [anchor],
    principal: baseRequest.principal,
    purpose: baseRequest.purpose,
    max_tokens: 1_000,
  });

  assert.equal(requestedLimit, 4);
  assert.deepEqual(expanded.map((candidate) => candidate.id), ["anchor", "region", "entity"]);
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
