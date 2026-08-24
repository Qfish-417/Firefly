import {
  assertContract,
  type EvidenceCitation,
  type EvidenceItem,
  type EvidencePack,
  type QueryPlan,
  type StructuredResult,
} from "@firefly/contracts";
import {
  planRetrieval,
  selectEvidence,
  type QueryIntent,
  type RetrievalStage,
} from "@firefly/retrieval-planner";
import type { GenerationRequest, GenerationResult, ModelBudget, RerankPort, RerankResult } from "@firefly/model-gateway";

export type {
  EvidenceCitation,
  EvidenceItem,
  EvidencePack,
  QueryPlan,
  StructuredResult,
} from "@firefly/contracts";
export * from "./http-api.ts";

export type SearchStage = Exclude<RetrievalStage, "structured">;

export interface RetrievalPrincipal {
  readonly tenant_id: string;
  readonly user_id?: string;
  readonly agent_id?: string;
  readonly session_id?: string;
  readonly role_ids?: readonly string[];
}

export interface RetrievalRequest {
  readonly query_id: string;
  readonly original_query: string;
  readonly intent: QueryIntent;
  readonly agent_id: "learning-director" | "learning-scientist" | "experience-engineer";
  readonly principal: RetrievalPrincipal;
  readonly purpose: string;
  readonly token_budget: number;
  readonly estimated_chunk_tokens: number;
  readonly required_entity_count?: number;
  readonly evidence_coverage_target?: number;
  readonly require_citations: boolean;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly structured_filters?: {
    readonly subject_id?: string;
    readonly event_type?: string;
    readonly from?: string;
    readonly to?: string;
    readonly include_conflicts?: boolean;
  };
  readonly structured_query?:
    | {
        readonly kind: "compare_event_counts";
        readonly left_subject_id: string;
        readonly right_subject_id: string;
        readonly event_type: string;
        readonly from?: string;
        readonly to?: string;
        readonly include_conflicts?: boolean;
      }
    | {
        readonly kind: "select_event_time";
        readonly subject_id: string;
        readonly event_type: string;
        readonly selector: "first" | "last";
        readonly from?: string;
        readonly to?: string;
        readonly include_conflicts?: boolean;
      }
    | {
        readonly kind: "find_relation_path";
        readonly start_node_id: string;
        readonly target_node_id: string;
        readonly predicates?: readonly string[];
        readonly direction: "outbound" | "inbound" | "both";
        readonly max_hops: number;
        readonly as_of: string;
        readonly include_conflicts?: boolean;
      };
}

export interface RetrievalHit {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  readonly token_count: number;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly citation: EvidenceCitation;
}

export interface RetrieverCall {
  readonly query_id: string;
  readonly query: string;
  readonly principal: RetrievalPrincipal;
  readonly purpose: string;
  readonly max_results: number;
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
}

export interface Retriever {
  readonly id: string;
  readonly stage: SearchStage;
  retrieve(call: RetrieverCall): Promise<readonly RetrievalHit[]>;
}

export interface RetrievalAuthorizationPort {
  canRead(input: {
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly hit: RetrievalHit;
  }): boolean | Promise<boolean>;
  /**
   * Optional batch form of {@link canRead}, returning the subset of hit ids the principal may read.
   *
   * Re-checking authorization per candidate is one round trip each: measured against PostgreSQL, 24
   * candidates cost 54.7ms serially versus 3.5ms as a single statement, a third of `fact_lookup`
   * end-to-end latency spent queueing identical queries. Implementations that can answer in one
   * statement should provide this; the gateway falls back to `canRead` when it is absent, so an
   * adapter is never obliged to implement both.
   *
   * The contract is deliberately "return what is allowed" rather than "return a verdict per hit": a
   * backend that cannot decide must omit the id, so a partial answer fails closed by construction.
   */
  canReadAll?(input: {
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly hits: readonly RetrievalHit[];
  }): ReadonlySet<string> | Promise<ReadonlySet<string>>;
}

export interface StructuredAggregatorPort {
  aggregate(input: {
    readonly request: RetrievalRequest;
    readonly signal?: AbortSignal;
  }): Promise<StructuredResult>;
}

export interface EvidenceExpansionPort {
  expand(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_tokens: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly RetrievalHit[]>;
}

export type EvidenceExpansionRelation = "neighbor" | "region" | "entity" | "temporal";

const expansionRelations: readonly EvidenceExpansionRelation[] = ["neighbor", "region", "entity", "temporal"];

export interface EvidenceExpansionCandidate {
  readonly anchor_id: string;
  readonly relation: EvidenceExpansionRelation;
  readonly hit: RetrievalHit;
}

export interface EvidenceExpansionCandidateSource {
  listCandidates(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_candidates_per_anchor: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly EvidenceExpansionCandidate[]>;
}

export interface DeterministicEvidenceExpanderOptions {
  readonly candidates: readonly EvidenceExpansionCandidate[];
  readonly relation_order?: readonly EvidenceExpansionRelation[];
  readonly max_candidates_per_anchor?: number;
}

/** Provider-neutral expansion ordering and budget policy. */
export class DeterministicEvidenceExpander implements EvidenceExpansionPort {
  private readonly byAnchor: ReadonlyMap<string, readonly EvidenceExpansionCandidate[]>;
  private readonly relationRank: ReadonlyMap<EvidenceExpansionRelation, number>;
  private readonly maxCandidatesPerAnchor: number;

  constructor(options: DeterministicEvidenceExpanderOptions) {
    const order = options.relation_order ?? ["region", "neighbor", "entity", "temporal"];
    if (new Set(order).size !== order.length || order.some((relation) => !isExpansionRelation(relation))) {
      throw new RetrievalPolicyError("Expansion relation order must contain each relation at most once");
    }
    const maxCandidates = options.max_candidates_per_anchor ?? 8;
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
      throw new RetrievalPolicyError("max_candidates_per_anchor must be between 1 and 100");
    }
    const grouped = new Map<string, EvidenceExpansionCandidate[]>();
    for (const candidate of options.candidates) {
      if (!candidate.anchor_id || !isExpansionRelation(candidate.relation) || !validHit(candidate.hit)) {
        throw new RetrievalPolicyError("Expansion candidates require an anchor, relation and valid hit");
      }
      const list = grouped.get(candidate.anchor_id) ?? [];
      list.push(candidate);
      grouped.set(candidate.anchor_id, list);
    }
    this.byAnchor = new Map([...grouped.entries()].map(([anchor, candidates]) => [anchor, [...candidates]]));
    this.relationRank = new Map(order.map((relation, index) => [relation, index]));
    this.maxCandidatesPerAnchor = maxCandidates;
  }

  async expand(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_tokens: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly RetrievalHit[]> {
    input.signal?.throwIfAborted();
    if (!input.purpose.trim() || !Number.isInteger(input.max_tokens) || input.max_tokens <= 0) {
      throw new RetrievalPolicyError("Context expansion requires purpose and a positive token budget");
    }
    const selected = new Map<string, RetrievalHit>();
    let usedTokens = 0;
    for (const hit of input.hits) {
      if (!validHit(hit)) throw new RetrievalPolicyError("Expansion input contains an invalid hit");
      if (selected.has(hit.id)) continue;
      usedTokens += hit.token_count;
      selected.set(hit.id, hit);
    }
    if (usedTokens > input.max_tokens) throw new RetrievalPolicyError("Context expansion input exceeds token budget");
    for (const anchor of input.hits) {
      const candidates = [...(this.byAnchor.get(anchor.id) ?? [])]
        .sort((left, right) =>
          (this.relationRank.get(left.relation) ?? Number.MAX_SAFE_INTEGER) -
            (this.relationRank.get(right.relation) ?? Number.MAX_SAFE_INTEGER) ||
          right.hit.score - left.hit.score ||
          compareIds(left.hit.id, right.hit.id),
        )
        .slice(0, this.maxCandidatesPerAnchor);
      for (const candidate of candidates) {
        input.signal?.throwIfAborted();
        const existing = selected.get(candidate.hit.id);
        if (existing) {
          if (
            existing.content !== candidate.hit.content ||
            existing.citation.uri !== candidate.hit.citation.uri ||
            existing.citation.digest !== candidate.hit.citation.digest
          ) {
            throw new RetrievalPolicyError(`Expanded evidence ID ${candidate.hit.id} has conflicting immutable content`);
          }
          continue;
        }
        if (candidate.hit.token_count > input.max_tokens - usedTokens) continue;
        selected.set(candidate.hit.id, candidate.hit);
        usedTokens += candidate.hit.token_count;
      }
    }
    return [...selected.values()];
  }
}

export interface CandidateSourceEvidenceExpanderOptions {
  readonly relation_order?: readonly EvidenceExpansionRelation[];
  readonly max_candidates_per_anchor?: number;
}

/** Resolves provider candidates through the shared deterministic policy. */
export class CandidateSourceEvidenceExpander implements EvidenceExpansionPort {
  private readonly source: EvidenceExpansionCandidateSource;
  private readonly relationOrder: readonly EvidenceExpansionRelation[];
  private readonly maxCandidatesPerAnchor: number;

  constructor(source: EvidenceExpansionCandidateSource, options: CandidateSourceEvidenceExpanderOptions = {}) {
    this.source = source;
    this.relationOrder = options.relation_order ?? ["region", "neighbor", "entity", "temporal"];
    this.maxCandidatesPerAnchor = options.max_candidates_per_anchor ?? 8;
    if (
      new Set(this.relationOrder).size !== this.relationOrder.length ||
      this.relationOrder.some((relation) => !isExpansionRelation(relation)) ||
      !Number.isInteger(this.maxCandidatesPerAnchor) ||
      this.maxCandidatesPerAnchor < 1 ||
      this.maxCandidatesPerAnchor > 100
    ) {
      throw new RetrievalPolicyError("Invalid evidence expansion source policy");
    }
  }

  async expand(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_tokens: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly RetrievalHit[]> {
    input.signal?.throwIfAborted();
    const candidates = await this.source.listCandidates({
      hits: input.hits,
      principal: input.principal,
      purpose: input.purpose,
      max_candidates_per_anchor: this.maxCandidatesPerAnchor,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return new DeterministicEvidenceExpander({
      candidates,
      relation_order: this.relationOrder,
      max_candidates_per_anchor: this.maxCandidatesPerAnchor,
    }).expand(input);
  }
}

/**
 * Rewrites a query into a hypothetical answer passage (HyDE) so lexical matching has real terms to
 * work with.
 *
 * This exists for one measured failure: PostgreSQL's `simple` configuration does not segment CJK, so
 * the bigram path requires at least 2 matching bigrams and very short Chinese questions cannot produce
 * them. 4 of 32 natural-language queries returned zero lexical rows for that reason.
 *
 * It is deliberately **not** a global query transform. Measured on all 32 queries, rewriting every
 * query cost more than it bought:
 *
 *   lexical  P@10 0.875 -> 0.750, MRR 0.875 -> 0.750, zero-result 4 -> 0
 *   vector   P@10 1.000 -> 0.969, facet coverage 0.367 -> 0.414
 *
 * plus one extra model call per query (+958ms p50, +104 tokens) against a 401ms end-to-end budget.
 * Trading a 4/32 recall hole for a 14% precision loss on the other 28 queries is a bad trade, so the
 * gateway only consults this port when retrieval actually came back empty.
 */
export interface QueryRewritePort {
  rewrite(input: {
    readonly query_id: string;
    readonly original_query: string;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface HypotheticalAnswerRewriterOptions {
  readonly generate: (request: GenerationRequest) => Promise<GenerationResult>;
  readonly workload: string;
  readonly budget: ModelBudget;
  readonly max_output_tokens?: number;
  readonly prompt_snapshot?: string;
}

/**
 * HyDE rewriter: turns a question into a short declarative passage that reads like an answer, so
 * lexical search has domain terms to match instead of a bare interrogative.
 *
 * Measured recovery on the 4 CJK queries that produced zero lexical rows
 * ("斜射光损失为什么更大", "PID 是什么条件下发生的", "热斑是怎么形成的", "PR 值是什么意思"):
 * all 4 returned results after rewriting. The passage is capped short on purpose — a long generation
 * drifts into terms the corpus does not contain and pulls in unrelated documents.
 */
export class HypotheticalAnswerRewriter implements QueryRewritePort {
  private readonly options: HypotheticalAnswerRewriterOptions;

  constructor(options: HypotheticalAnswerRewriterOptions) {
    this.options = options;
  }

  async rewrite(input: { readonly query_id: string; readonly original_query: string; readonly signal?: AbortSignal }): Promise<string> {
    const result = await this.options.generate({
      request_id: `hyde.${input.query_id}`,
      workload: this.options.workload,
      system_prompt: [
        "你是检索助手。针对用户问题，写一段简短的假想答案。",
        "只用陈述句，包含该领域的专业术语。不要提问，不要解释，直接输出段落。",
        "控制在 80 字以内。",
      ].join(String.fromCharCode(10)),
      user_prompt: `问题：${input.original_query}`,
      max_output_tokens: this.options.max_output_tokens ?? 256,
      budget: this.options.budget,
      snapshots: {
        prompt: this.options.prompt_snapshot ?? "retrieval.hyde.v1",
        tools: "none",
        knowledge: input.query_id,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return typeof result.text === "string" ? result.text.trim() : "";
  }
}

export interface RetrievalGatewayOptions {
  readonly retrievers: readonly Retriever[];
  readonly authorization: RetrievalAuthorizationPort;
  readonly aggregator?: StructuredAggregatorPort;
  readonly expander?: EvidenceExpansionPort;
  readonly reranker?: RerankPort;
  readonly reranker_budget?: ModelBudget;
  readonly reranker_failure_mode?: "fallback" | "strict";
  readonly rrf_constant?: number;
  /**
   * Consulted only when every retriever returned nothing. See {@link QueryRewritePort} for why this
   * is a fallback rather than a preprocessing step.
   */
  readonly query_rewriter?: QueryRewritePort;
}

/**
 * Retrieval could not be carried out. Distinct from `RetrievalPolicyError` (the caller asked for
 * something disallowed) and from an empty pack (retrieval worked and found nothing).
 */
export class RetrievalUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetrievalUnavailableError";
  }
}

export class RetrievalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalPolicyError";
  }
}

export class RetrievalGateway {
  private readonly retrievers: ReadonlyMap<SearchStage, Retriever>;
  private readonly authorization: RetrievalAuthorizationPort;
  private readonly aggregator: StructuredAggregatorPort | undefined;
  private readonly expander: EvidenceExpansionPort | undefined;
  private readonly reranker: RerankPort | undefined;
  private readonly rerankerBudget: ModelBudget;
  private readonly rerankerFailureMode: "fallback" | "strict";
  private readonly rrfConstant: number;
  private readonly queryRewriter: QueryRewritePort | undefined;

  constructor(options: RetrievalGatewayOptions) {
    this.retrievers = new Map(options.retrievers.map((retriever) => [retriever.stage, retriever]));
    if (this.retrievers.size !== options.retrievers.length) {
      throw new RetrievalPolicyError("Only one Retriever may own a search stage");
    }
    this.authorization = options.authorization;
    this.aggregator = options.aggregator;
    this.expander = options.expander;
    this.reranker = options.reranker;
    this.rerankerBudget = options.reranker_budget ?? { max_tokens: 32_000, max_cost_usd: 0, max_duration_ms: 10_000 };
    this.queryRewriter = options.query_rewriter;
    this.rerankerFailureMode = options.reranker_failure_mode ?? "fallback";
    this.rrfConstant = options.rrf_constant ?? 60;
    if (this.rrfConstant <= 0) throw new RetrievalPolicyError("rrf_constant must be positive");
    if (!Number.isSafeInteger(this.rerankerBudget.max_tokens) || this.rerankerBudget.max_tokens < 1 || !Number.isFinite(this.rerankerBudget.max_cost_usd) || this.rerankerBudget.max_cost_usd < 0 || !Number.isSafeInteger(this.rerankerBudget.max_duration_ms) || this.rerankerBudget.max_duration_ms < 1) {
      throw new RetrievalPolicyError("reranker_budget is invalid");
    }
  }

  async retrieve(request: RetrievalRequest, signal?: AbortSignal): Promise<EvidencePack> {
    validateRequest(request, signal);
    const searchStages = [...this.retrievers.keys()];
    const plannedRetrieval = planRetrieval({
      intent: request.intent,
      agent_id: request.agent_id,
      token_budget: request.token_budget,
      estimated_chunk_tokens: request.estimated_chunk_tokens,
      available_stages: [
        ...(this.aggregator ? (["structured"] as const) : []),
        ...searchStages,
      ],
      ...(request.required_entity_count === undefined ? {} : { required_entity_count: request.required_entity_count }),
      ...(request.evidence_coverage_target === undefined
        ? {}
        : { evidence_coverage_target: request.evidence_coverage_target }),
    });
    const plan: QueryPlan = {
      schema_version: 1,
      query_id: request.query_id,
      ...plannedRetrieval,
    };
    if (plan.structured_query_required && !this.aggregator) {
      throw new RetrievalPolicyError(`Intent ${request.intent} requires a structured aggregator`);
    }

    const selectedRetrievers = plan.stages
      .filter((stage): stage is SearchStage => stage !== "structured")
      .map((stage) => this.retrievers.get(stage))
      .filter((retriever): retriever is Retriever => Boolean(retriever));
    const runRetrievers = async (queryText: string) => {
      const settled = await Promise.allSettled(
        selectedRetrievers.map((retriever) =>
          retriever.retrieve({
            query_id: request.query_id,
            query: queryText,
            principal: request.principal,
            purpose: request.purpose,
            max_results: plan.candidate_k,
            filters: request.filters ?? {},
            ...(signal ? { signal } : {}),
          }),
        ),
      );
      signal?.throwIfAborted();
      const lists: RetrievalHit[][] = [];
      const trace: Array<{ id: string; stage: SearchStage; returned: number; failed: boolean }> = [];
      for (let index = 0; index < settled.length; index += 1) {
        const retriever = selectedRetrievers[index]!;
        const outcome = settled[index]!;
        if (outcome.status === "fulfilled") {
          const hits = [...outcome.value]
            .filter(validHit)
            .sort((left, right) => right.score - left.score)
            .slice(0, plan.candidate_k);
          lists.push(hits);
          trace.push({ id: retriever.id, stage: retriever.stage, returned: hits.length, failed: false });
        } else {
          trace.push({ id: retriever.id, stage: retriever.stage, returned: 0, failed: true });
        }
      }
      return { lists, trace };
    };

    let { lists: rankedLists, trace: retrieverTrace } = await runRetrievers(request.original_query);
    // Only rewrite when the original query found nothing at all. A rewrite that runs unconditionally
    // measured -14% P@10 and -14% MRR on the 28 queries that were already fine, so the trigger has to
    // be an actual empty result rather than a heuristic about the query text.
    // A failed rewrite is not fatal: the empty pack is still a truthful answer.
    let rewrittenQuery: string | undefined;
    const foundNothing = retrieverTrace.length > 0
      && retrieverTrace.every((entry) => entry.failed || entry.returned === 0)
      && retrieverTrace.some((entry) => !entry.failed);
    if (this.queryRewriter && foundNothing) {
      try {
        const candidate = (await this.queryRewriter.rewrite({
          query_id: request.query_id,
          original_query: request.original_query,
          ...(signal ? { signal } : {}),
        })).trim();
        signal?.throwIfAborted();
        if (candidate && candidate !== request.original_query) {
          const retried = await runRetrievers(candidate);
          // Keep the retry only if it actually recovered something, so a rewrite can never make the
          // result worse than not having attempted it.
          if (retried.trace.some((entry) => entry.returned > 0)) {
            rankedLists = retried.lists;
            retrieverTrace = retried.trace;
            rewrittenQuery = candidate;
          }
        }
      } catch {
        signal?.throwIfAborted();
      }
    }

    // Every retriever failing produces an empty pack that is indistinguishable from "no evidence
    // exists". Reporting infrastructure failure as an absence of evidence lets a caller conclude a
    // fact is unsupported when retrieval simply broke.
    if (selectedRetrievers.length > 0 && retrieverTrace.every((entry) => entry.failed)) {
      throw new RetrievalUnavailableError(
        `All ${selectedRetrievers.length} retriever(s) failed for query ${request.query_id}`,
      );
    }

    const fused = reciprocalRankFusion(rankedLists, this.rrfConstant).slice(0, plan.fusion_k);
    const authorized: FusedHit[] = [];
    let denied = 0;
    let authorizationErrors = 0;
    // Batch first when the adapter supports it. Per-candidate re-checking is one round trip each:
    // 24 candidates measured 54.7ms serially against PostgreSQL versus 3.5ms as a single statement.
    // A batch failure is attributed to every candidate, matching what the serial path would have
    // recorded had each individual check failed, so `authorizationErrors === fused.length` still
    // distinguishes "backend is down" from "tenant may read nothing".
    let batchAllowed: ReadonlySet<string> | undefined;
    if (this.authorization.canReadAll && fused.length > 0) {
      try {
        batchAllowed = await this.authorization.canReadAll({
          principal: request.principal,
          purpose: request.purpose,
          hits: fused,
        });
      } catch (error) {
        signal?.throwIfAborted();
        authorizationErrors = fused.length;
      }
    }
    if (batchAllowed) {
      for (const hit of fused) {
        if (batchAllowed.has(hit.id)) authorized.push(hit);
        else denied += 1;
      }
    } else if (authorizationErrors === 0) {
      for (const hit of fused) {
        let allowed = false;
        try {
          allowed = await this.authorization.canRead({
            principal: request.principal,
            purpose: request.purpose,
            hit,
          });
        } catch (error) {
          signal?.throwIfAborted();
          // Fail closed on the individual hit, but count it: an authorization backend that is down
          // must not look like a tenant with no readable evidence.
          authorizationErrors += 1;
          allowed = false;
        }
        if (allowed) authorized.push(hit);
        else denied += 1;
      }
    } else {
      denied = fused.length;
    }
    if (fused.length > 0 && authorizationErrors === fused.length) {
      throw new RetrievalUnavailableError(
        `Authorization checks failed for all ${fused.length} candidate(s) of query ${request.query_id}`,
      );
    }

    const fusedWindow = authorized.slice(0, plan.rerank_k);
    let rerankWindow = fusedWindow;
    if (this.reranker && fusedWindow.length > 0) {
      try {
        const result = await this.reranker.rerank({
          request_id: `${request.query_id}.rerank`,
          workload: "retrieval.query.rerank",
          query: request.original_query,
          documents: fusedWindow.map((hit) => hit.content),
          top_k: fusedWindow.length,
          budget: this.rerankerBudget,
          ...(signal ? { signal } : {}),
        });
        rerankWindow = applyRerankResult(fusedWindow, result, this.rerankerBudget);
      } catch (error) {
        signal?.throwIfAborted();
        if (this.rerankerFailureMode === "strict" || !isRetryableProviderFailure(error)) {
          throw new RetrievalPolicyError(`Reranking failed closed: ${error instanceof Error ? error.message : String(error)}`);
        }
        rerankWindow = fusedWindow;
      }
    }
    const selected = selectEvidence(
      rerankWindow.map((hit) => ({
        id: hit.id,
        score: hit.score,
        token_count: hit.token_count,
        source_type: hit.source_type,
        ...(hit.entity_keys ? { entity_keys: hit.entity_keys } : {}),
        access_allowed: true,
      })),
      plan,
    );
    const selectedById = new Map(rerankWindow.map((hit) => [hit.id, hit]));
    let contextHits: readonly RetrievalHit[] = selected.candidates.map((candidate) => selectedById.get(candidate.id)!);
    if (this.expander && contextHits.length > 0) {
      contextHits = validateExpandedHits(await this.expander.expand({
        hits: contextHits,
        principal: request.principal,
        purpose: request.purpose,
        max_tokens: plan.max_context_tokens,
        ...(signal ? { signal } : {}),
      }), plan.max_context_tokens);
      const finallyAuthorized: RetrievalHit[] = [];
      for (const hit of contextHits) {
        let allowed = false;
        try {
          allowed = await this.authorization.canRead({
            principal: request.principal,
            purpose: request.purpose,
            hit,
          });
        } catch {
          allowed = false;
        }
        if (allowed) finallyAuthorized.push(hit);
        else denied += 1;
      }
      contextHits = finallyAuthorized;
    }
    const evidence = contextHits.map((hit) => {
      return {
        evidence_id: hit.id,
        untrusted_content: hit.content,
        score: hit.score,
        source_type: hit.source_type,
        entity_keys: hit.entity_keys ?? [],
        citation: hit.citation,
      };
    });
    const structuredResult = this.aggregator && plan.structured_query_required
      ? await this.aggregator.aggregate({ request, ...(signal ? { signal } : {}) })
      : undefined;
    signal?.throwIfAborted();
    const coverage = Math.min(1, evidence.length / Math.max(1, plan.min_context_k));
    const hasRequiredStructure = !plan.structured_query_required || Boolean(structuredResult);
    const sufficient =
      hasRequiredStructure &&
      evidence.length >= plan.min_context_k &&
      coverage >= plan.evidence_coverage_target;
    const conflicts = structuredResult?.conflicts ?? [];
    const pack: EvidencePack = {
      schema_version: 1,
      query_id: request.query_id,
      original_query: request.original_query,
      status: sufficient ? "sufficient" : "insufficient",
      plan,
      ...(structuredResult ? { structured_result: structuredResult } : {}),
      evidence,
      conflicts,
      coverage,
      citation_required: request.require_citations,
      allowed_usage: request.purpose,
      generation_allowed: sufficient && conflicts.length === 0,
      trace: {
        retrievers: retrieverTrace,
        fused: fused.length,
        authorized: authorized.length,
        denied,
        selected: evidence.length,
        stop_reason: selected.stopped_by,
        ...(rewrittenQuery ? { rewritten_query: rewrittenQuery } : {}),
      },
    };
    assertContract("EvidencePack", pack);
    return pack;
  }
}

interface FusedHit extends RetrievalHit {
  readonly score: number;
}

function applyRerankResult(hits: readonly FusedHit[], result: RerankResult, budget: ModelBudget): FusedHit[] {
  if (!result || !Array.isArray(result.rankings) || result.rankings.length !== hits.length) throw new RetrievalPolicyError("Reranker must return exactly one ranking for each governed candidate");
  const seen = new Set<number>();
  const ordered = result.rankings.map((ranking) => {
    if (!Number.isSafeInteger(ranking.index) || ranking.index < 0 || ranking.index >= hits.length || seen.has(ranking.index)) throw new RetrievalPolicyError("Reranker returned an unknown or duplicate candidate index");
    if (!Number.isFinite(ranking.score) || ranking.score < 0 || ranking.score > 1) throw new RetrievalPolicyError("Reranker scores must be normalized between 0 and 1");
    seen.add(ranking.index);
    return { ...hits[ranking.index]!, score: ranking.score };
  });
  const usage = result.usage;
  if (!usage || ![usage.input_tokens, usage.output_tokens, usage.cached_input_tokens, usage.total_tokens, usage.cost_usd].every((value) => Number.isFinite(value) && value >= 0)) throw new RetrievalPolicyError("Reranker returned invalid usage accounting");
  if (usage.total_tokens > budget.max_tokens || usage.cost_usd > budget.max_cost_usd) throw new RetrievalPolicyError("Reranker exceeded its governed budget");
  return ordered;
}

function isRetryableProviderFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && (error as { readonly retryable?: unknown }).retryable === true);
}

function reciprocalRankFusion(
  rankedLists: readonly (readonly RetrievalHit[])[],
  constant: number,
): readonly FusedHit[] {
  const fused = new Map<string, { hit: RetrievalHit; score: number; agreement: number; bestRank: number }>();
  for (const list of rankedLists) {
    for (let index = 0; index < list.length; index += 1) {
      const hit = list[index]!;
      const existing = fused.get(hit.id);
      if (
        existing &&
        (existing.hit.content !== hit.content ||
          existing.hit.citation.digest !== hit.citation.digest ||
          existing.hit.citation.uri !== hit.citation.uri)
      ) {
        throw new RetrievalPolicyError(`Evidence ID ${hit.id} has conflicting immutable content`);
      }
      const contribution = 1 / (constant + index + 1);
      fused.set(hit.id, {
        hit: existing?.hit ?? hit,
        score: (existing?.score ?? 0) + contribution,
        agreement: (existing?.agreement ?? 0) + 1,
        bestRank: Math.min(existing?.bestRank ?? Number.POSITIVE_INFINITY, index),
      });
    }
  }
  // Ties are common and must not be settled by retriever declaration order. Two hits that each rank
  // first in exactly one list score identically, so before this tie-break the winner was whichever
  // retriever happened to be configured first — measured on a 30720-chunk corpus, the lexical leg's
  // wrong rank-1 displaced the vector leg's correct rank-1 on 3 of 32 queries and cost 0.047 MRR.
  //
  // `agreement` first: a document both retrievers found is better evidence than one only a single
  // retriever found, which is the premise of hybrid retrieval in the first place. Then best rank, then
  // id, so the order is total and reproducible rather than dependent on Map insertion order.
  const ordered = [...fused.values()].sort(
    (left, right) =>
      right.score - left.score ||
      right.agreement - left.agreement ||
      left.bestRank - right.bestRank ||
      (left.hit.id < right.hit.id ? -1 : left.hit.id > right.hit.id ? 1 : 0),
  );
  const maximum = ordered[0]?.score ?? 1;
  return ordered.map(({ hit, score }) => ({ ...hit, score: score / maximum }));
}

function validHit(hit: RetrievalHit): boolean {
  return Boolean(
    hit.id &&
    hit.content &&
    Number.isFinite(hit.score) &&
    hit.score >= 0 &&
    Number.isInteger(hit.token_count) &&
    hit.token_count > 0 &&
    hit.citation.artifact_id &&
    hit.citation.uri &&
    /^sha256:[a-f0-9]{64}$/.test(hit.citation.digest),
  );
}

function isExpansionRelation(value: string): value is EvidenceExpansionRelation {
  return expansionRelations.includes(value as EvidenceExpansionRelation);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateExpandedHits(hits: readonly RetrievalHit[], maxTokens: number): readonly RetrievalHit[] {
  const unique = new Map<string, RetrievalHit>();
  let usedTokens = 0;
  for (const hit of hits) {
    if (!validHit(hit)) throw new RetrievalPolicyError("Evidence Expander returned an invalid hit");
    const existing = unique.get(hit.id);
    if (existing && (
      existing.content !== hit.content ||
      existing.citation.uri !== hit.citation.uri ||
      existing.citation.digest !== hit.citation.digest
    )) {
      throw new RetrievalPolicyError(`Expanded evidence ID ${hit.id} has conflicting immutable content`);
    }
    if (!existing) {
      unique.set(hit.id, hit);
      usedTokens += hit.token_count;
    }
  }
  if (usedTokens > maxTokens) throw new RetrievalPolicyError("Evidence Expander exceeded the context token budget");
  return [...unique.values()];
}

function validateRequest(request: RetrievalRequest, signal?: AbortSignal): void {
  if (
    !request ||
    typeof request.query_id !== "string" ||
    !request.query_id.trim() ||
    typeof request.original_query !== "string" ||
    !request.original_query.trim() ||
    typeof request.purpose !== "string" ||
    !request.purpose.trim() ||
    !request.principal ||
    typeof request.principal.tenant_id !== "string" ||
    !request.principal.tenant_id.trim()
  ) {
    throw new RetrievalPolicyError("Retrieval request identity, query, principal and purpose are required");
  }
  if (
    !Number.isSafeInteger(request.token_budget) ||
    !Number.isSafeInteger(request.estimated_chunk_tokens) ||
    request.token_budget <= 0 ||
    request.estimated_chunk_tokens <= 0
  ) {
    throw new RetrievalPolicyError("Retrieval token budgets must be positive");
  }
  if (request.structured_filters !== undefined) {
    const filters = request.structured_filters;
    if (
      !filters ||
      typeof filters !== "object" ||
      (filters.subject_id !== undefined && (typeof filters.subject_id !== "string" || !filters.subject_id.trim())) ||
      (filters.event_type !== undefined && (typeof filters.event_type !== "string" || !filters.event_type.trim())) ||
      (filters.from !== undefined && (typeof filters.from !== "string" || !filters.from.trim())) ||
      (filters.to !== undefined && (typeof filters.to !== "string" || !filters.to.trim())) ||
      (filters.include_conflicts !== undefined && typeof filters.include_conflicts !== "boolean")
    ) {
      throw new RetrievalPolicyError("Retrieval structured filters are invalid");
    }
    const from = filters.from === undefined ? undefined : new Date(filters.from);
    const to = filters.to === undefined ? undefined : new Date(filters.to);
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
      throw new RetrievalPolicyError("Retrieval structured filter timestamps are invalid");
    }
  }
  if (signal?.aborted) throw signal.reason;
}
