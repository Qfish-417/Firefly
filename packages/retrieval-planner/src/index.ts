export type QueryIntent =
  | "fact_lookup"
  | "count_events"
  | "comparison"
  | "multi_hop"
  | "exploratory"
  | "temporal"
  | "multimodal";

export type RetrievalStage = "structured" | "lexical" | "vector" | "graph" | "temporal" | "multimodal";

export interface RetrievalPlannerInput {
  readonly intent: QueryIntent;
  readonly agent_id: "learning-director" | "learning-scientist" | "experience-engineer";
  readonly token_budget: number;
  readonly estimated_chunk_tokens: number;
  readonly available_stages?: readonly RetrievalStage[];
  readonly required_entity_count?: number;
  readonly evidence_coverage_target?: number;
}

export interface RetrievalPlan {
  readonly intent: QueryIntent;
  readonly structured_query_required: boolean;
  readonly answer_source: "rag" | "structured" | "structured_plus_evidence";
  readonly stages: readonly RetrievalStage[];
  readonly candidate_k: number;
  readonly fusion_k: number;
  readonly rerank_k: number;
  readonly context_k: number;
  readonly min_context_k: number;
  readonly max_context_tokens: number;
  readonly score_floor: number;
  readonly marginal_gain_floor: number;
  /**
   * Minimum score a candidate must hold relative to the best candidate of this same query, as a
   * fraction. Intended to make pack size adapt to the query rather than to `context_k`.
   *
   * **Defaults to 0 (disabled) on every intent, because measurement showed it costs recall.** Kept
   * because the mechanism is sound and a retriever with better-separated scores could use it; the
   * calibration, not the idea, is what failed.
   *
   * It does close a real blind spot in `marginal_gain_floor`, which only compares a candidate to its
   * immediate predecessor: under scores decaying 8% per rank, every consecutive step stays under that
   * floor while selection runs to `context_k = 11` and accepts a candidate worth 43% of the best.
   * Comparing against the best score makes that visible.
   *
   * But on the 31968-chunk corpus with per-query relevant sets of 12-96, enabling it at 0.84 was a
   * net loss:
   *
   *   relative_floor  evidence  R@10   facet@10  citation precision
   *   0               9.8       0.909  0.758     0.994
   *   0.84            9.4       0.894  0.734     1.000
   *
   * It bought 0.6% citation precision for 1.7% recall and 3.2% facet coverage.
   *
   * The calibration error is worth recording: 0.84 came from the `score/best` distribution of
   * *already-selected evidence* (relevant candidates at the 5th percentile held 0.872). But this gate
   * runs over the *candidate window*, where relevant candidates sit at 0.495 at the 5th percentile.
   * Deriving a pre-selection threshold from post-selection scores is circular — the evidence is
   * already the high-scoring subset the selector kept — and 0.84 therefore discarded 30% of relevant
   * candidates. Re-measured on the candidate window, no single ratio separates the classes cleanly:
   * 0.50 keeps 94.0% of relevant candidates but also 23.7% of non-relevant ones, and the two
   * distributions overlap in 0.4-0.5.
   *
   * Making this useful needs a signal that is not a fraction of the top score — absolute reranker
   * relevance, or a per-query estimate of how many relevant documents exist.
   */
  readonly relative_floor: number;
  readonly evidence_coverage_target: number;
}

export interface EvidenceCandidate {
  readonly id: string;
  readonly score: number;
  readonly token_count: number;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly access_allowed: boolean;
}

export interface SelectedEvidence {
  readonly candidates: readonly EvidenceCandidate[];
  readonly used_tokens: number;
  /**
   * Why selection stopped. `score_floor` and `marginal_gain` are distinct on purpose: the first means
   * the next hit was weak in absolute terms, the second that it was merely not much better than the
   * previous one. Collapsing them hides which threshold is actually limiting the evidence pack.
   */
  readonly stopped_by: "context_k" | "token_budget" | "score_floor" | "marginal_gain" | "relative_floor" | "exhausted";
}

interface IntentDefaults {
  readonly candidate_k: number;
  readonly fusion_k: number;
  readonly rerank_k: number;
  readonly context_k: number;
  /**
   * Absolute score below which evidence is dropped once `min_context_k` is met.
   *
   * Only bites when scores are on an absolute scale. Reciprocal Rank Fusion output is normalised so
   * the top hit is 1.0, and rank `context_k` still sits at 0.92 (fact_lookup) or 0.82 (exploratory),
   * far above any of these floors — so on a fusion-only pipeline this threshold never fires and
   * `marginal_gain_floor` is what actually limits the pack.
   *
   * This threshold has **never fired in any measured scenario**: across 11 scenarios x 32 queries
   * (352 selections) the stop reasons were `context_k` 287, `marginal_gain` 61, `exhausted` 4, and
   * `score_floor` 0.
   *
   * An earlier version of this comment claimed the floor becomes "the operative guard" once a
   * reranker replaces the scores. That was wrong, and the reranked scenarios disprove it: all 32
   * queries in each of `hybrid-natural-rerank`, `hybrid-tokenized-rerank` and
   * `vector-only-natural-rerank` stopped on `context_k`. The reason is ordering, not score scale —
   * `context_k` (6 for fact_lookup) is reached before the candidate list ever descends to a score
   * this low, so the floor is unreachable regardless of how the scores are produced.
   *
   * It is kept because it is the only guard that is absolute rather than relative, and a future
   * retriever with genuinely calibrated scores would need it. But it is currently untested in
   * production terms: no measurement has exercised this path.
   */
  readonly score_floor: number;
  /**
   * How large a *relative* drop counts as a score cliff, as a fraction of the previous score. Once
   * `min_context_k` is met, a candidate this much worse than the last accepted one stops selection.
   *
   * Calibrated between the two gap regimes measured on a 30720-chunk corpus:
   *
   *   0.0143-0.0161  consecutive ranks within a plateau, on both normalised fusion output and
   *                  reranker output. Every candidate here was relevant, so stopping is pure loss.
   *   0.3896-0.4639  where retriever agreement falls from two to one, i.e. the point past which only
   *                  a single retriever vouched for the document.
   *
   * These values sit between the two, so plateaus are traversed and real cliffs truncate. The wide
   * margin is deliberate: the boundary is twenty-five times clear of plateau noise, so the exact
   * number does not need to be delicate.
   */
  readonly marginal_gain_floor: number;
  readonly relative_floor: number;
  readonly structured_query_required: boolean;
  readonly answer_source: RetrievalPlan["answer_source"];
  readonly stages: readonly RetrievalStage[];
}

const defaults: Readonly<Record<QueryIntent, IntentDefaults>> = {
  /**
   * `context_k` and `rerank_k` were raised from 6/10 after measuring that the retrieval side was
   * losing nothing and the selection side was discarding most of what it found.
   *
   * At `candidate_k = 16` the union of the lexical and vector retrievers already contains **all 12**
   * relevant chunks for every query in the 31104-chunk corpus. Raising `candidate_k` to 64 grows the
   * union from 16.7 to 66.8 candidates while relevant hits stay at exactly 12.0 — pure noise. So the
   * retrievers were never the constraint.
   *
   * `context_k = 6` was. Recall@10 at the evidence layer is bounded by
   * `min(context_k, relevant_total) / relevant_total`, which caps it at 6/12 = 0.500 no matter how
   * good retrieval is; measured 0.492, i.e. already at that ceiling. Widening the selection window:
   *
   *   context_k  rerank_k  evidence  R@10   facet@10  citation precision
   *   6          10        5.9       0.492  0.820     1.000
   *   11         18        10.1      0.794  0.977     0.991
   *   14         24        10.8      0.794  0.977     0.955
   *   17         29        11.4      0.794  0.977     0.930
   *
   * Recall saturates at 0.794 (95% of the 10/12 = 0.833 ceiling for k=10) while citation precision
   * decays monotonically past that point, because once the window exceeds the relevant set every
   * further slot must be filled with a non-relevant chunk. 11/18 sits at the knee: +61% Recall@10 and
   * +19% facet coverage for -0.9% citation precision.
   */
  fact_lookup: {
    candidate_k: 24,
    fusion_k: 36,
    rerank_k: 18,
    context_k: 11,
    score_floor: 0.42,
    marginal_gain_floor: 0.15,
    relative_floor: 0,
    structured_query_required: false,
    answer_source: "rag",
    stages: ["lexical", "vector"],
  },
  count_events: {
    candidate_k: 24,
    fusion_k: 40,
    rerank_k: 16,
    context_k: 8,
    score_floor: 0.35,
    marginal_gain_floor: 0.25,
    relative_floor: 0,
    structured_query_required: true,
    answer_source: "structured_plus_evidence",
    stages: ["structured", "lexical", "temporal"],
  },
  comparison: {
    candidate_k: 24,
    fusion_k: 48,
    rerank_k: 18,
    context_k: 10,
    score_floor: 0.38,
    marginal_gain_floor: 0.20,
    relative_floor: 0,
    structured_query_required: true,
    answer_source: "structured_plus_evidence",
    stages: ["structured", "lexical", "vector", "temporal"],
  },
  multi_hop: {
    candidate_k: 28,
    fusion_k: 56,
    rerank_k: 20,
    context_k: 12,
    score_floor: 0.36,
    marginal_gain_floor: 0.25,
    relative_floor: 0,
    structured_query_required: true,
    answer_source: "structured_plus_evidence",
    stages: ["structured", "lexical", "vector", "graph", "temporal"],
  },
  exploratory: {
    candidate_k: 36,
    fusion_k: 72,
    rerank_k: 24,
    context_k: 14,
    score_floor: 0.3,
    marginal_gain_floor: 0.30,
    relative_floor: 0,
    structured_query_required: false,
    answer_source: "rag",
    stages: ["lexical", "vector", "graph"],
  },
  temporal: {
    candidate_k: 24,
    fusion_k: 48,
    rerank_k: 18,
    context_k: 10,
    score_floor: 0.4,
    marginal_gain_floor: 0.20,
    relative_floor: 0,
    structured_query_required: true,
    answer_source: "structured_plus_evidence",
    stages: ["structured", "temporal", "lexical", "vector"],
  },
  multimodal: {
    candidate_k: 28,
    fusion_k: 56,
    rerank_k: 20,
    context_k: 10,
    score_floor: 0.34,
    marginal_gain_floor: 0.25,
    relative_floor: 0,
    structured_query_required: false,
    answer_source: "rag",
    stages: ["multimodal", "lexical", "vector"],
  },
};

/**
 * What each intent is for, and what choosing it wrongly costs.
 *
 * This exists because `intent` is caller-supplied and nothing in the codebase described how to
 * choose it — every caller had to infer the taxonomy from the `defaults` table above. Measured on a
 * routing suite of 12 requests x 3 samples, the boundary that actually gets confused is
 * `fact_lookup` vs `exploratory`: a single-mechanism question ("what does rising temperature do to
 * output power?") routed to `exploratory` on 3 of 3 samples, which triples candidate_k (20 -> 44)
 * and doubles context_k (8 -> 17) for a question that has one answer. The structured intents were
 * never confused, because their trigger words are explicit.
 *
 * `selection_rule` is deliberately a *discriminating* rule rather than a description: "asks about
 * one thing" versus "must enumerate several things" is what separates the two RAG intents, and
 * stating it as a contrast is what a caller — or a model choosing a route — actually needs.
 */
export interface IntentGuidance {
  readonly intent: QueryIntent;
  readonly selection_rule: string;
  readonly requires_structured_query: boolean;
  /** What goes wrong when this intent is chosen and another was correct. */
  readonly misroute_cost: string;
}

export const intentGuidance: Readonly<Record<QueryIntent, IntentGuidance>> = {
  fact_lookup: {
    intent: "fact_lookup",
    selection_rule:
      "The question has one answer: a definition, a value, a mechanism or a cause. Choose this even when the answer needs several sentences, as long as the question asks about a single thing.",
    requires_structured_query: false,
    misroute_cost:
      "Sending a single-answer question to exploratory retrieves roughly twice the evidence for no gain in correctness, spending context budget a fuller answer could have used.",
  },
  count_events: {
    intent: "count_events",
    selection_rule:
      "The question asks how many times something happened for one subject. Requires subject_id and event_type.",
    requires_structured_query: true,
    misroute_cost:
      "Counting by reading retrieved text undercounts whenever the true count exceeds the retrieval window, and states a confident number while doing so.",
  },
  comparison: {
    intent: "comparison",
    selection_rule:
      "The question contrasts two named subjects on the same event type: which is larger, or by how much.",
    requires_structured_query: true,
    misroute_cost:
      "Two counts subtracted afterwards are not guaranteed to share one visibility snapshot, so the difference can disagree with both counts it came from.",
  },
  multi_hop: {
    intent: "multi_hop",
    selection_rule:
      "The question asks how two named entities are connected, or asks for the chain between them.",
    requires_structured_query: true,
    misroute_cost:
      "Text similarity returns documents mentioning both entities without establishing any relation, which reads as an answer while asserting a connection nothing verified.",
  },
  exploratory: {
    intent: "exploratory",
    selection_rule:
      "The question asks for breadth: every factor, all causes, a survey, an overview. The giveaway is that a complete answer must enumerate several distinct items.",
    requires_structured_query: false,
    misroute_cost:
      "Sending a survey question to fact_lookup silently truncates the enumeration, so the answer looks well-formed while omitting most of what was asked for.",
  },
  temporal: {
    intent: "temporal",
    selection_rule:
      "The question asks when something happened: the first or the most recent occurrence. Requires subject_id, event_type and a first/last selector.",
    requires_structured_query: true,
    misroute_cost:
      "Getting the selector backwards returns a real timestamp for the opposite occurrence, which no downstream check can detect.",
  },
  multimodal: {
    intent: "multimodal",
    selection_rule:
      "Answering requires non-text sources: images, audio, diagrams or scanned pages.",
    requires_structured_query: false,
    misroute_cost:
      "Text-only retrieval reports insufficient evidence for material that exists in another modality.",
  },
};

export function planRetrieval(input: RetrievalPlannerInput): RetrievalPlan {
  validateInput(input);
  const base = defaults[input.intent];
  const agentMultiplier = input.agent_id === "learning-scientist" ? 1.2 : input.agent_id === "experience-engineer" ? 0.85 : 1;
  const entityMultiplier = Math.min(1.5, 1 + Math.max(0, (input.required_entity_count ?? 1) - 1) * 0.12);
  const multiplier = agentMultiplier * entityMultiplier;
  const tokenCapacity = Math.max(1, Math.floor((input.token_budget * 0.7) / input.estimated_chunk_tokens));
  const maxContextTokens = Math.max(input.estimated_chunk_tokens, Math.floor(input.token_budget * 0.7));
  const stages = (input.available_stages ? base.stages.filter((stage) => input.available_stages!.includes(stage)) : base.stages);
  const effectiveStages = stages.length > 0 ? stages : base.stages.slice(0, 1);
  return {
    intent: input.intent,
    structured_query_required: base.structured_query_required,
    answer_source: base.answer_source,
    stages: effectiveStages,
    candidate_k: clamp(Math.ceil(base.candidate_k * multiplier), 1, 100),
    fusion_k: clamp(Math.ceil(base.fusion_k * multiplier), 1, 150),
    rerank_k: clamp(Math.ceil(base.rerank_k * multiplier), 1, 50),
    context_k: clamp(Math.min(Math.ceil(base.context_k * multiplier), tokenCapacity), 1, 30),
    min_context_k: Math.min(input.intent === "count_events" ? 3 : 2, Math.max(1, tokenCapacity)),
    max_context_tokens: maxContextTokens,
    score_floor: base.score_floor,
    marginal_gain_floor: base.marginal_gain_floor,
    relative_floor: base.relative_floor,
    evidence_coverage_target: clamp(input.evidence_coverage_target ?? (base.structured_query_required ? 0.95 : 0.8), 0, 1),
  };
}

export function selectEvidence(
  candidates: readonly EvidenceCandidate[],
  plan: RetrievalPlan,
): SelectedEvidence {
  const ordered = candidates
    .filter((candidate) => candidate.access_allowed && Number.isFinite(candidate.score) && candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  const selected: EvidenceCandidate[] = [];
  const seenEntities = new Set<string>();
  let usedTokens = 0;
  let stoppedBy: SelectedEvidence["stopped_by"] = "exhausted";
  let previousScore = Number.POSITIVE_INFINITY;
  // `ordered` is sorted by score, so the first entry is this query's best. Captured before the loop
  // because the comparison must not drift as candidates are accepted.
  const bestScore = ordered[0]?.score ?? 0;
  for (const candidate of ordered) {
    if (selected.length >= plan.context_k) {
      stoppedBy = "context_k";
      break;
    }
    if (selected.length >= plan.min_context_k && candidate.score < plan.score_floor) {
      stoppedBy = "score_floor";
      break;
    }
    // Stop when the next candidate is *substantially worse* than the last accepted one, measured as a
    // fraction of that score so the test does not depend on whatever scale the upstream stage emits.
    //
    // The comparison is `>=`, and that direction is the whole point. The obvious formulation — stop
    // when the gap is *smaller* than the floor — inverts the question: it stops on ties and plateaus,
    // which are precisely the cases where every candidate deserves to be kept. Both score scales this
    // pipeline produces hit that trap:
    //
    //   Fused scores are Reciprocal Rank Fusion output normalised so the top hit is 1.0. A document
    //   found by both retrievers scores roughly twice one found by a single retriever, so the top two
    //   frequently tie at exactly 1.0000. A gap of zero is below any positive floor, so selection
    //   stopped at rank 2 on 27 of 32 measured queries — reported as "diminishing returns" when the
    //   real situation was two equally strong hits.
    //
    //   Reranked scores are absolute relevance, and on near-duplicate candidates a reranker returns a
    //   plateau: measured consecutive gaps of 0.00001-0.0024 across a window whose every member was
    //   relevant. That truncated all 32 queries to min_context_k, dropping nDCG@10 from 0.411 to
    //   0.237 and making a correctly-ranking reranker look harmful.
    //
    // A real cliff is unmistakable and does not need a delicate threshold: where retriever agreement
    // falls from two to one, the measured gap is 0.39-0.46, twenty-five times the 0.0143-0.0161 gap
    // within a plateau. So the floors stay small — they only have to sit above plateau noise.
    if (
      selected.length >= plan.min_context_k &&
      previousScore > 0 &&
      (previousScore - candidate.score) / previousScore >= plan.marginal_gain_floor
    ) {
      stoppedBy = "marginal_gain";
      break;
    }
    // Adaptive stop: compare against the best candidate of *this* query rather than the previous one.
    //
    // This is what makes the pack size respond to the query instead of to `context_k`. Comparing with
    // the predecessor resets at every accepted candidate, so slow monotonic decay slips through: with
    // scores decaying 8% per rank, `marginal_gain_floor` never fired and selection ran to
    // `context_k = 11` with the last accepted candidate at 43% of the first. Measured against the best
    // score, that candidate is visibly out of contention.
    //
    // Calibrated on 31104 chunks, 419 fused candidates with graded labels: relevant candidates hold
    // `score/best` >= 0.872 at the 5th percentile, non-relevant ones <= 0.836 at the 95th. The two
    // distributions barely overlap, and 0.84 keeps 100% of relevant candidates while admitting 3.3%
    // of non-relevant ones. Raising it to 0.86 would drop 2.1% of relevant evidence to shed the
    // remaining 3.3%, which is the wrong trade for a recall-oriented pack.
    if (bestScore > 0 && selected.length >= plan.min_context_k && candidate.score / bestScore < plan.relative_floor) {
      stoppedBy = "relative_floor";
      break;
    }
    if (usedTokens + candidate.token_count > plan.max_context_tokens) {
      stoppedBy = "token_budget";
      break;
    }
    const introducesEntity = (candidate.entity_keys ?? []).some((key) => !seenEntities.has(key));
    if (selected.length > 0 && !introducesEntity && candidate.source_type === selected[0]?.source_type) {
      continue;
    }
    selected.push(candidate);
    usedTokens += candidate.token_count;
    for (const key of candidate.entity_keys ?? []) seenEntities.add(key);
    previousScore = candidate.score;
  }
  return { candidates: selected, used_tokens: usedTokens, stopped_by: stoppedBy };
}

function validateInput(input: RetrievalPlannerInput): void {
  if (!Number.isFinite(input.token_budget) || !Number.isFinite(input.estimated_chunk_tokens) ||
    input.token_budget <= 0 || input.estimated_chunk_tokens <= 0) {
    throw new RangeError("token_budget and estimated_chunk_tokens must be positive finite numbers");
  }
  // A non-finite count produces candidate_k = NaN, which reaches SQL as `LIMIT NaN` and makes every
  // retriever fail. The plan must never carry a value it cannot compute a limit from.
  if (input.required_entity_count !== undefined &&
    (!Number.isInteger(input.required_entity_count) || input.required_entity_count < 1 || input.required_entity_count > 1_000)) {
    throw new RangeError("required_entity_count must be an integer between 1 and 1000");
  }
  if (input.evidence_coverage_target !== undefined && !Number.isFinite(input.evidence_coverage_target)) {
    throw new RangeError("evidence_coverage_target must be a finite number");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
