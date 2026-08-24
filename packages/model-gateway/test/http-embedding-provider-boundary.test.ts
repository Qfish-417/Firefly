import assert from "node:assert/strict";
import test from "node:test";
import { HttpEmbeddingProvider } from "../src/http-embedding-provider.ts";
import { ModelGatewayError } from "../src/errors.ts";

function chunkedResponse(totalBytes: number): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      const size = Math.min(64 * 1024, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
  });
  // deliberately no content-length, as a chunked provider would send
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

const base = { endpoint: "https://provider.test/v1/embeddings", model: "m", allow_insecure_localhost: false } as const;
const req = {
  request_id: "r1", workload: "w", inputs: ["hello"],
  budget: { max_tokens: 100, max_cost_usd: 1, max_duration_ms: 10_000 },
} as const;

test("a chunked oversize body is refused while streaming", async () => {
  const provider = new HttpEmbeddingProvider({ ...base, max_response_bytes: 1_024, fetch_impl: async () => chunkedResponse(8 * 1024 * 1024) });
  await assert.rejects(() => provider.embed(req as never), /byte limit/u);
});

test("a redirect is refused rather than followed", async () => {
  let called = 0;
  const provider = new HttpEmbeddingProvider({ ...base, fetch_impl: async (_u, init) => {
    called += 1;
    assert.equal((init as RequestInit).redirect, "error");
    throw new TypeError("fetch failed: unexpected redirect");
  } });
  await assert.rejects(() => provider.embed(req as never));
  assert.equal(called, 1);
});

test("plain HTTP and URL credentials are refused at construction", () => {
  assert.throws(() => new HttpEmbeddingProvider({ ...base, endpoint: "http://provider.test/v1" }), /HTTPS/u);
  assert.throws(() => new HttpEmbeddingProvider({ ...base, endpoint: "https://user:pw@provider.test/v1" }), /credentials/u);
  assert.doesNotThrow(() => new HttpEmbeddingProvider({ ...base, endpoint: "http://127.0.0.1:8000/v1", allow_insecure_localhost: true }));
});

test("a non-JSON content type is refused", async () => {
  const provider = new HttpEmbeddingProvider({ ...base, fetch_impl: async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }) });
  await assert.rejects(() => provider.embed(req as never), /application\/json/u);
});

/**
 * Headers can arrive long before the body finishes, so an abort during body transfer surfaces at the
 * stream reader rather than at `fetch`. Without translation the raw `DOMException` escapes the
 * gateway: the caller sees no TIMEOUT code and no retryable flag, and nothing reaches the audit
 * ledger. Observed while embedding 64 chunks of 2048 dimensions, where the ~2.7MB JSON body
 * dominates the request.
 */
test("an abort during body streaming is reported as a retryable gateway timeout", async () => {
  const provider = new HttpEmbeddingProvider({
    ...base,
    fetch_impl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['));
            // Abort mid-body, exactly as a timeout on a large response would.
            controller.error(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    provider.embed({ ...req, request_id: "embed.body.timeout" }),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "TIMEOUT" && error.retryable === true,
  );
});

test("an unexpected body stream failure is reported as a retryable provider error", async () => {
  const provider = new HttpEmbeddingProvider({
    ...base,
    fetch_impl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket closed"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    provider.embed({ ...req, request_id: "embed.body.reset" }),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "PROVIDER_ERROR" && error.retryable === true,
  );
});
