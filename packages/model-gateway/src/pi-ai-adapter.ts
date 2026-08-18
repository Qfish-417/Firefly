import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { ModelGatewayError, normalizeModelError } from "./errors.ts";
import { snapshotId } from "./snapshots.ts";
import type {
  CustomModelProviderConfiguration,
  GenerationTransport,
  ModelDescriptor,
  ModelTarget,
  ModelUsage,
  TransportCall,
  TransportGenerationResult,
  TransportStreamEvent,
} from "./types.ts";

export type PiAiModels = Pick<Models, "getModel" | "completeSimple" | "streamSimple">;

export class PiAiGenerationTransport implements GenerationTransport {
  readonly id = "pi-ai";
  private readonly models: PiAiModels;
  private readonly now: () => number;

  constructor(models: PiAiModels, now: () => number = Date.now) {
    this.models = models;
    this.now = now;
  }

  describe(target: ModelTarget): ModelDescriptor {
    const model = this.getModel(target);
    return {
      provider: model.provider,
      model: model.id,
      api: model.api,
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      input_cost_per_million: model.cost.input,
      output_cost_per_million: model.cost.output,
      snapshot: snapshotId("model", "pi-ai-0.83.0", {
        provider: model.provider,
        id: model.id,
        api: model.api,
        base_url: model.baseUrl,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
        cost: model.cost,
      }),
    };
  }

  async generate(call: TransportCall): Promise<TransportGenerationResult> {
    const model = this.getModel(call.target);
    const signal = timeoutSignal(call.signal, call.timeout_ms);
    try {
      const message = await this.models.completeSimple(model, this.context(call), {
        signal,
        maxTokens: call.effective_max_output_tokens,
        ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
        timeoutMs: call.timeout_ms,
        maxRetries: 0,
      });
      return convertMessage(message);
    } catch (error) {
      throw normalizePiAiError(error, signal, call.signal);
    }
  }

  async *stream(call: TransportCall): AsyncIterable<TransportStreamEvent> {
    const model = this.getModel(call.target);
    const signal = timeoutSignal(call.signal, call.timeout_ms);
    try {
      const events = this.models.streamSimple(model, this.context(call), {
        signal,
        maxTokens: call.effective_max_output_tokens,
        ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
        timeoutMs: call.timeout_ms,
        maxRetries: 0,
      });
      for await (const event of events) {
        const converted = convertStreamEvent(event);
        if (converted) {
          yield converted;
        }
      }
    } catch (error) {
      throw normalizePiAiError(error, signal, call.signal);
    }
  }

  private context(call: TransportCall) {
    return {
      systemPrompt: call.system_prompt,
      messages: [{ role: "user" as const, content: call.user_prompt, timestamp: this.now() }],
    };
  }

  private getModel(target: ModelTarget): Model<Api> {
    const model = this.models.getModel(target.provider, target.model);
    if (!model) {
      throw new ModelGatewayError(
        "MODEL_NOT_FOUND",
        `pi-ai model was not found: ${target.provider}/${target.model}`,
        false,
      );
    }
    return model;
  }
}

export function createBuiltinPiAiTransport(): PiAiGenerationTransport {
  return new PiAiGenerationTransport(builtinModels());
}

export function createConfiguredPiAiModels(
  providers: readonly CustomModelProviderConfiguration[] = [],
): Models {
  const models = builtinModels();
  const registeredProviderIds = new Set(models.getProviders().map((provider) => provider.id));
  for (const provider of providers) {
    validateCustomProvider(provider, registeredProviderIds);
    const modelEntries = provider.models.map((definition) => ({
      id: definition.id,
      name: definition.name ?? definition.id,
      api: provider.api,
      provider: provider.id,
      baseUrl: provider.base_url,
      reasoning: definition.reasoning ?? false,
      input: ["text"] as ("text")[],
      cost: {
        input: definition.input_cost_per_million,
        output: definition.output_cost_per_million,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: definition.context_window,
      maxTokens: definition.max_output_tokens,
    }));
    const auth = provider.api_key_env
      ? { apiKey: envApiKeyAuth(`${provider.name ?? provider.id} API key`, [provider.api_key_env]) }
      : { apiKey: { name: provider.name ?? provider.id, resolve: async () => ({ auth: {} }) } };
    models.setProvider(createProvider({
      id: provider.id,
      name: provider.name ?? provider.id,
      baseUrl: provider.base_url,
      auth,
      models: modelEntries,
      api: provider.api === "openai-completions" ? openAICompletionsApi() : openAIResponsesApi(),
    }));
    registeredProviderIds.add(provider.id);
  }
  return models;
}

export function createConfiguredPiAiTransport(
  providers: readonly CustomModelProviderConfiguration[] = [],
): PiAiGenerationTransport {
  return new PiAiGenerationTransport(createConfiguredPiAiModels(providers));
}

function validateCustomProvider(
  provider: CustomModelProviderConfiguration,
  registeredProviderIds: ReadonlySet<string>,
): void {
  if (registeredProviderIds.has(provider.id)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider id is already registered: ${provider.id}`, false);
  }
  const url = parseProviderUrl(provider);
  if (url.username || url.password || url.search || url.hash) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider URL must not contain credentials or query data: ${provider.id}`, false);
  }
  const localhost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(localhost && provider.allow_insecure_localhost === true)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider requires HTTPS: ${provider.id}`, false);
  }
  if (provider.api_key_env && !/^[A-Z][A-Z0-9_]{1,127}$/.test(provider.api_key_env)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider api_key_env is invalid: ${provider.id}`, false);
  }
  const modelIds = new Set<string>();
  for (const model of provider.models) {
    if (modelIds.has(model.id)) {
      throw new ModelGatewayError("INVALID_REQUEST", `Custom provider has duplicate model: ${provider.id}/${model.id}`, false);
    }
    modelIds.add(model.id);
  }
}

function parseProviderUrl(provider: CustomModelProviderConfiguration): URL {
  try {
    return new URL(provider.base_url);
  } catch (error) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider URL is invalid: ${provider.id}`, false, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function convertStreamEvent(event: AssistantMessageEvent): TransportStreamEvent | undefined {
  if (event.type === "text_delta") {
    return { type: "text_delta", text: event.delta };
  }
  if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
    throw new ModelGatewayError(
      "PROVIDER_TOOL_CALL_FORBIDDEN",
      "Model Gateway forbids model-initiated tool calls",
      false,
    );
  }
  if (event.type === "done") {
    return { type: "completed", result: convertMessage(event.message) };
  }
  if (event.type === "error") {
    throw messageError(event.error);
  }
  return undefined;
}

function convertMessage(message: AssistantMessage): TransportGenerationResult {
  if (message.content.some((content) => content.type === "toolCall") || message.stopReason === "toolUse") {
    throw new ModelGatewayError(
      "PROVIDER_TOOL_CALL_FORBIDDEN",
      "Model Gateway forbids model-initiated tool calls",
      false,
    );
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw messageError(message);
  }
  const text = message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
  return {
    text,
    finish_reason: message.stopReason === "length" ? "length" : "stop",
    usage: convertUsage(message),
  };
}

function convertUsage(message: AssistantMessage): ModelUsage {
  return {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    cached_input_tokens: message.usage.cacheRead,
    total_tokens: message.usage.totalTokens,
    cost_usd: message.usage.cost.total,
  };
}

function messageError(message: AssistantMessage): ModelGatewayError {
  return new ModelGatewayError(
    message.stopReason === "aborted" ? "CANCELED" : "PROVIDER_ERROR",
    message.errorMessage ?? `pi-ai stopped with ${message.stopReason}`,
    message.stopReason === "error",
  );
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return parent ? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function normalizePiAiError(
  error: unknown,
  effectiveSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): ModelGatewayError {
  if (parentSignal?.aborted) {
    return new ModelGatewayError("CANCELED", "Model request was canceled", false, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (effectiveSignal.aborted) {
    return new ModelGatewayError("TIMEOUT", "Model provider attempt timed out", true, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return normalizeModelError(error);
}
