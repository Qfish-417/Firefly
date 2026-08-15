import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";

import { createRetrievalApiServer, RetrievalGateway } from "../src/index.ts";

test("retrieval HTTP API validates bodies, exposes health and returns governed packs", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => [
      { id: "hit.1", content: "text evidence one", score: 1, token_count: 3, source_type: "text/plain", citation: { artifact_id: "a.1", uri: "s3://bucket/a.txt", digest: `sha256:${"a".repeat(64)}` } },
      { id: "hit.2", content: "text evidence two", score: 0.9, token_count: 3, source_type: "text/plain", citation: { artifact_id: "a.2", uri: "s3://bucket/b.txt", digest: `sha256:${"b".repeat(64)}` } },
    ] }],
    authorization: { canRead: async () => true },
  });
  const server = createRetrievalApiServer(gateway, { request_timeout_ms: 5_000 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const health = await httpJson(url, "GET", "/health");
    assert.equal(health.status, 200);
    const valid = await httpJson(url, "POST", "/retrieval", { query_id: "q.http.1", original_query: "find text", intent: "fact_lookup", agent_id: "learning-director", principal: { tenant_id: "tenant.http" }, purpose: "answer", token_budget: 500, estimated_chunk_tokens: 20, require_citations: true });
    assert.equal(valid.status, 200);
    const pack = valid.body as { status: string; schema_version: number; query_id: string; evidence: readonly unknown[] };
    assert.equal(pack.schema_version, 1);
    assert.equal(pack.query_id, "q.http.1");
    assert.ok(["sufficient", "insufficient"].includes(pack.status));
    assert.ok(pack.evidence.length >= 1);
    const invalid = await httpJson(url, "POST", "/retrieval", { intent: "fact_lookup" });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function httpJson(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(`${base}${path}`, { method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (payload) req.end(payload); else req.end();
  });
}
