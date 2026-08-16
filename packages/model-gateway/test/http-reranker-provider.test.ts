import assert from "node:assert/strict";
import test from "node:test";

import { HttpRerankerProvider, ModelGatewayError } from "../src/index.ts";

const budget = { max_tokens: 100, max_cost_usd: 0.05, max_duration_ms: 5_000 } as const;

test("HTTP reranker sends bounded text candidates and preserves provider ranking indexes", async () => {
  let body: Record<string, unknown> | undefined;
  let redirect: RequestRedirect | undefined;
  const provider = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank",
    api_key: "secret",
    model: "rerank-test",
    fetch_impl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      redirect = init?.redirect;
      return Response.json({
        results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }],
        usage: { input_tokens: 7, total_tokens: 7, cost_usd: 0.01 },
      });
    },
  });

  const result = await provider.rerank({ request_id: "rerank.http.1", workload: "retrieval.query.rerank", query: "solar output", documents: ["alpha", "beta"], top_k: 2, budget });

  assert.deepEqual(body, { model: "rerank-test", query: "solar output", documents: ["alpha", "beta"], top_k: 2 });
  assert.equal(redirect, "error");
  assert.deepEqual(result.rankings, [{ index: 1, score: 0.9 }, { index: 0, score: 0.4 }]);
  assert.equal(result.usage.cost_usd, 0.01);
});

test("HTTP reranker requires HTTPS unless localhost development is explicit", () => {
  assert.throws(() => new HttpRerankerProvider({ endpoint: "http://rerank.example.test/v1/rerank", model: "test" }), /must use HTTPS/);
  assert.throws(() => new HttpRerankerProvider({ endpoint: "https://user:secret@rerank.example.test/v1/rerank", model: "test" }), /must not contain URL credentials/);
  assert.doesNotThrow(() => new HttpRerankerProvider({ endpoint: "http://127.0.0.1:8080/rerank", model: "test", allow_insecure_localhost: true }));
});

test("HTTP reranker rejects duplicate, out-of-range and non-normalized rankings", async () => {
  for (const results of [
    [{ index: 0, score: 0.9 }, { index: 0, score: 0.8 }],
    [{ index: 0, score: 0.9 }, { index: 2, score: 0.8 }],
    [{ index: 0, score: 1.1 }, { index: 1, score: 0.8 }],
  ]) {
    const provider = new HttpRerankerProvider({ endpoint: "https://rerank.example.test/v1/rerank", model: "test", fetch_impl: async () => Response.json({ results }) });
    await assert.rejects(
      provider.rerank({ request_id: "rerank.invalid", workload: "test", query: "query", documents: ["a", "b"], top_k: 2, budget }),
      (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR" && error.retryable === false,
    );
  }
});

test("HTTP reranker enforces response and reported budget limits", async () => {
  const oversized = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank", model: "test", max_response_bytes: 1_024,
    fetch_impl: async () => new Response("{}", { headers: { "content-length": "2048" } }),
  });
  await assert.rejects(oversized.rerank({ request_id: "rerank.bytes", workload: "test", query: "q", documents: ["a"], top_k: 1, budget }), /byte limit/);

  const overBudget = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank", model: "test",
    fetch_impl: async () => Response.json({ results: [{ index: 0, score: 0.8 }], usage: { total_tokens: 101 } }),
  });
  await assert.rejects(
    overBudget.rerank({ request_id: "rerank.budget", workload: "test", query: "q", documents: ["a"], top_k: 1, budget }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "BUDGET_EXCEEDED",
  );

  const invalidUsage = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank", model: "test",
    fetch_impl: async () => Response.json({ results: [{ index: 0, score: 0.8 }], usage: { total_tokens: -1 } }),
  });
  await assert.rejects(
    invalidUsage.rerank({ request_id: "rerank.usage", workload: "test", query: "q", documents: ["a"], top_k: 1, budget }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR" && error.retryable === false,
  );
});

test("HTTP reranker distinguishes retryable HTTP outages from malformed success payloads", async () => {
  const outage = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank", model: "test",
    fetch_impl: async () => new Response("temporarily unavailable", { status: 503 }),
  });
  await assert.rejects(
    outage.rerank({ request_id: "rerank.outage", workload: "test", query: "q", documents: ["a"], top_k: 1, budget }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR" && error.retryable === true,
  );

  const malformed = new HttpRerankerProvider({
    endpoint: "https://rerank.example.test/v1/rerank", model: "test",
    fetch_impl: async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(
    malformed.rerank({ request_id: "rerank.malformed", workload: "test", query: "q", documents: ["a"], top_k: 1, budget }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR" && error.retryable === false,
  );
});
