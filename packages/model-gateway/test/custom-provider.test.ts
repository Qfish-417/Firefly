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
    RELAY_TEST_API_KEY: "relay-test-key",
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

test("a provider whose api_key_env is unset is refused at load time", () => {
  assert.throws(
    () => loadModelGatewayConfiguration({
      FIREFLY_MODEL_ROUTES: JSON.stringify({
        "learning-scientist.analyze": [{ provider: "relay-test", model: "relay-model" }],
      }),
      FIREFLY_MODEL_PROVIDERS: providerJson,
    }),
    /RELAY_TEST_API_KEY, which is not set/u,
  );

  // A blank value is as unusable as a missing one.
  assert.throws(
    () => loadModelGatewayConfiguration({
      FIREFLY_MODEL_ROUTES: JSON.stringify({
        "learning-scientist.analyze": [{ provider: "relay-test", model: "relay-model" }],
      }),
      FIREFLY_MODEL_PROVIDERS: providerJson,
      RELAY_TEST_API_KEY: "   ",
    }),
    /which is not set/u,
  );
});

test("an empty route map is refused instead of failing at dispatch", () => {
  assert.throws(
    () => loadModelGatewayConfiguration({ FIREFLY_MODEL_ROUTES: "{}" }),
    /at least one workload/u,
  );
});

test("a route naming an undeclared model of a configured provider is refused", () => {
  assert.throws(
    () => loadModelGatewayConfiguration({
      FIREFLY_MODEL_ROUTES: JSON.stringify({
        "learning-scientist.analyze": [{ provider: "relay-test", model: "typo-model" }],
      }),
      FIREFLY_MODEL_PROVIDERS: providerJson,
      RELAY_TEST_API_KEY: "relay-test-key",
    }),
    /which that provider does not declare/u,
  );
});

/**
 * `request_parameters` exists for vendor extensions the portable OpenAI subset does not model.
 * The motivating case: vLLM serving a reasoning model writes its chain of thought into
 * `message.content` unless told otherwise, which breaks every Agent that requires strict JSON
 * (measured with Qwen3.5-4B: the reply began `Thinking Process:`, and `reasoning_effort: "none"`
 * made it parsable). Validation has to reject anything that could rewrite the call itself.
 */
test("request_parameters accepts vendor extensions and refuses to rewrite the call", async () => {
  const build = (parameters: unknown) =>
    loadModelGatewayConfiguration({
      FIREFLY_MODEL_PROVIDERS: JSON.stringify([
        {
          id: "vllm-test",
          base_url: "http://127.0.0.1:11401/v1",
          api: "openai-completions",
          allow_insecure_localhost: true,
          request_parameters: parameters,
          models: [
            { id: "m", context_window: 8_000, max_output_tokens: 1_000, input_cost_per_million: 0, output_cost_per_million: 0 },
          ],
        },
      ]),
      FIREFLY_MODEL_ROUTES: JSON.stringify({ "learning-director.mission-plan": [{ provider: "vllm-test", model: "m" }] }),
    });

  const accepted = build({ reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false }, seed: 7, top_p: 0.9 });
  assert.deepEqual(accepted.providers?.[0]?.request_parameters, {
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
    seed: 7,
    top_p: 0.9,
  });
  // Frozen so a later consumer cannot mutate what was validated.
  assert.equal(Object.isFrozen(accepted.providers?.[0]?.request_parameters), true);

  // Fields the gateway itself frames must not be overridable, even though the injector would also
  // preserve them: silently ignoring an override looks like it applied.
  for (const reserved of ["model", "messages", "stream", "max_tokens", "temperature", "tools"]) {
    assert.throws(
      () => build({ [reserved]: "x" }),
      (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
      `${reserved} must be rejected`,
    );
  }

  // Deep nesting would smuggle structure past validation into an unreviewed request body.
  assert.throws(
    () => build({ nested: { deeper: { value: 1 } } }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => build("not-an-object"),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
  );
});

/**
 * A provider without `api_key_env` must still produce a usable transport. pi-ai raises
 * "No API key for provider" when both the key and an `authorization` header are absent, so an
 * unauthenticated self-hosted endpoint would otherwise be impossible to call at all.
 */
test("a provider without api_key_env still registers and can be resolved", async () => {
  const configuration = loadModelGatewayConfiguration({
    FIREFLY_MODEL_PROVIDERS: JSON.stringify([
      {
        id: "keyless-test",
        base_url: "http://127.0.0.1:11401/v1",
        api: "openai-completions",
        allow_insecure_localhost: true,
        models: [
          { id: "m", context_window: 8_000, max_output_tokens: 1_000, input_cost_per_million: 0, output_cost_per_million: 0 },
        ],
      },
    ]),
    FIREFLY_MODEL_ROUTES: JSON.stringify({ "learning-director.mission-plan": [{ provider: "keyless-test", model: "m" }] }),
  });
  assert.equal(configuration.providers?.[0]?.api_key_env, undefined);
  const models = createConfiguredPiAiModels(configuration.providers);
  const model = models.getModel("keyless-test", "m");
  assert.equal(model?.id, "m");
});
