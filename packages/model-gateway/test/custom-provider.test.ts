import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelGatewayError,
  createConfiguredPiAiModels,
  loadModelGatewayConfiguration,
} from "../src/index.ts";

const providerJson = JSON.stringify([
  {
    id: "relay-test",
    name: "Relay Test",
    base_url: "https://relay.example.test/v1",
    api: "openai-completions",
    api_key_env: "RELAY_TEST_API_KEY",
    models: [
      {
        id: "relay-model",
        context_window: 32_000,
        max_output_tokens: 4_000,
        input_cost_per_million: 0.2,
        output_cost_per_million: 0.8,
      },
    ],
  },
]);

test("custom OpenAI-compatible relay is added to the governed pi-ai catalog", async () => {
  const configuration = loadModelGatewayConfiguration({
    FIREFLY_MODEL_ROUTES: JSON.stringify({
      "learning-scientist.analyze": [{ provider: "relay-test", model: "relay-model" }],
    }),
    FIREFLY_MODEL_PROVIDERS: providerJson,
  });

  const models = createConfiguredPiAiModels(configuration.providers);
  const model = models.getModel("relay-test", "relay-model");
  assert.ok(model);
  assert.equal(model.baseUrl, "https://relay.example.test/v1");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.contextWindow, 32_000);
  assert.equal((await models.checkAuth("relay-test"))?.source, undefined);
});

test("custom relay rejects insecure remote URLs and accepts explicit localhost degradation", () => {
  assert.throws(
    () => createConfiguredPiAiModels([
      {
        id: "remote-http",
        base_url: "http://relay.example.test/v1",
        api: "openai-completions",
        models: [{
          id: "model",
          context_window: 1_000,
          max_output_tokens: 100,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
        }],
      },
    ]),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
  );

  const models = createConfiguredPiAiModels([
    {
      id: "local-relay",
      base_url: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      allow_insecure_localhost: true,
      models: [{
        id: "local-model",
        context_window: 4_000,
        max_output_tokens: 500,
        input_cost_per_million: 0,
        output_cost_per_million: 0,
      }],
    },
  ]);
  assert.ok(models.getModel("local-relay", "local-model"));
});
