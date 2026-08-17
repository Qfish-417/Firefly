import type { Api, AuthCheck, Model, Models, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type { ModelGatewayConfiguration } from "./configuration.ts";

export type ModelRouteDiagnosticIssue =
  | "provider_not_found"
  | "model_not_found"
  | "text_input_unsupported"
  | "auth_missing"
  | "auth_check_failed";

export interface ModelProviderSummary {
  readonly provider: string;
  readonly model_count: number;
}

export interface ModelCatalogEntry {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly api: string;
  readonly text_input: boolean;
  readonly image_input: boolean;
  readonly reasoning: boolean;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_cost_per_million: number;
  readonly output_cost_per_million: number;
}

export interface ModelRouteDiagnostic {
  readonly workload: string;
  readonly fallback_order: number;
  readonly provider: string;
  readonly model: string;
  readonly exists: boolean;
  readonly text_input: boolean;
  readonly api?: string;
  readonly auth_configured: boolean;
  readonly auth_type?: AuthCheck["type"];
  readonly auth_source?: string;
  readonly ready: boolean;
  readonly issues: readonly ModelRouteDiagnosticIssue[];
}

export interface ModelGatewayDiagnosticReport {
  readonly schema_version: 1;
  readonly ready: boolean;
  readonly configured_routes: number;
  readonly ready_routes: number;
  readonly routes: readonly ModelRouteDiagnostic[];
  readonly privacy: "credential_metadata_only";
}

export type ModelCatalogPort = Pick<
  Models,
  "getProviders" | "getModels" | "getProvider" | "getModel" | "checkAuth"
>;

export function createBuiltinModelCatalog(): ModelCatalogPort {
  return builtinModels();
}

export function listModelProviders(
  models: ModelCatalogPort = createBuiltinModelCatalog(),
): readonly ModelProviderSummary[] {
  return models
    .getProviders()
    .map((provider: Provider) => ({
      provider: provider.id,
      model_count: models.getModels(provider.id).length,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

export function listGenerationModels(
  provider: string,
  models: ModelCatalogPort = createBuiltinModelCatalog(),
): readonly ModelCatalogEntry[] {
  return models
    .getModels(provider)
    .map(modelCatalogEntry)
    .sort((left, right) => left.model.localeCompare(right.model));
}

export async function diagnoseModelGatewayConfiguration(
  configuration: ModelGatewayConfiguration,
  models: ModelCatalogPort = createBuiltinModelCatalog(),
): Promise<ModelGatewayDiagnosticReport> {
  const authChecks = new Map<string, Promise<AuthState>>();
  const routes: ModelRouteDiagnostic[] = [];
  for (const [workload, candidates] of Object.entries(configuration.workloads)) {
    for (const [index, candidate] of candidates.entries()) {
      const providerExists = Boolean(models.getProvider(candidate.provider));
      const model = providerExists ? models.getModel(candidate.provider, candidate.model) : undefined;
      const auth = providerExists
        ? await cachedAuthCheck(candidate.provider, models, authChecks)
        : { configured: false, failed: false };
      const issues: ModelRouteDiagnosticIssue[] = [];
      if (!providerExists) issues.push("provider_not_found");
      else if (!model) issues.push("model_not_found");
      if (model && !model.input.includes("text")) issues.push("text_input_unsupported");
      if (providerExists && auth.failed) issues.push("auth_check_failed");
      else if (providerExists && !auth.configured) issues.push("auth_missing");
      routes.push({
        workload,
        fallback_order: index + 1,
        provider: candidate.provider,
        model: candidate.model,
        exists: Boolean(model),
        text_input: model?.input.includes("text") ?? false,
        ...(model ? { api: model.api } : {}),
        auth_configured: auth.configured,
        ...(auth.check ? { auth_type: auth.check.type } : {}),
        ...(auth.check?.source ? { auth_source: auth.check.source } : {}),
        ready: issues.length === 0,
        issues,
      });
    }
  }
  return {
    schema_version: 1,
    ready: routes.length > 0 && routes.every((route) => route.ready),
    configured_routes: routes.length,
    ready_routes: routes.filter((route) => route.ready).length,
    routes,
    privacy: "credential_metadata_only",
  };
}

interface AuthState {
  readonly configured: boolean;
  readonly failed: boolean;
  readonly check?: AuthCheck;
}

async function cachedAuthCheck(
  provider: string,
  models: ModelCatalogPort,
  checks: Map<string, Promise<AuthState>>,
): Promise<AuthState> {
  const existing = checks.get(provider);
  if (existing) return existing;
  const pending = models
    .checkAuth(provider)
    .then((check) => ({ configured: Boolean(check), failed: false, ...(check ? { check } : {}) }))
    .catch(() => ({ configured: false, failed: true }));
  checks.set(provider, pending);
  return pending;
}

function modelCatalogEntry(model: Model<Api>): ModelCatalogEntry {
  return {
    provider: model.provider,
    model: model.id,
    name: model.name,
    api: model.api,
    text_input: model.input.includes("text"),
    image_input: model.input.includes("image"),
    reasoning: model.reasoning,
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    input_cost_per_million: model.cost.input,
    output_cost_per_million: model.cost.output,
  };
}
