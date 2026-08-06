import assert from "node:assert/strict";
import test from "node:test";

import { planRetrieval, selectEvidence, type EvidenceCandidate } from "../src/index.ts";

test("aggregation questions require structured computation and keep a larger evidence budget", () => {
  const plan = planRetrieval({
    intent: "count_events",
    agent_id: "learning-scientist",
    token_budget: 2_000,
    estimated_chunk_tokens: 100,
    required_entity_count: 3,
  });

  assert.equal(plan.structured_query_required, true);
  assert.equal(plan.answer_source, "structured_plus_evidence");
  assert.ok(plan.candidate_k > plan.context_k);
  assert.ok(plan.context_k <= 14);
  assert.ok(plan.stages.includes("structured"));
});

test("small token budgets dynamically reduce context K while preserving a minimum", () => {
  const plan = planRetrieval({
    intent: "exploratory",
    agent_id: "learning-director",
    token_budget: 300,
    estimated_chunk_tokens: 100,
  });

  assert.equal(plan.context_k, 2);
  assert.equal(plan.min_context_k, 2);
  assert.equal(plan.max_context_tokens, 210);
});

test("evidence selection filters ACL failures, score tails, token overflow and same-source duplicates", () => {
  const plan = planRetrieval({
    intent: "fact_lookup",
    agent_id: "learning-director",
    token_budget: 1_000,
    estimated_chunk_tokens: 100,
  });
  const candidates: EvidenceCandidate[] = [
    { id: "a", score: 0.98, token_count: 90, source_type: "document", entity_keys: ["x"], access_allowed: true },
    { id: "b", score: 0.94, token_count: 90, source_type: "document", entity_keys: ["x"], access_allowed: true },
    { id: "c", score: 0.91, token_count: 90, source_type: "event", entity_keys: ["y"], access_allowed: true },
    { id: "d", score: 0.2, token_count: 90, source_type: "event", entity_keys: ["z"], access_allowed: true },
    { id: "secret", score: 1, token_count: 10, source_type: "document", entity_keys: ["s"], access_allowed: false },
  ];

  const selected = selectEvidence(candidates, plan);
  assert.deepEqual(selected.candidates.map((candidate) => candidate.id), ["a", "c"]);
  assert.equal(selected.used_tokens, 180);
});

test("available retriever stages are narrowed without changing the intent contract", () => {
  const plan = planRetrieval({
    intent: "multi_hop",
    agent_id: "experience-engineer",
    token_budget: 4_000,
    estimated_chunk_tokens: 200,
    available_stages: ["vector", "lexical"],
  });

  assert.deepEqual(plan.stages, ["lexical", "vector"]);
  assert.equal(plan.structured_query_required, true);
});

test("invalid budgets fail closed", () => {
  assert.throws(
    () => planRetrieval({ intent: "fact_lookup", agent_id: "learning-director", token_budget: 0, estimated_chunk_tokens: 100 }),
    RangeError,
  );
});
