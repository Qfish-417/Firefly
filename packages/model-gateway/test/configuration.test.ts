import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelGatewayError,
  createModelRoutingPolicy,
  loadModelGatewayConfiguration,
} from "../src/index.ts";

test("routing configuration preserves fallback order and produces a stable snapshot", () => {
  const configuration = {
    workloads: {
      "learning-scientist.analyze": [
        { provider: "anthropic", model: "primary" },
        { provider: "openai", model: "fallback" },
      ],
    },
  } as const;
  const first = createModelRoutingPolicy(configuration);
  const second = createModelRoutingPolicy(configuration);

  assert.equal(first.routes["learning-scientist.analyze"]?.[0]?.provider, "anthropic");
  assert.equal(first.routes["learning-scientist.analyze"]?.[1]?.provider, "openai");
  assert.equal(first.snapshot, second.snapshot);
});

test("environment loader reads routes only and does not require API keys", () => {
  const configuration = loadModelGatewayConfiguration({
    FIREFLY_MODEL_ROUTES: JSON.stringify({
      "learning-director.mission-plan": [{ provider: "openai", model: "mission-model" }],
    }),
  });
  assert.equal(configuration.workloads["learning-director.mission-plan"]?.[0]?.model, "mission-model");
});

test("environment loader fails closed when routing is absent", () => {
  assert.throws(
    () => loadModelGatewayConfiguration({}),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "INVALID_REQUEST",
  );
});
