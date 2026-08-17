import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
  diagnoseModelGatewayConfiguration,
  listGenerationModels,
  listModelProviders,
  type ModelCatalogPort,
} from "../src/index.ts";

test("built-in catalog exposes provider and text-generation metadata without credentials", () => {
  const providers = listModelProviders();
  assert.ok(providers.some((provider) => provider.provider === "deepseek"));
  assert.ok(providers.some((provider) => provider.provider === "openai"));
  assert.ok(providers.some((provider) => provider.provider === "anthropic"));
  const deepseek = listGenerationModels("deepseek");
  assert.ok(deepseek.length > 0);
  assert.ok(deepseek.every((model) => model.provider === "deepseek" && model.text_input));
  assert.equal("api_key" in deepseek[0]!, false);
});

test("model doctor checks fallback routes, text support and provider auth once", async () => {
  const textModel = model("provider-ready", "text-model", ["text"]);
  const imageModel = model("provider-no-auth", "image-model", ["image"]);
  const authCalls = new Map<string, number>();
  const models = fakeCatalog([textModel, imageModel], async (provider) => {
    authCalls.set(provider, (authCalls.get(provider) ?? 0) + 1);
    return provider === "provider-ready"
      ? { type: "api_key" as const, source: "READY_API_KEY" }
      : undefined;
  });

  const report = await diagnoseModelGatewayConfiguration(
    {
      workloads: {
        "learning-director.mission-plan": [
          { provider: "provider-ready", model: "text-model" },
          { provider: "provider-ready", model: "missing-model" },
        ],
        "learning-scientist.analyze": [
          { provider: "provider-no-auth", model: "image-model" },
        ],
        "experience-engineer.patch": [
          { provider: "missing-provider", model: "anything" },
        ],
      },
    },
    models,
  );

  assert.equal(report.ready, false);
  assert.equal(report.configured_routes, 4);
  assert.equal(report.ready_routes, 1);
  assert.deepEqual(report.routes.map((route) => route.issues), [
    [],
    ["model_not_found"],
    ["text_input_unsupported", "auth_missing"],
    ["provider_not_found"],
  ]);
  assert.equal(authCalls.get("provider-ready"), 1);
  assert.equal(authCalls.get("provider-no-auth"), 1);
  assert.equal(report.routes[0]?.auth_source, "READY_API_KEY");
  assert.equal(report.privacy, "credential_metadata_only");
});

function model(
  provider: string,
  id: string,
  input: readonly ("text" | "image")[],
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://models.example.test/v1",
    reasoning: false,
    input: [...input],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
}

function fakeCatalog(
  entries: readonly Model<Api>[],
  checkAuth: (provider: string) => Promise<{ readonly type: "api_key"; readonly source?: string } | undefined>,
): ModelCatalogPort {
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  return {
    getProviders: () => providers.map((id) => ({ id })),
    getProvider: (id: string) => providers.includes(id) ? { id } : undefined,
    getModels: (provider?: string) => provider
      ? entries.filter((entry) => entry.provider === provider)
      : entries,
    getModel: (provider: string, id: string) =>
      entries.find((entry) => entry.provider === provider && entry.id === id),
    checkAuth,
  } as unknown as ModelCatalogPort;
}
