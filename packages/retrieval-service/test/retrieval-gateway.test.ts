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

test("gateway reranks only ACL-authorized candidates and uses normalized reranker scores", async () => {
  let documents: readonly string[] = [];
  let topK = 0;
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("first", 1, "concept:first"), hit("second", 0.9, "concept:second"), hit("secret", 0.8, "concept:secret")])],
    authorization: { canRead: ({ hit: candidate }) => candidate.id !== "secret" },
    reranker: {
      rerank: async (request) => {
        documents = request.documents;
        topK = request.top_k;
        return {
          rankings: [{ index: 1, score: 0.95 }, { index: 0, score: 0.7 }],
          usage: { input_tokens: 8, output_tokens: 0, cached_input_tokens: 0, total_tokens: 8, cost_usd: 0 },
        };
      },
    },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.equal(topK, 2);
  assert.equal(documents.some((document) => document.includes("secret")), false);
  assert.deepEqual(pack.evidence.map((item) => item.evidence_id), ["second", "first"]);
  assert.deepEqual(pack.evidence.map((item) => item.score), [0.95, 0.7]);
});

test("gateway falls back to fused order only for retryable reranker failures", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("first", 1, "concept:first"), hit("second", 0.9, "concept:second")])],
    authorization: { canRead: () => true },
    reranker: { rerank: async () => { throw Object.assign(new Error("temporary outage"), { retryable: true }); } },
  });

  const pack = await gateway.retrieve(baseRequest);
  assert.deepEqual(pack.evidence.map((item) => item.evidence_id), ["first", "second"]);
});

test("gateway fails closed on invalid reranker identities and strict provider outages", async () => {
  const invalid = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("first", 1, "concept:first"), hit("second", 0.9, "concept:second")])],
    authorization: { canRead: () => true },
    reranker: {
      rerank: async () => ({
        rankings: [{ index: 0, score: 0.9 }, { index: 0, score: 0.8 }],
        usage: { input_tokens: 1, output_tokens: 0, cached_input_tokens: 0, total_tokens: 1, cost_usd: 0 },
      }),
    },
  });
  await assert.rejects(invalid.retrieve(baseRequest), (error: unknown) => error instanceof RetrievalPolicyError && error.message.includes("failed closed"));

  const strict = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [hit("first", 1, "concept:first"), hit("second", 0.9, "concept:second")])],
    authorization: { canRead: () => true },
    reranker: { rerank: async () => { throw Object.assign(new Error("temporary outage"), { retryable: true }); } },
    reranker_failure_mode: "strict",
  });
  await assert.rejects(strict.retrieve(baseRequest), (error: unknown) => error instanceof RetrievalPolicyError && error.message.includes("temporary outage"));
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

/**
 * Reciprocal Rank Fusion gives identical scores to two documents that each rank first in exactly one
 * list, so the order used to fall to Map insertion order — that is, to whichever retriever happened
 * to be configured first. Measured on a 30720-chunk corpus, the lexical leg's wrong rank-1 displaced
 * the vector leg's correct rank-1 on 3 of 32 Chinese queries and cost 0.047 MRR.
 *
 * A hit both retrievers found must win: that agreement is the entire premise of hybrid retrieval.
 */
test("fusion ties are broken by retriever agreement, not by retriever order", async () => {
  const lexicalFirst = new RetrievalGateway({
    retrievers: [
      fakeRetriever("lexical", [hit("noise", 1, "concept:noise"), hit("agreed", 0.5, "concept:agreed")]),
      fakeRetriever("vector", [hit("solo", 1, "concept:solo"), hit("agreed", 0.5, "concept:agreed")]),
    ],
    authorization: { canRead: () => true },
  });
  // Same retrievers, declared the other way round. The outcome must not change.
  const vectorFirst = new RetrievalGateway({
    retrievers: [
      fakeRetriever("vector", [hit("solo", 1, "concept:solo"), hit("agreed", 0.5, "concept:agreed")]),
      fakeRetriever("lexical", [hit("noise", 1, "concept:noise"), hit("agreed", 0.5, "concept:agreed")]),
    ],
    authorization: { canRead: () => true },
  });

  const [left, right] = await Promise.all([
    lexicalFirst.retrieve(baseRequest),
    vectorFirst.retrieve(baseRequest),
  ]);

  // "agreed" is at rank 2 in both lists, so it accumulates 2/(60+2) and outranks the rank-1 hits that
  // each appear in only one list at 1/(60+1).
  assert.equal(left.evidence[0]?.evidence_id, "agreed");
  assert.deepEqual(
    left.evidence.map((item) => item.evidence_id),
    right.evidence.map((item) => item.evidence_id),
    "fusion order must not depend on the order retrievers are configured in",
  );
});

/**
 * With equal scores *and* equal agreement the order still has to be total, otherwise the same query
 * can return different evidence between runs and the pack stops being reproducible.
 */
test("fusion order is deterministic when scores and agreement are equal", async () => {
  const build = () =>
    new RetrievalGateway({
      retrievers: [
        fakeRetriever("lexical", [hit("zeta", 1, "concept:zeta")]),
        fakeRetriever("vector", [hit("alpha", 1, "concept:alpha")]),
      ],
      authorization: { canRead: () => true },
    });

  const packs = await Promise.all([build().retrieve(baseRequest), build().retrieve(baseRequest)]);
  const orders = packs.map((pack) => pack.evidence.map((item) => item.evidence_id));
  assert.deepEqual(orders[0], orders[1]);
  // Both rank first in one list each and appear in one list each, so the id decides.
  assert.equal(orders[0]?.[0], "alpha");
});

test("query rewriting is only attempted when retrieval came back empty", async () => {
  const queriesSeen: string[] = [];
  let rewrites = 0;
  const gateway = new RetrievalGateway({
    retrievers: [{
      id: "lexical.test",
      stage: "lexical",
      retrieve: async (call) => {
        queriesSeen.push(call.query);
        return [hit("ev.a", 10, "concept:a")];
      },
    }],
    authorization: { canRead: () => true },
    query_rewriter: { rewrite: async () => { rewrites += 1; return "hypothetical passage"; } },
  });

  const pack = await gateway.retrieve(baseRequest);

  // The rewrite costs a model call and measured -14% P@10 when applied unconditionally, so a
  // successful retrieval must never reach it.
  assert.equal(rewrites, 0);
  assert.deepEqual(queriesSeen, [baseRequest.original_query]);
  assert.equal(pack.trace.rewritten_query, undefined);
});

test("an empty result is retried with a rewritten query and the rewrite is reported", async () => {
  const queriesSeen: string[] = [];
  const gateway = new RetrievalGateway({
    retrievers: [{
      id: "lexical.test",
      stage: "lexical",
      retrieve: async (call) => {
        queriesSeen.push(call.query);
        return call.query === "hypothetical passage" ? [hit("ev.a", 10, "concept:a")] : [];
      },
    }],
    authorization: { canRead: () => true },
    query_rewriter: { rewrite: async () => "hypothetical passage" },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.deepEqual(queriesSeen, [baseRequest.original_query, "hypothetical passage"]);
  assert.equal(pack.evidence[0]?.evidence_id, "ev.a");
  // The caller has to be able to tell that the evidence answers a machine-generated paraphrase
  // rather than the question that was actually asked.
  assert.equal(pack.trace.rewritten_query, "hypothetical passage");
});

test("a rewrite that also finds nothing leaves the empty pack untouched", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [])],
    authorization: { canRead: () => true },
    query_rewriter: { rewrite: async () => "still nothing" },
  });

  const pack = await gateway.retrieve(baseRequest);

  assert.equal(pack.evidence.length, 0);
  // Reporting a rewrite that recovered nothing would imply the answer came from the paraphrase.
  assert.equal(pack.trace.rewritten_query, undefined);
});

test("a failing rewriter cannot turn an empty result into an error", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [fakeRetriever("lexical", [])],
    authorization: { canRead: () => true },
    query_rewriter: { rewrite: async () => { throw new Error("model unavailable"); } },
  });

  // An empty pack is a truthful answer; a rewrite is an optional recovery attempt, so its failure
  // must not be escalated into a retrieval failure.
  const pack = await gateway.retrieve(baseRequest);
  assert.equal(pack.evidence.length, 0);
  assert.equal(pack.status, "insufficient");
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
