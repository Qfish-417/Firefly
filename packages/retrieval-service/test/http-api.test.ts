import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";

import { createHmacRetrievalIdentityResolver, createRetrievalApiServer, RetrievalGateway } from "../src/index.ts";
import { createHmac } from "node:crypto";

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

test("retrieval HTTP API replaces caller principal with a signed server identity", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async (call) => [{ id: call.principal.tenant_id, content: "identity-bound", score: 1, token_count: 2, source_type: "text/plain", citation: { artifact_id: "a.identity", uri: "s3://bucket/identity.txt", digest: `sha256:${"c".repeat(64)}` } }] }],
    authorization: { canRead: async () => true },
  });
  const secret = "identity-secret-012345678901234567890123";
  const now = Date.parse("2026-08-15T00:00:00.000Z");
  const claims = { principal: { tenant_id: "tenant.trusted", user_id: "user.trusted" }, agent_id: "learning-scientist", issued_at_ms: now, expires_at_ms: now + 60_000 };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");
  const server = createRetrievalApiServer(gateway, {
    resolve_identity: createHmacRetrievalIdentityResolver(secret, { now: () => now }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await httpJson(`http://127.0.0.1:${address.port}`, "POST", "/retrieval", { query_id: "q.identity.1", original_query: "identity", intent: "fact_lookup", agent_id: "learning-director", principal: { tenant_id: "tenant.attacker" }, purpose: "answer", token_budget: 500, estimated_chunk_tokens: 20, require_citations: true }, { "x-firefly-identity": encoded, "x-firefly-signature": signature });
    assert.equal(response.status, 200);
    assert.equal((response.body as { evidence: readonly { evidence_id: string }[] }).evidence[0]?.evidence_id, "tenant.trusted");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retrieval HTTP API rejects malformed structured filters before gateway execution", async () => {
  const gateway = new RetrievalGateway({
    retrievers: [],
    authorization: { canRead: async () => true },
    aggregator: { aggregate: async () => ({ operation: "count_distinct", value: 0, included_ids: [], excluded_reasons: [], conflicts: [] }) },
  });
  const server = createRetrievalApiServer(gateway);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const missing = await httpJson(base, "POST", "/retrieval", {
      query_id: "q.filters.missing", original_query: "count", intent: "count_events", agent_id: "learning-director",
      principal: { tenant_id: "tenant.filters" }, purpose: "test", token_budget: 100, estimated_chunk_tokens: 10, require_citations: false,
    });
    assert.equal(missing.status, 400);
    const reversed = await httpJson(base, "POST", "/retrieval", {
      query_id: "q.filters.reversed", original_query: "count", intent: "count_events", agent_id: "learning-director",
      principal: { tenant_id: "tenant.filters" }, purpose: "test", token_budget: 100, estimated_chunk_tokens: 10, require_citations: false,
      structured_filters: { subject_id: "subject", event_type: "attempt", from: "2026-08-02T00:00:00Z", to: "2026-08-01T00:00:00Z" },
    });
    assert.equal(reversed.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retrieval HTTP API rejects a signed identity whose principal agent contradicts the claim", async () => {
  const gateway = new RetrievalGateway({ retrievers: [], authorization: { canRead: async () => true } });
  const secret = "identity-secret-012345678901234567890123";
  const now = Date.parse("2026-08-15T00:00:00.000Z");
  const claims = { principal: { tenant_id: "tenant.trusted", agent_id: "learning-director" }, agent_id: "learning-scientist", issued_at_ms: now, expires_at_ms: now + 60_000 };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("hex");
  const server = createRetrievalApiServer(gateway, { resolve_identity: createHmacRetrievalIdentityResolver(secret, { now: () => now }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await httpJson(`http://127.0.0.1:${address.port}`, "POST", "/retrieval", {
      query_id: "q.identity.invalid", original_query: "identity", intent: "fact_lookup", agent_id: "learning-director",
      principal: { tenant_id: "tenant.attacker" }, purpose: "answer", token_budget: 500, estimated_chunk_tokens: 20, require_citations: true,
    }, { "x-firefly-identity": encoded, "x-firefly-signature": signature });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function httpJson(base: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(`${base}${path}`, { method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...extraHeaders } : extraHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (payload) req.end(payload); else req.end();
  });
}
