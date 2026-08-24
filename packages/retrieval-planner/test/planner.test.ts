import assert from "node:assert/strict";
import test from "node:test";

import {
  intentGuidance,
  planRetrieval,
  selectEvidence,
  type EvidenceCandidate,
  type QueryIntent,
} from "../src/index.ts";

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

/**
 * `marginal_gain_floor` is a *relative* threshold because the scores it sees are Reciprocal Rank
 * Fusion output, normalised so the top hit is 1.0. Consecutive RRF ranks then differ by a stable
 * ~1.5% (0.0161 at rank 2, 0.0139 at rank 12, independent of how many retrievers matched).
 *
 * An absolute floor of 0.04 therefore fired at rank 3 for every query regardless of retrieval
 * quality: measured on a 30720-chunk corpus, all 32 evaluation queries returned exactly
 * min_context_k = 2 evidence items and Recall@10 was pinned at 0.2 even though the vector retriever
 * had Recall@10 = 1.0 on its own.
 */
test("normalised fusion scores are not mistaken for diminishing returns", () => {
  const plan = planRetrieval({
    intent: "fact_lookup",
    agent_id: "learning-director",
    token_budget: 8_000,
    estimated_chunk_tokens: 120,
    available_stages: ["lexical", "vector"],
  });

  const rrfConstant = 60;
  const rawScores = Array.from({ length: 16 }, (_, index) => 1 / (rrfConstant + index + 1));
  const candidates = (transform: (score: number, index: number) => number): EvidenceCandidate[] =>
    rawScores.map((score, index) => ({
      id: `c${index}`,
      score: transform(score / rawScores[0]!, index),
      token_count: 120,
      source_type: ["text/markdown", "application/pdf", "text/html", "text/plain"][index % 4]!,
      entity_keys: [`topic.t`, `facet.f${index % 4}`, `depth.${index}`],
      access_allowed: true,
    }));

  // A well-ranked list must fill the context window rather than stop at the minimum.
  const healthy = selectEvidence(candidates((score) => score), plan);
  assert.equal(healthy.candidates.length, plan.context_k);
  assert.equal(healthy.stopped_by, "context_k");

  // A genuine cliff must still truncate, otherwise the floor would be doing nothing at all.
  const cliff = selectEvidence(candidates((score, index) => (index < 3 ? score : score * 0.3)), plan);
  assert.equal(cliff.candidates.length, 3);
  assert.ok(cliff.candidates.length < plan.context_k);

  // The absolute floor stays independent of the relative one.
  const weak = selectEvidence(candidates((score, index) => (index < 2 ? score : 0.1)), plan);
  assert.equal(weak.candidates.length, plan.min_context_k);
  assert.equal(weak.stopped_by, "score_floor");
});

/**
 * `score_floor` and `marginal_gain` must stay distinguishable: one means the next hit was weak in
 * absolute terms, the other that it fell off a cliff relative to what came before. Reporting both as
 * `score_floor` hid which threshold was actually limiting every evidence pack.
 *
 * A plateau is not a cliff. Both score scales in this pipeline produce plateaus of equally relevant
 * candidates — fused scores tie at 1.0000 when both retrievers rank a document first, and rerankers
 * return gaps of 0.00001-0.0024 on near-duplicate text — and stopping there discards correct answers.
 */
test("stopping because of diminishing returns is reported distinctly", () => {
  const plan = planRetrieval({
    intent: "fact_lookup",
    agent_id: "learning-director",
    token_budget: 8_000,
    estimated_chunk_tokens: 120,
    available_stages: ["vector"],
  });
  const build = (score: (index: number) => number): EvidenceCandidate[] =>
    Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      score: score(index),
      token_count: 100,
      source_type: ["text/markdown", "application/pdf", "text/html", "text/plain"][index % 4]!,
      entity_keys: [`topic.t`, `facet.f${index % 4}`, `depth.${index}`],
      access_allowed: true,
    }));

  // A plateau of near-identical scores must be traversed, not mistaken for exhausted relevance.
  const plateau = build((index) => 0.9 - index * 0.0001);
  const traversed = selectEvidence(plateau, plan);
  assert.equal(traversed.candidates.length, plan.context_k);
  assert.equal(traversed.stopped_by, "context_k");
  assert.ok(plateau.every((candidate) => candidate.score > plan.score_floor));

  // Exact ties are the fused-score case: two retrievers agreeing put two candidates at the same score.
  const tied = build((index) => (index < 2 ? 0.9 : 0.9 - (index - 1) * 0.0001));
  const acceptedTie = selectEvidence(tied, plan);
  assert.equal(acceptedTie.candidates.length, plan.context_k);
  assert.equal(acceptedTie.stopped_by, "context_k");

  // A real cliff, still well above score_floor, must truncate and be attributed to marginal_gain.
  const cliff = build((index) => (index < 4 ? 0.9 : 0.55));
  const truncated = selectEvidence(cliff, plan);
  assert.equal(truncated.stopped_by, "marginal_gain");
  assert.equal(truncated.candidates.length, 4);
  assert.ok(cliff.every((candidate) => candidate.score > plan.score_floor));
});

test("intent guidance stays consistent with the plans the planner actually produces", () => {
  // Guidance that drifts from behaviour is worse than none: callers would route by a rule the
  // planner no longer honours. Both facts asserted here are read from real plans, not restated.
  for (const [intent, guidance] of Object.entries(intentGuidance)) {
    const plan = planRetrieval({
      intent: intent as QueryIntent,
      agent_id: "learning-scientist",
      token_budget: 8_000,
      estimated_chunk_tokens: 120,
    });
    assert.equal(guidance.intent, intent);
    assert.equal(
      guidance.requires_structured_query,
      plan.structured_query_required,
      `${intent} guidance disagrees with the plan about structured queries`,
    );
    assert.ok(guidance.selection_rule.length > 0, `${intent} has no selection rule`);
    assert.ok(guidance.misroute_cost.length > 0, `${intent} has no misroute cost`);
  }
  assert.deepEqual(
    Object.keys(intentGuidance).sort(),
    ["comparison", "count_events", "exploratory", "fact_lookup", "multi_hop", "multimodal", "temporal"],
    "every intent needs guidance, otherwise a new intent silently has none",
  );
});

test("the breadth of a plan follows the intent that guidance tells callers to pick", () => {
  // The measured failure was fact_lookup questions routed to exploratory. That only matters because
  // the two plans differ materially; if they ever converge, the routing advice is pointless and this
  // test should be revisited rather than the advice quietly kept.
  const shared = { agent_id: "learning-scientist", token_budget: 8_000, estimated_chunk_tokens: 120 } as const;
  const single = planRetrieval({ intent: "fact_lookup", ...shared });
  const survey = planRetrieval({ intent: "exploratory", ...shared });
  assert.ok(
    survey.candidate_k > single.candidate_k * 1.5,
    "exploratory should retrieve substantially wider than fact_lookup",
  );
  assert.ok(survey.context_k > single.context_k, "exploratory should keep more context than fact_lookup");
});
