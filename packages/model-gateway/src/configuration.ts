import { ModelGatewayError } from "./errors.ts";
import { RoutedModelGateway } from "./gateway.ts";
import { createConfiguredPiAiTransport } from "./pi-ai-adapter.ts";
import { snapshotId } from "./snapshots.ts";
import type {
  CustomModelProviderConfiguration,
  ModelInvocationObserver,
  ModelRoute,
  ModelRoutingPolicy,
  RouteRetryPolicy,
} from "./types.ts";

export interface ModelRouteConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly capabilities?: readonly ("generate" | "stream")[];
}

export interface ModelGatewayConfiguration {
  readonly workloads: Readonly<Record<string, readonly ModelRouteConfiguration[]>>;
  readonly providers?: readonly CustomModelProviderConfiguration[];
  readonly retry?: RouteRetryPolicy;
  readonly attempt_timeout_ms?: number;
}

export function createModelRoutingPolicy(
  configuration: ModelGatewayConfiguration,
): ModelRoutingPolicy {
  const routes: Record<string, ModelRoute[]> = {};
  for (const [workload, candidates] of Object.entries(configuration.workloads)) {
    if (!workload || candidates.length === 0) {
      throw new ModelGatewayError("INVALID_REQUEST", "Every workload requires a model route", false);
    }
    routes[workload] = candidates.map((candidate, index) => {
      if (!candidate.provider || !candidate.model) {
        throw new ModelGatewayError("INVALID_REQUEST", `Invalid route for ${workload}`, false);
      }
      return {
        route_id: `${workload}.${index + 1}`,
        transport_id: "pi-ai",
        provider: candidate.provider,
        model: candidate.model,
        capabilities: candidate.capabilities ?? ["generate", "stream"],
      };
    });
  }
  const retry = configuration.retry ?? {
    max_attempts: 2,
    initial_backoff_ms: 250,
    max_backoff_ms: 2_000,
  };
  const attemptTimeout = configuration.attempt_timeout_ms ?? 30_000;
  return {
    snapshot: snapshotId("routing", "model-routing.v1", {
      routes,
      retry,
      attempt_timeout_ms: attemptTimeout,
    }),
    routes,
    retry,
    attempt_timeout_ms: attemptTimeout,
  };
}

export function createPiAiModelGateway(
  configuration: ModelGatewayConfiguration,
  options: { readonly observer?: ModelInvocationObserver } = {},
): RoutedModelGateway {
  return new RoutedModelGateway({
    policy: createModelRoutingPolicy(configuration),
    transports: [createConfiguredPiAiTransport(configuration.providers)],
    ...(options.observer ? { observer: options.observer } : {}),
  });
}

export function loadModelGatewayConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ModelGatewayConfiguration {
  const encoded = environment.FIREFLY_MODEL_ROUTES;
  if (!encoded) {
    throw new ModelGatewayError(
      "INVALID_REQUEST",
      "FIREFLY_MODEL_ROUTES must contain a JSON workload-to-model routing map",
      false,
    );
  }
  let workloads: unknown;
  try {
    workloads = JSON.parse(encoded);
  } catch (error) {
    throw new ModelGatewayError("INVALID_REQUEST", "FIREFLY_MODEL_ROUTES is not valid JSON", false, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isRouteMap(workloads)) {
    throw new ModelGatewayError("INVALID_REQUEST", "FIREFLY_MODEL_ROUTES has an invalid shape", false);
  }
  const providers = parseCustomProviders(environment.FIREFLY_MODEL_PROVIDERS);
  return providers.length > 0 ? { workloads, providers } : { workloads };
}

function parseCustomProviders(encoded: string | undefined): readonly CustomModelProviderConfiguration[] {
  if (!encoded?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new ModelGatewayError("INVALID_REQUEST", "FIREFLY_MODEL_PROVIDERS is not valid JSON", false, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!Array.isArray(value)) {
    throw new ModelGatewayError("INVALID_REQUEST", "FIREFLY_MODEL_PROVIDERS must be an array", false);
  }
  return value.map((provider, index) => parseCustomProvider(provider, index));
}

function parseCustomProvider(value: unknown, index: number): CustomModelProviderConfiguration {
  if (!isRecord(value)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom model provider ${index} is invalid`, false);
  }
  const id = stringField(value.id, `providers[${index}].id`);
  const baseUrl = stringField(value.base_url, `providers[${index}].base_url`);
  const api = value.api;
  if (api !== "openai-completions" && api !== "openai-responses") {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider ${id} has an unsupported api`, false);
  }
  const models = value.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider ${id} requires models`, false);
  }
  return {
    id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    base_url: baseUrl,
    api,
    ...(typeof value.api_key_env === "string" ? { api_key_env: value.api_key_env } : {}),
    ...(value.allow_insecure_localhost === true ? { allow_insecure_localhost: true } : {}),
    models: models.map((model, modelIndex) => parseCustomModel(model, id, modelIndex)),
  };
}

function parseCustomModel(value: unknown, provider: string, index: number) {
  if (!isRecord(value)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom model ${provider}[${index}] is invalid`, false);
  }
  const id = stringField(value.id, `providers.${provider}.models[${index}].id`);
  const numbers = ["context_window", "max_output_tokens", "input_cost_per_million", "output_cost_per_million"] as const;
  for (const field of numbers) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) {
      throw new ModelGatewayError("INVALID_REQUEST", `Custom model ${provider}/${id} has invalid ${field}`, false);
    }
  }
  const contextWindow = value.context_window as number;
  const maxOutputTokens = value.max_output_tokens as number;
  const inputCost = value.input_cost_per_million as number;
  const outputCost = value.output_cost_per_million as number;
  if (contextWindow <= 0 || maxOutputTokens <= 0) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom model ${provider}/${id} limits must be positive`, false);
  }
  return {
    id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    input_cost_per_million: inputCost,
    output_cost_per_million: outputCost,
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
  };
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModelGatewayError("INVALID_REQUEST", `${field} must be a non-empty string`, false);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteMap(value: unknown): value is Record<string, readonly ModelRouteConfiguration[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (routes) =>
        Array.isArray(routes) &&
        routes.length > 0 &&
        routes.every(
          (route) =>
            typeof route === "object" &&
            route !== null &&
            typeof (route as Record<string, unknown>).provider === "string" &&
            typeof (route as Record<string, unknown>).model === "string",
        ),
    )
  );
}
