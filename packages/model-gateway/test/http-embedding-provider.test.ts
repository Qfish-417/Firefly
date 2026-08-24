import assert from "node:assert/strict";
import test from "node:test";

import { HttpEmbeddingProvider, ModelGatewayError } from "../src/index.ts";

const budget = { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 5_000 } as const;

/**
 * `dimensions` is a Matryoshka-only parameter: a fixed-width model rejects the whole request when it
 * is present (measured with vLLM 0.27.0 + Qwen3-VL-Embedding-2B: HTTP 400 "does not support
 * Matryoshka embeddings; dimensions must be unset"). Omitting it must therefore be the default,
 * while the response width stays validated either way.
 */
test("embedding dimensions are validated but only sent when explicitly requested", async () => {
  const bodies: Record<string, unknown>[] = [];
  const respond = async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
  };
  const request = { request_id: "embed.dimensions.default", workload: "retrieval.index.embed", inputs: ["alpha"], budget };

  const omitted = new HttpEmbeddingProvider({
    endpoint: "https://embedding.example.test/v1/embeddings", model: "fixed-width", dimensions: 3, fetch_impl: respond,
  });
  await omitted.embed(request);
  assert.deepEqual(bodies[0], { model: "fixed-width", input: ["alpha"] });

  const sent = new HttpEmbeddingProvider({
    endpoint: "https://embedding.example.test/v1/embeddings", model: "matryoshka", dimensions: 3,
    send_dimensions: true, fetch_impl: respond,
  });
  await sent.embed(request);
  assert.deepEqual(bodies[1], { model: "matryoshka", input: ["alpha"], dimensions: 3 });

  // A provider ignoring the requested width must still be caught, whether or not it was sent.
  const mismatched = new HttpEmbeddingProvider({
    endpoint: "https://embedding.example.test/v1/embeddings", model: "fixed-width", dimensions: 8,
    fetch_impl: async () => Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
  });
  await assert.rejects(
    mismatched.embed({ ...request, request_id: "embed.dimensions.mismatch" }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR",
  );
});

test("HTTP embedding provider sends text-only OpenAI-compatible requests and restores index order", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new HttpEmbeddingProvider({
    endpoint: "https://embedding.example.test/v1/embeddings", api_key: "secret", model: "text-embedding-test", dimensions: 3,
    send_dimensions: true,
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
