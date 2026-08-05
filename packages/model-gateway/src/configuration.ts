import { ModelGatewayError } from "./errors.ts";
import { RoutedModelGateway } from "./gateway.ts";
import { createBuiltinPiAiTransport } from "./pi-ai-adapter.ts";
import { snapshotId } from "./snapshots.ts";
import type { ModelRoute, ModelRoutingPolicy, RouteRetryPolicy } from "./types.ts";

export interface ModelRouteConfiguration {
  readonly provider: string;
  readonly model: string;
  readonly capabilities?: readonly ("generate" | "stream")[];
}

export interface ModelGatewayConfiguration {
  readonly workloads: Readonly<Record<string, readonly ModelRouteConfiguration[]>>;
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
): RoutedModelGateway {
  return new RoutedModelGateway({
    policy: createModelRoutingPolicy(configuration),
    transports: [createBuiltinPiAiTransport()],
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
  return { workloads };
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
