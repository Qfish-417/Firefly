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

export interface RetrievalGatewayOptions {
  readonly retrievers: readonly Retriever[];
  readonly authorization: RetrievalAuthorizationPort;
  readonly aggregator?: StructuredAggregatorPort;
  readonly expander?: EvidenceExpansionPort;
  readonly rrf_constant?: number;
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
  private readonly rrfConstant: number;

  constructor(options: RetrievalGatewayOptions) {
    this.retrievers = new Map(options.retrievers.map((retriever) => [retriever.stage, retriever]));
    if (this.retrievers.size !== options.retrievers.length) {
      throw new RetrievalPolicyError("Only one Retriever may own a search stage");
    }
    this.authorization = options.authorization;
    this.aggregator = options.aggregator;
    this.expander = options.expander;
    this.rrfConstant = options.rrf_constant ?? 60;
    if (this.rrfConstant <= 0) throw new RetrievalPolicyError("rrf_constant must be positive");
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
    const settled = await Promise.allSettled(
      selectedRetrievers.map((retriever) =>
        retriever.retrieve({
          query_id: request.query_id,
          query: request.original_query,
          principal: request.principal,
          purpose: request.purpose,
          max_results: plan.candidate_k,
          filters: request.filters ?? {},
          ...(signal ? { signal } : {}),
        }),
      ),
    );
    signal?.throwIfAborted();
    const rankedLists: RetrievalHit[][] = [];
    const retrieverTrace: Array<{
      id: string;
      stage: SearchStage;
      returned: number;
      failed: boolean;
    }> = [];
    for (let index = 0; index < settled.length; index += 1) {
      const retriever = selectedRetrievers[index]!;
      const outcome = settled[index]!;
      if (outcome.status === "fulfilled") {
        const hits = [...outcome.value]
          .filter(validHit)
          .sort((left, right) => right.score - left.score)
          .slice(0, plan.candidate_k);
        rankedLists.push(hits);
        retrieverTrace.push({ id: retriever.id, stage: retriever.stage, returned: hits.length, failed: false });
      } else {
        retrieverTrace.push({ id: retriever.id, stage: retriever.stage, returned: 0, failed: true });
      }
    }

    const fused = reciprocalRankFusion(rankedLists, this.rrfConstant).slice(0, plan.fusion_k);
    const authorized: FusedHit[] = [];
    let denied = 0;
    for (const hit of fused) {
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
      if (allowed) authorized.push(hit);
      else denied += 1;
    }

    const rerankWindow = authorized.slice(0, plan.rerank_k);
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
      },
    };
    assertContract("EvidencePack", pack);
    return pack;
  }
}

interface FusedHit extends RetrievalHit {
  readonly score: number;
}

function reciprocalRankFusion(
  rankedLists: readonly (readonly RetrievalHit[])[],
  constant: number,
): readonly FusedHit[] {
  const fused = new Map<string, { hit: RetrievalHit; score: number }>();
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
      fused.set(hit.id, { hit: existing?.hit ?? hit, score: (existing?.score ?? 0) + contribution });
    }
  }
  const ordered = [...fused.values()].sort((left, right) => right.score - left.score);
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
  if (!request.query_id || !request.original_query.trim() || !request.purpose || !request.principal.tenant_id) {
    throw new RetrievalPolicyError("Retrieval request identity, query, principal and purpose are required");
  }
  if (request.token_budget <= 0 || request.estimated_chunk_tokens <= 0) {
    throw new RetrievalPolicyError("Retrieval token budgets must be positive");
  }
  if (signal?.aborted) throw signal.reason;
}
