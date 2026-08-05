import { setTimeout as delay } from "node:timers/promises";

import { ModelGatewayError, normalizeModelError } from "./errors.ts";
import type {
  EmbeddingPort,
  EmbeddingRequest,
  EmbeddingResult,
  GenerationRequest,
  GenerationResult,
  GenerationStreamEvent,
  GenerationTransport,
  ModelCapability,
  ModelDescriptor,
  ModelRoute,
  ModelRoutingPolicy,
  RerankPort,
  RerankRequest,
  RerankResult,
  TextGenerationPort,
  TransportCall,
  TransportGenerationResult,
} from "./types.ts";

export interface RoutedModelGatewayOptions {
  readonly policy: ModelRoutingPolicy;
  readonly transports: readonly GenerationTransport[];
  readonly embeddings?: EmbeddingPort;
  readonly reranker?: RerankPort;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class RoutedModelGateway implements TextGenerationPort, EmbeddingPort, RerankPort {
  private readonly options: RoutedModelGatewayOptions;
  private readonly transports: ReadonlyMap<string, GenerationTransport>;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: RoutedModelGatewayOptions) {
    this.options = options;
    this.transports = new Map(options.transports.map((transport) => [transport.id, transport]));
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    validatePolicy(options.policy);
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    validateRequest(request);
    const startedAt = this.now();
    const prepared = this.prepareRoutes(request, "generate");
    let lastError: ModelGatewayError | undefined;

    for (const route of prepared) {
      for (let attempt = 1; attempt <= this.options.policy.retry.max_attempts; attempt += 1) {
        try {
          const call = this.createCall(request, route, startedAt);
          const result = await route.transport.generate(call);
          return this.finish(request, route.route, route.descriptor, result, startedAt);
        } catch (error) {
          lastError = normalizeModelError(error);
          if (!lastError.retryable || request.signal?.aborted) {
            throw lastError;
          }
          if (attempt < this.options.policy.retry.max_attempts) {
            await this.backoff(attempt, request.signal);
          }
        }
      }
    }
    throw lastError ?? new ModelGatewayError("ROUTE_NOT_FOUND", "No generation route succeeded", false);
  }

  async *stream(request: GenerationRequest): AsyncIterable<GenerationStreamEvent> {
    validateRequest(request);
    const startedAt = this.now();
    const prepared = this.prepareRoutes(request, "stream");
    let lastError: ModelGatewayError | undefined;

    for (const route of prepared) {
      for (let attempt = 1; attempt <= this.options.policy.retry.max_attempts; attempt += 1) {
        let emittedText = false;
        try {
          const call = this.createCall(request, route, startedAt);
          for await (const event of route.transport.stream(call)) {
            if (event.type === "text_delta") {
              emittedText ||= event.text.length > 0;
              yield event;
            } else {
              yield {
                type: "completed",
                result: this.finish(request, route.route, route.descriptor, event.result, startedAt),
              };
              return;
            }
          }
          throw new ModelGatewayError("PROVIDER_ERROR", "Provider stream ended without a result", true);
        } catch (error) {
          lastError = normalizeModelError(error);
          if (emittedText) {
            throw new ModelGatewayError(
              "PARTIAL_STREAM_FAILURE",
              `Stream failed after output began: ${lastError.message}`,
              false,
              { cause: lastError },
            );
          }
          if (!lastError.retryable || request.signal?.aborted) {
            throw lastError;
          }
          if (attempt < this.options.policy.retry.max_attempts) {
            await this.backoff(attempt, request.signal);
          }
        }
      }
    }
    throw lastError ?? new ModelGatewayError("ROUTE_NOT_FOUND", "No streaming route succeeded", false);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (!this.options.embeddings) {
      throw new ModelGatewayError(
        "CAPABILITY_UNAVAILABLE",
        "Embedding requires a separately configured provider; pi-ai does not expose this capability",
        false,
      );
    }
    return await this.options.embeddings.embed(request);
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    if (!this.options.reranker) {
      throw new ModelGatewayError(
        "CAPABILITY_UNAVAILABLE",
        "Reranking requires a separately configured provider; pi-ai does not expose this capability",
        false,
      );
    }
    return await this.options.reranker.rerank(request);
  }

  private prepareRoutes(request: GenerationRequest, capability: ModelCapability): PreparedRoute[] {
    const routes = this.options.policy.routes[request.workload] ?? [];
    const prepared: PreparedRoute[] = [];
    let budgetRejected = false;
    let unavailable: ModelGatewayError | undefined;
    for (const route of routes) {
      if (!route.capabilities.includes(capability)) {
        continue;
      }
      const transport = this.transports.get(route.transport_id);
      if (!transport) {
        continue;
      }
      let descriptor: ModelDescriptor;
      try {
        descriptor = transport.describe(route);
      } catch (error) {
        const normalized = normalizeModelError(error);
        if (normalized.code === "MODEL_NOT_FOUND" || normalized.code === "CAPABILITY_UNAVAILABLE") {
          unavailable = normalized;
          continue;
        }
        throw normalized;
      }
      const inputTokens = estimateTokens(request.system_prompt) + estimateTokens(request.user_prompt);
      const effectiveOutput = Math.min(
        request.max_output_tokens,
        descriptor.max_output_tokens,
        descriptor.context_window - inputTokens,
        request.budget.max_tokens - inputTokens,
      );
      if (effectiveOutput <= 0) {
        budgetRejected = true;
        continue;
      }
      const estimatedCost =
        (inputTokens * descriptor.input_cost_per_million +
          effectiveOutput * descriptor.output_cost_per_million) /
        1_000_000;
      if (estimatedCost > request.budget.max_cost_usd) {
        budgetRejected = true;
        continue;
      }
      prepared.push({ route, transport, descriptor, effectiveOutput });
    }
    if (prepared.length === 0) {
      if (budgetRejected) {
        throw new ModelGatewayError("BUDGET_EXCEEDED", "No model route fits the request budget", false);
      }
      if (unavailable) {
        throw unavailable;
      }
      throw new ModelGatewayError(
        "ROUTE_NOT_FOUND",
        `No ${capability} route is configured for workload ${request.workload}`,
        false,
      );
    }
    return prepared;
  }

  private createCall(
    request: GenerationRequest,
    route: PreparedRoute,
    startedAt: number,
  ): TransportCall {
    const remaining = request.budget.max_duration_ms - (this.now() - startedAt);
    if (remaining <= 0) {
      throw new ModelGatewayError("TIMEOUT", "Model request exhausted its duration budget", true);
    }
    return {
      ...request,
      target: { provider: route.route.provider, model: route.route.model },
      effective_max_output_tokens: route.effectiveOutput,
      timeout_ms: Math.min(this.options.policy.attempt_timeout_ms, remaining),
    };
  }

  private finish(
    request: GenerationRequest,
    route: ModelRoute,
    descriptor: ModelDescriptor,
    result: TransportGenerationResult,
    startedAt: number,
  ): GenerationResult {
    if (result.usage.total_tokens > request.budget.max_tokens) {
      throw new ModelGatewayError("BUDGET_EXCEEDED", "Provider exceeded the token budget", false);
    }
    if (result.usage.cost_usd > request.budget.max_cost_usd) {
      throw new ModelGatewayError("BUDGET_EXCEEDED", "Provider exceeded the cost budget", false);
    }
    const latency = this.now() - startedAt;
    if (latency > request.budget.max_duration_ms) {
      throw new ModelGatewayError("TIMEOUT", "Provider exceeded the duration budget", true);
    }
    return {
      request_id: request.request_id,
      text: result.text,
      finish_reason: result.finish_reason,
      route_id: route.route_id,
      usage: result.usage,
      latency_ms: latency,
      snapshots: {
        ...request.snapshots,
        model: descriptor.snapshot,
        routing: this.options.policy.snapshot,
      },
    };
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const base = this.options.policy.retry.initial_backoff_ms * 2 ** (attempt - 1);
    await this.wait(Math.min(base, this.options.policy.retry.max_backoff_ms), signal);
  }
}

interface PreparedRoute {
  readonly route: ModelRoute;
  readonly transport: GenerationTransport;
  readonly descriptor: ModelDescriptor;
  readonly effectiveOutput: number;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function validateRequest(request: GenerationRequest): void {
  if (!request.request_id || !request.workload || !request.system_prompt || !request.user_prompt) {
    throw new ModelGatewayError("INVALID_REQUEST", "Generation request fields must be non-empty", false);
  }
  if (
    request.max_output_tokens <= 0 ||
    request.budget.max_tokens <= 0 ||
    request.budget.max_cost_usd < 0 ||
    request.budget.max_duration_ms <= 0
  ) {
    throw new ModelGatewayError("INVALID_REQUEST", "Generation budgets must be greater than zero", false);
  }
  if (request.signal?.aborted) {
    throw new ModelGatewayError("CANCELED", "Model request was canceled", false);
  }
}

function validatePolicy(policy: ModelRoutingPolicy): void {
  if (!policy.snapshot || policy.retry.max_attempts < 1 || policy.attempt_timeout_ms <= 0) {
    throw new TypeError("Invalid model routing policy");
  }
}
