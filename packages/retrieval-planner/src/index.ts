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
  readonly stopped_by: "context_k" | "token_budget" | "score_floor" | "exhausted";
}

interface IntentDefaults {
  readonly candidate_k: number;
  readonly fusion_k: number;
  readonly rerank_k: number;
  readonly context_k: number;
  readonly score_floor: number;
  readonly marginal_gain_floor: number;
  readonly structured_query_required: boolean;
  readonly answer_source: RetrievalPlan["answer_source"];
  readonly stages: readonly RetrievalStage[];
}

const defaults: Readonly<Record<QueryIntent, IntentDefaults>> = {
  fact_lookup: {
    candidate_k: 16,
    fusion_k: 24,
    rerank_k: 10,
    context_k: 6,
    score_floor: 0.42,
    marginal_gain_floor: 0.04,
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
    marginal_gain_floor: 0.02,
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
    marginal_gain_floor: 0.03,
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
    marginal_gain_floor: 0.025,
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
    marginal_gain_floor: 0.02,
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
    marginal_gain_floor: 0.03,
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
    marginal_gain_floor: 0.025,
    structured_query_required: false,
    answer_source: "rag",
    stages: ["multimodal", "lexical", "vector"],
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
  for (const candidate of ordered) {
    if (selected.length >= plan.context_k) {
      stoppedBy = "context_k";
      break;
    }
    if (selected.length >= plan.min_context_k && candidate.score < plan.score_floor) {
      stoppedBy = "score_floor";
      break;
    }
    if (selected.length >= plan.min_context_k && previousScore - candidate.score < plan.marginal_gain_floor) {
      stoppedBy = "score_floor";
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
  if (input.token_budget <= 0 || input.estimated_chunk_tokens <= 0) {
    throw new RangeError("token_budget and estimated_chunk_tokens must be positive");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
