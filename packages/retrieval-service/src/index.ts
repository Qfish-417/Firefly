import {
  planRetrieval,
  selectEvidence,
  type QueryIntent,
  type RetrievalPlan,
  type RetrievalStage,
} from "@firefly/retrieval-planner";

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

export interface ArtifactCitation {
  readonly artifact_id: string;
  readonly uri: string;
  readonly digest: string;
  readonly locator?: Readonly<Record<string, string | number>>;
}

export interface RetrievalHit {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  readonly token_count: number;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly citation: ArtifactCitation;
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

export interface StructuredResult {
  readonly operation: "count_distinct" | "group_by" | "comparison" | "path" | "temporal";
  readonly value: string | number | boolean | null;
  readonly included_ids: readonly string[];
  readonly excluded_reasons: readonly string[];
  readonly conflicts: readonly string[];
}

export interface StructuredAggregatorPort {
  aggregate(input: {
    readonly request: RetrievalRequest;
    readonly signal?: AbortSignal;
  }): Promise<StructuredResult>;
}

export interface EvidenceItem {
  readonly evidence_id: string;
  readonly untrusted_content: string;
  readonly score: number;
  readonly source_type: string;
  readonly entity_keys: readonly string[];
  readonly citation: ArtifactCitation;
}

export interface EvidencePack {
  readonly query_id: string;
  readonly original_query: string;
  readonly status: "sufficient" | "insufficient";
  readonly plan: RetrievalPlan;
  readonly structured_result?: StructuredResult;
  readonly evidence: readonly EvidenceItem[];
  readonly conflicts: readonly string[];
  readonly coverage: number;
  readonly citation_required: boolean;
  readonly allowed_usage: string;
  readonly generation_allowed: boolean;
  readonly trace: {
    readonly retrievers: readonly {
      readonly id: string;
      readonly stage: SearchStage;
      readonly returned: number;
      readonly failed: boolean;
    }[];
    readonly fused: number;
    readonly authorized: number;
    readonly denied: number;
    readonly selected: number;
    readonly stop_reason: "context_k" | "token_budget" | "score_floor" | "exhausted";
  };
}

export interface RetrievalGatewayOptions {
  readonly retrievers: readonly Retriever[];
  readonly authorization: RetrievalAuthorizationPort;
  readonly aggregator?: StructuredAggregatorPort;
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
  private readonly rrfConstant: number;

  constructor(options: RetrievalGatewayOptions) {
    this.retrievers = new Map(options.retrievers.map((retriever) => [retriever.stage, retriever]));
    if (this.retrievers.size !== options.retrievers.length) {
      throw new RetrievalPolicyError("Only one Retriever may own a search stage");
    }
    this.authorization = options.authorization;
    this.aggregator = options.aggregator;
    this.rrfConstant = options.rrf_constant ?? 60;
    if (this.rrfConstant <= 0) throw new RetrievalPolicyError("rrf_constant must be positive");
  }

  async retrieve(request: RetrievalRequest, signal?: AbortSignal): Promise<EvidencePack> {
    validateRequest(request, signal);
    const searchStages = [...this.retrievers.keys()];
    const plan = planRetrieval({
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
    const evidence = selected.candidates.map((candidate) => {
      const hit = selectedById.get(candidate.id)!;
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
    return {
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

function validateRequest(request: RetrievalRequest, signal?: AbortSignal): void {
  if (!request.query_id || !request.original_query.trim() || !request.purpose || !request.principal.tenant_id) {
    throw new RetrievalPolicyError("Retrieval request identity, query, principal and purpose are required");
  }
  if (request.token_budget <= 0 || request.estimated_chunk_tokens <= 0) {
    throw new RetrievalPolicyError("Retrieval token budgets must be positive");
  }
  if (signal?.aborted) throw signal.reason;
}
