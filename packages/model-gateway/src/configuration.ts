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
  // `{}` satisfies the shape check but routes nothing, so every request would fail at dispatch with
  // a confusing "no route" error instead of at startup.
  if (Object.keys(workloads).length === 0) {
    throw new ModelGatewayError("INVALID_REQUEST", "FIREFLY_MODEL_ROUTES must declare at least one workload", false);
  }
  const providers = parseCustomProviders(environment.FIREFLY_MODEL_PROVIDERS);
  assertCredentialsResolvable(providers, environment);
  assertRoutesResolvable(workloads, providers);
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

/**
 * A provider whose `api_key_env` names a missing or blank variable would otherwise send
 * unauthenticated requests and fail at the first call with an opaque provider 401. A typo in the
 * variable name is the common case.
 */
function assertCredentialsResolvable(
  providers: readonly CustomModelProviderConfiguration[],
  environment: NodeJS.ProcessEnv,
): void {
  for (const provider of providers) {
    if (provider.api_key_env === undefined) continue;
    if (!environment[provider.api_key_env]?.trim()) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        `Custom provider ${provider.id} references ${provider.api_key_env}, which is not set`,
        false,
      );
    }
  }
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
    ...parseRequestParameters(value.request_parameters, id),
    models: models.map((model, modelIndex) => parseCustomModel(model, id, modelIndex)),
  };
}

/**
 * Validates the vendor-extension pass-through.
 *
 * Kept to a flat object of JSON scalars: nesting or functions here would be a way to smuggle
 * structure into a request body that nothing else inspects. Reserved names are rejected outright
 * because silently ignoring them (the injector preserves gateway-set fields) would look like the
 * override took effect.
 */
function parseRequestParameters(
  value: unknown,
  provider: string,
): { request_parameters?: Readonly<Record<string, unknown>> } {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom provider ${provider} request_parameters must be an object`, false);
  }
  const reserved = new Set(["model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "tools", "tool_choice"]);
  for (const [key, parameter] of Object.entries(value)) {
    if (reserved.has(key)) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        `Custom provider ${provider} may not override ${key} through request_parameters`,
        false,
      );
    }
    const kind = typeof parameter;
    const scalar = kind === "string" || kind === "number" || kind === "boolean" || parameter === null;
    const flatRecord = isRecord(parameter) && Object.values(parameter).every((nested) => {
      const nestedKind = typeof nested;
      return nestedKind === "string" || nestedKind === "number" || nestedKind === "boolean" || nested === null;
    });
    if (!scalar && !flatRecord) {
      throw new ModelGatewayError(
        "INVALID_REQUEST",
        `Custom provider ${provider} request_parameters.${key} must be a JSON scalar or a flat object of scalars`,
        false,
      );
    }
  }
  return { request_parameters: Object.freeze({ ...value }) };
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
  const cacheRead = optionalCost(value.cache_read_cost_per_million, provider, id, "cache_read_cost_per_million");
  const cacheWrite = optionalCost(value.cache_write_cost_per_million, provider, id, "cache_write_cost_per_million");
  return {
    id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    input_cost_per_million: inputCost,
    output_cost_per_million: outputCost,
    // Falling back to the input rate keeps cached spend accounted for; a relay that genuinely
    // charges nothing for cache reads can declare 0 explicitly.
    cache_read_cost_per_million: cacheRead ?? inputCost,
    cache_write_cost_per_million: cacheWrite ?? inputCost,
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
  };
}

function optionalCost(value: unknown, provider: string, model: string, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ModelGatewayError("INVALID_REQUEST", `Custom model ${provider}/${model} has invalid ${field}`, false);
  }
  return value;
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

/**
 * Every route naming a configured custom provider must name one of that provider's models.
 *
 * A typo here is otherwise only discovered when the workload first runs, and the failure looks like
 * a provider outage rather than a configuration error. Routes to providers that pi-ai supplies are
 * left alone, since their model catalogue is not known here.
 */
function assertRoutesResolvable(
  workloads: Record<string, readonly ModelRouteConfiguration[]>,
  providers: readonly CustomModelProviderConfiguration[],
): void {
  if (providers.length === 0) return;
  const catalogue = new Map(providers.map((provider) => [provider.id, new Set(provider.models.map((model) => model.id))]));
  for (const [workload, routes] of Object.entries(workloads)) {
    for (const route of routes) {
      const models = catalogue.get(route.provider);
      if (!models) continue;
      if (!models.has(route.model)) {
        throw new ModelGatewayError(
          "INVALID_REQUEST",
          `Workload ${workload} routes to ${route.provider}/${route.model}, which that provider does not declare`,
          false,
        );
      }
    }
  }
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
