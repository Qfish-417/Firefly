import assert from "node:assert/strict";
import test from "node:test";

import { HttpEmbeddingProvider, ModelGatewayError } from "../src/index.ts";

const budget = { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 5_000 } as const;

test("HTTP embedding provider sends text-only OpenAI-compatible requests and restores index order", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new HttpEmbeddingProvider({
    endpoint: "https://embedding.example.test/v1/embeddings", api_key: "secret", model: "text-embedding-test", dimensions: 3,
    fetch_impl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
    },
  });
  const result = await provider.embed({ request_id: "embed.http.1", workload: "retrieval.index.embed", inputs: ["alpha", "beta"], budget });
  assert.deepEqual(body, { model: "text-embedding-test", input: ["alpha", "beta"], dimensions: 3 });
  assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(result.usage.total_tokens, 4);
});

test("HTTP embedding provider rejects response count and dimension drift", async () => {
  const count = new HttpEmbeddingProvider({ endpoint: "https://embedding.example.test/v1/embeddings", model: "test", fetch_impl: async () => Response.json({ data: [] }) });
  await assert.rejects(count.embed({ request_id: "embed.count", workload: "test", inputs: ["a"], budget }), (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR");
  const dimensions = new HttpEmbeddingProvider({ endpoint: "https://embedding.example.test/v1/embeddings", model: "test", dimensions: 3, fetch_impl: async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }) });
  await assert.rejects(dimensions.embed({ request_id: "embed.dimensions", workload: "test", inputs: ["a"], budget }), (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR");
});

test("HTTP embedding provider enforces reported token budgets", async () => {
  const provider = new HttpEmbeddingProvider({ endpoint: "https://embedding.example.test/v1/embeddings", model: "test", fetch_impl: async () => Response.json({ data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 101 } }) });
  await assert.rejects(provider.embed({ request_id: "embed.budget", workload: "test", inputs: ["a"], budget }), (error: unknown) => error instanceof ModelGatewayError && error.code === "BUDGET_EXCEEDED");
});
