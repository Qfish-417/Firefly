import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import {
  ModelGatewayError,
  PiAiGenerationTransport,
  type PiAiModels,
  type TransportCall,
} from "../src/index.ts";

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://models.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 2_000,
};

test("pi-ai adapter maps model metadata, text and usage without exposing credentials", async () => {
  const models = fakeModels(message([{ type: "text", text: "result" }]));
  const adapter = new PiAiGenerationTransport(models, () => 1_000);

  const descriptor = adapter.describe({ provider: "test-provider", model: "test-model" });
  const result = await adapter.generate(call());

  assert.equal(descriptor.api, "openai-responses");
  assert.match(descriptor.snapshot, /^model:pi-ai-0\.83\.0:sha256:/);
  assert.equal(result.text, "result");
  assert.equal(result.usage.cost_usd, 0.002);
  assert.doesNotMatch(descriptor.snapshot, /api.key|secret/i);
});

test("pi-ai adapter rejects model tool calls instead of executing or returning them", async () => {
  const models = fakeModels(
    message([{ type: "toolCall", id: "call-1", name: "write_file", arguments: { path: "x" } }], "toolUse"),
  );
  const adapter = new PiAiGenerationTransport(models);

  await assert.rejects(
    adapter.generate(call()),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "PROVIDER_TOOL_CALL_FORBIDDEN",
  );
});

function fakeModels(response: AssistantMessage): PiAiModels {
  return {
    getModel: (provider: string, modelId: string) =>
      provider === model.provider && modelId === model.id ? model : undefined,
    completeSimple: async () => response,
    streamSimple: () => {
      throw new Error("not used by this test");
    },
  } as unknown as PiAiModels;
}

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
    stopReason,
    timestamp: 1_000,
  };
}

function call(): TransportCall {
  return {
    request_id: "request.pi-ai.unit",
    workload: "learning-scientist.analyze",
    system_prompt: "Return JSON.",
    user_prompt: "Analyze.",
    max_output_tokens: 200,
    effective_max_output_tokens: 200,
    budget: { max_tokens: 500, max_cost_usd: 0.1, max_duration_ms: 10_000 },
    snapshots: { prompt: "prompt:v1", tools: "tools:none", knowledge: "knowledge:v1" },
    target: { provider: "test-provider", model: "test-model" },
    timeout_ms: 5_000,
  };
}
