import { ModelGatewayError } from "./errors.ts";
import type { EmbeddingPort, EmbeddingRequest, EmbeddingResult } from "./types.ts";

export interface HttpEmbeddingProviderOptions {
  readonly endpoint: string;
  readonly api_key?: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly timeout_ms?: number;
  readonly fetch_impl?: typeof fetch;
}

/** OpenAI-compatible text embedding adapter. It is deliberately separate from pi-ai because pi-ai exposes generation, not embeddings. */
export class HttpEmbeddingProvider implements EmbeddingPort {
  private readonly options: Required<Pick<HttpEmbeddingProviderOptions, "endpoint" | "model" | "timeout_ms">> & HttpEmbeddingProviderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpEmbeddingProviderOptions) {
    const endpoint = new URL(options.endpoint).toString();
    if (!options.model.trim()) throw new TypeError("Embedding model is required");
    if (options.dimensions !== undefined && (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 4096)) {
      throw new TypeError("Embedding dimensions must be between 1 and 4096");
    }
    const timeout = options.timeout_ms ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) throw new TypeError("Embedding timeout must be between 100 and 300000");
    this.options = { ...options, endpoint, timeout_ms: timeout };
    this.fetchImpl = options.fetch_impl ?? fetch;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (!request.request_id.trim() || !request.workload.trim() || request.inputs.length < 1 || request.inputs.length > 256) {
      throw new ModelGatewayError("INVALID_REQUEST", "Embedding request requires 1 to 256 inputs", false);
    }
    if (request.inputs.some((input) => typeof input !== "string" || !input.trim())) {
      throw new ModelGatewayError("INVALID_REQUEST", "Embedding inputs must be non-empty text", false);
    }
    if (request.budget.max_tokens < 1 || request.budget.max_cost_usd < 0 || request.budget.max_duration_ms < 1) {
      throw new ModelGatewayError("INVALID_REQUEST", "Embedding budget is invalid", false);
    }
    request.signal?.throwIfAborted();
    const startedAt = Date.now();
    const timeoutMs = Math.min(this.options.timeout_ms, request.budget.max_duration_ms);
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.options.api_key ? { authorization: `Bearer ${this.options.api_key}` } : {}),
          "x-firefly-request-id": request.request_id,
        },
        body: JSON.stringify({ model: this.options.model, input: request.inputs, ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}) }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new ModelGatewayError("CANCELED", "Embedding request was canceled", false, { cause: error instanceof Error ? error : undefined });
      if (signal.aborted) throw new ModelGatewayError("TIMEOUT", "Embedding provider request timed out", true, { cause: error instanceof Error ? error : undefined });
      throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider request failed", true, { cause: error instanceof Error ? error : undefined });
    }
    const payload = await readJson(response);
    if (!response.ok) throw new ModelGatewayError("PROVIDER_ERROR", `Embedding provider returned HTTP ${response.status}`, response.status >= 500);
    const vectors = parseVectors(payload, request.inputs.length, this.options.dimensions);
    const usage = (payload as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    const inputTokens = integerOrZero(usage?.prompt_tokens);
    const totalTokens = integerOrZero(usage?.total_tokens) || inputTokens;
    if (totalTokens > request.budget.max_tokens) throw new ModelGatewayError("BUDGET_EXCEEDED", "Embedding provider exceeded the token budget", false);
    if (Date.now() - startedAt > request.budget.max_duration_ms) throw new ModelGatewayError("TIMEOUT", "Embedding provider exceeded the duration budget", true);
    return { vectors, usage: { input_tokens: inputTokens, output_tokens: 0, cached_input_tokens: 0, total_tokens: totalTokens, cost_usd: 0 } };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned invalid JSON", response.status >= 500); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned an invalid payload", false);
  return value as Record<string, unknown>;
}

function parseVectors(payload: Record<string, unknown>, expectedCount: number, expectedDimensions?: number): readonly (readonly number[])[] {
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== expectedCount) throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned an unexpected vector count", false);
  const indexed = data.map((item, position) => {
    const embedding = item && typeof item === "object" ? (item as Record<string, unknown>).embedding : undefined;
    const index = item && typeof item === "object" ? (item as Record<string, unknown>).index : undefined;
    if (!Array.isArray(embedding) || embedding.length < 1 || embedding.length > 4096 || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned an invalid vector", false);
    }
    if (index !== undefined && (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= expectedCount)) {
      throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned an invalid vector index", false);
    }
    return { index: index === undefined ? position : index as number, embedding: embedding as number[] };
  });
  if (new Set(indexed.map((item) => item.index)).size !== indexed.length) throw new ModelGatewayError("PROVIDER_ERROR", "Embedding provider returned duplicate vector indexes", false);
  const vectors = indexed.sort((left, right) => left.index - right.index).map((item) => item.embedding);
  const dimensions = vectors[0]!.length;
  if (expectedDimensions !== undefined && dimensions !== expectedDimensions) throw new ModelGatewayError("PROVIDER_ERROR", "Embedding dimensions differ from configuration", false);
  if (vectors.some((vector) => vector.length !== dimensions)) throw new ModelGatewayError("PROVIDER_ERROR", "Embedding vectors have inconsistent dimensions", false);
  return vectors;
}

function integerOrZero(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}
