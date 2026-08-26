import { ModelGatewayError } from "./errors.ts";
import { parseProviderEndpoint, readBoundedJson } from "./http-provider-boundary.ts";
import type { RerankPort, RerankRequest, RerankResult } from "./types.ts";

export interface HttpRerankerProviderOptions {
  readonly endpoint: string;
  readonly api_key?: string;
  readonly model: string;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly max_documents?: number;
  readonly allow_insecure_localhost?: boolean;
  readonly fetch_impl?: typeof fetch;
}

/** OpenAI-compatible-style reranking adapter. Reranking is deliberately separate from pi-ai generation. */
export class HttpRerankerProvider implements RerankPort {
  private readonly options: Required<Pick<HttpRerankerProviderOptions, "endpoint" | "model" | "timeout_ms" | "max_response_bytes" | "max_documents">> & HttpRerankerProviderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRerankerProviderOptions) {
    const endpoint = parseProviderEndpoint(options.endpoint, "Reranker", options.allow_insecure_localhost ?? false);
    if (!options.model.trim()) throw new TypeError("Reranker model is required");
    const timeout = options.timeout_ms ?? 30_000;
    const responseBytes = options.max_response_bytes ?? 1_000_000;
    const maxDocuments = options.max_documents ?? 256;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) throw new TypeError("Reranker timeout must be between 100 and 300000");
    if (!Number.isSafeInteger(responseBytes) || responseBytes < 1_024 || responseBytes > 10_000_000) throw new TypeError("Reranker response limit must be between 1024 and 10000000 bytes");
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1_000) throw new TypeError("Reranker document limit must be between 1 and 1000");
    this.options = { ...options, endpoint, timeout_ms: timeout, max_response_bytes: responseBytes, max_documents: maxDocuments };
    this.fetchImpl = options.fetch_impl ?? fetch;
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    validateRequest(request, this.options.max_documents);
    request.signal?.throwIfAborted();
    const startedAt = Date.now();
    const timeoutMs = Math.min(this.options.timeout_ms, request.budget.max_duration_ms);
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}),
          "x-firefly-request-id": request.request_id,
        },
        body: JSON.stringify({ model: this.options.model, query: request.query, documents: request.documents, top_k: request.top_k }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new ModelGatewayError("CANCELED", "Reranker request was canceled", false, { cause: error instanceof Error ? error : undefined });
      if (signal.aborted) throw new ModelGatewayError("TIMEOUT", "Reranker provider request timed out", true, { cause: error instanceof Error ? error : undefined });
      throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider request failed", true, { cause: error instanceof Error ? error : undefined });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelGatewayError("PROVIDER_ERROR", `Reranker provider returned HTTP ${response.status}`, response.status >= 500);
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readBoundedJson(response, this.options.max_response_bytes, "Reranker");
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (request.signal?.aborted) throw new ModelGatewayError("CANCELED", "Reranker request was canceled", false, { cause: error instanceof Error ? error : undefined });
      if (signal.aborted) throw new ModelGatewayError("TIMEOUT", "Reranker provider response timed out", true, { cause: error instanceof Error ? error : undefined });
      throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider response failed", true, { cause: error instanceof Error ? error : undefined });
    }
    const rankings = parseRankings(payload, request.documents.length, request.top_k);
    const usage = (payload as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    const inputTokens = optionalInteger(usage?.prompt_tokens ?? usage?.input_tokens, "input token usage");
    const totalTokens = optionalInteger(usage?.total_tokens, "total token usage") || inputTokens;
    const costUsd = optionalNumber(usage?.cost_usd, "cost usage");
    if (totalTokens < inputTokens) throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider returned inconsistent usage accounting", false);
    if (totalTokens > request.budget.max_tokens) throw new ModelGatewayError("BUDGET_EXCEEDED", "Reranker provider exceeded the token budget", false);
    if (costUsd > request.budget.max_cost_usd) throw new ModelGatewayError("BUDGET_EXCEEDED", "Reranker provider exceeded the cost budget", false);
    if (Date.now() - startedAt > request.budget.max_duration_ms) throw new ModelGatewayError("TIMEOUT", "Reranker provider exceeded the duration budget", true);
    return { rankings, usage: { input_tokens: inputTokens, output_tokens: 0, cached_input_tokens: 0, total_tokens: totalTokens, cost_usd: costUsd } };
  }
}

function validateRequest(request: RerankRequest, maxDocuments: number): void {
  if (!request.request_id.trim() || !request.workload.trim() || !request.query.trim() || request.documents.length < 1 || request.documents.length > maxDocuments) {
    throw new ModelGatewayError("INVALID_REQUEST", `Rerank request requires 1 to ${maxDocuments} documents`, false);
  }
  if (request.documents.some((document) => typeof document !== "string" || !document.trim())) throw new ModelGatewayError("INVALID_REQUEST", "Rerank documents must be non-empty text", false);
  if (!Number.isSafeInteger(request.top_k) || request.top_k < 1 || request.top_k > request.documents.length) throw new ModelGatewayError("INVALID_REQUEST", "Rerank top_k must be within the document count", false);
  if (request.budget.max_tokens < 1 || request.budget.max_cost_usd < 0 || request.budget.max_duration_ms < 1) throw new ModelGatewayError("INVALID_REQUEST", "Rerank budget is invalid", false);
}


function parseRankings(payload: Record<string, unknown>, documentCount: number, topK: number): readonly { readonly index: number; readonly score: number }[] {
  const data = payload.results ?? payload.data;
  // 只要求"至少 top_k 条、不超过文档数"，而不是"恰好 top_k 条"。
  //
  // 起因是一次真实失败：本地部署的 Qwen3-VL-Embedding-2B 的 /v1/rerank 忽略请求里的 top_k，
  // 总是返回全部文档的打分（请求 top_k=3、5 篇文档，返回 5 条）。原先断言 `length !== topK`
  // 直接抛 PROVIDER_ERROR，于是整条重排链路对这个 provider 完全不可用——而它的排序结果本身是
  // 正确的，只是多返回了几条。
  //
  // 服务端截断是可选优化，不是协议保证：Cohere、Jina 等实现会截断，vLLM 一类的打分端点通常不截。
  // 客户端本来就要按分数排序并取前 top_k，多余的条目丢掉即可；少于 top_k 才是真的异常，说明
  // provider 没给够结果。
  if (!Array.isArray(data) || data.length < topK || data.length > documentCount) {
    throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider returned an unexpected ranking count", false);
  }
  const rankings = data.map((item, position) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const index = record.index;
    const score = record.score ?? record.relevance_score;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= documentCount || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider returned an invalid ranking", false);
    return { index: index as number, score };
  });
  if (new Set(rankings.map((ranking) => ranking.index)).size !== rankings.length) throw new ModelGatewayError("PROVIDER_ERROR", "Reranker provider returned duplicate document indexes", false);
  // provider 未截断时自己截：按分数降序取前 top_k。不依赖 provider 返回的顺序，因为"按分数排序"
  // 同样不是协议保证，而调用方拿到的必须是有序的前 top_k。
  return [...rankings].sort((left, right) => right.score - left.score).slice(0, topK);
}


function optionalInteger(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ModelGatewayError("PROVIDER_ERROR", `Reranker provider returned invalid ${label}`, false);
  return value as number;
}

function optionalNumber(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ModelGatewayError("PROVIDER_ERROR", `Reranker provider returned invalid ${label}`, false);
  return value;
}
