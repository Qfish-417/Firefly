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
  const server = createRetrievalApiServer(gateway, { request_timeout_ms: 5_000, allow_unauthenticated: true });
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
    authenticate: () => true,
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
  const server = createRetrievalApiServer(gateway, { allow_unauthenticated: true });
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

test("retrieval HTTP API validates comparison and temporal queries before aggregation", async () => {
  const received: unknown[] = [];
  const gateway = new RetrievalGateway({
    retrievers: [],
    authorization: { canRead: async () => true },
    aggregator: {
      aggregate: async ({ request }) => {
        received.push(request);
        if (request.intent === "comparison" && request.structured_query?.kind === "compare_event_counts") {
          return {
            operation: "comparison",
            value: 1,
            included_ids: ["event.left", "event.right"],
            excluded_reasons: [],
            conflicts: [],
            details: {
              kind: "comparison_counts",
              left_subject_id: request.structured_query.left_subject_id,
              left_value: 2,
              right_subject_id: request.structured_query.right_subject_id,
              right_value: 1,
              difference: 1,
            },
          };
        }
        if (request.intent === "temporal" && request.structured_query?.kind === "select_event_time") {
          return {
            operation: "temporal",
            value: "2026-08-01T00:00:00.000Z",
            included_ids: ["event.first"],
            excluded_reasons: [],
            conflicts: [],
            details: {
              kind: "temporal_event",
              subject_id: request.structured_query.subject_id,
              event_type: request.structured_query.event_type,
              selector: request.structured_query.selector,
              event_id: "event.first",
              occurred_from: "2026-08-01T00:00:00.000Z",
              occurred_to: null,
            },
          };
        }
        throw new Error("unexpected structured request");
      },
    },
  });
  const server = createRetrievalApiServer(gateway, { allow_unauthenticated: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const baseRequest = {
    original_query: "compare",
    agent_id: "learning-director",
    principal: { tenant_id: "tenant.structured" },
    purpose: "test",
    token_budget: 100,
    estimated_chunk_tokens: 10,
    require_citations: false,
  };
  try {
    const invalidRequests = [
      { ...baseRequest, query_id: "q.comparison.missing", intent: "comparison" },
      {
        ...baseRequest,
        query_id: "q.comparison.same-subject",
        intent: "comparison",
        structured_query: { kind: "compare_event_counts", left_subject_id: "same", right_subject_id: "same", event_type: "attempt" },
      },
      {
        ...baseRequest,
        query_id: "q.temporal.selector",
        intent: "temporal",
        structured_query: { kind: "select_event_time", subject_id: "learner", event_type: "attempt", selector: "middle" },
      },
      {
        ...baseRequest,
        query_id: "q.structured.mismatch",
        intent: "comparison",
        structured_query: { kind: "select_event_time", subject_id: "learner", event_type: "attempt", selector: "first" },
      },
    ];
    for (const requestBody of invalidRequests) {
      const response = await httpJson(baseUrl, "POST", "/retrieval", requestBody);
      assert.equal(response.status, 400);
    }
    assert.equal(received.length, 0);

    const comparison = await httpJson(baseUrl, "POST", "/retrieval", {
      ...baseRequest,
      query_id: "q.comparison.valid",
      intent: "comparison",
      structured_query: { kind: "compare_event_counts", left_subject_id: "learner.left", right_subject_id: "learner.right", event_type: "attempt" },
    });
    assert.equal(comparison.status, 200);
    const temporal = await httpJson(baseUrl, "POST", "/retrieval", {
      ...baseRequest,
      query_id: "q.temporal.valid",
      intent: "temporal",
      structured_query: { kind: "select_event_time", subject_id: "learner.left", event_type: "attempt", selector: "first" },
    });
    assert.equal(temporal.status, 200);
    assert.equal(received.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retrieval HTTP API validates and routes bounded multi-hop queries", async () => {
  const received: unknown[] = [];
  const gateway = new RetrievalGateway({
    retrievers: [],
    authorization: { canRead: async () => true },
    aggregator: {
      aggregate: async ({ request }) => {
        received.push(request);
        return {
          operation: "path",
          value: 2,
          included_ids: ["edge.a-b", "edge.b-c"],
          excluded_reasons: [],
          conflicts: [],
          details: {
            kind: "relation_path",
            start_node_id: "node.a",
            target_node_id: "node.c",
            direction: "outbound",
            found: true,
            hop_count: 2,
            node_ids: ["node.a", "node.b", "node.c"],
            path_hops: [
              { edge_id: "edge.a-b", from_node_id: "node.a", to_node_id: "node.b", predicate: "depends_on" },
              { edge_id: "edge.b-c", from_node_id: "node.b", to_node_id: "node.c", predicate: "depends_on" },
            ],
          },
        };
      },
    },
  });
  const server = createRetrievalApiServer(gateway, { allow_unauthenticated: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const common = {
    original_query: "what depends on what",
    agent_id: "learning-director",
    principal: { tenant_id: "tenant.graph" },
    purpose: "test",
    token_budget: 100,
    estimated_chunk_tokens: 10,
    require_citations: false,
  };
  try {
    const invalid = await httpJson(base, "POST", "/retrieval", {
      ...common, query_id: "q.graph.invalid", intent: "multi_hop",
      structured_query: { kind: "find_relation_path", start_node_id: "node.a", target_node_id: "node.c", direction: "outbound", max_hops: 7, as_of: "2026-08-16T00:00:00Z" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(received.length, 0);
    const valid = await httpJson(base, "POST", "/retrieval", {
      ...common, query_id: "q.graph.valid", intent: "multi_hop",
      structured_query: { kind: "find_relation_path", start_node_id: "node.a", target_node_id: "node.c", predicates: ["depends_on"], direction: "outbound", max_hops: 3, as_of: "2026-08-16T00:00:00Z" },
    });
    assert.equal(valid.status, 200);
    assert.equal(received.length, 1);
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
  const server = createRetrievalApiServer(gateway, { authenticate: () => true, resolve_identity: createHmacRetrievalIdentityResolver(secret, { now: () => now }) });
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

function passthroughGateway(): RetrievalGateway {
  return new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => [
      { id: "hit.1", content: "text evidence one", score: 1, token_count: 3, source_type: "text/plain", citation: { artifact_id: "a.1", uri: "s3://bucket/a.txt", digest: `sha256:${"a".repeat(64)}` } },
    ] }],
    authorization: { canRead: async () => true },
  });
}

const sampleRequest = {
  query_id: "q.security.1",
  original_query: "security",
  intent: "fact_lookup",
  agent_id: "learning-director",
  principal: { tenant_id: "tenant.a" },
  purpose: "answer",
  token_budget: 500,
  estimated_chunk_tokens: 20,
  require_citations: true,
} as const;

async function withRetrievalServer(
  options: Parameters<typeof createRetrievalApiServer>[1],
  body: (base: string) => Promise<void>,
  gateway: RetrievalGateway = passthroughGateway(),
): Promise<void> {
  const server = createRetrievalApiServer(gateway, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await body(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("the retrieval API refuses to serve without an authenticator and an identity resolver", () => {
  const gateway = passthroughGateway();
  assert.throws(() => createRetrievalApiServer(gateway), /allow_unauthenticated/u);
  assert.throws(() => createRetrievalApiServer(gateway, { authenticate: () => true }), /allow_unauthenticated/u);
  assert.throws(
    () => createRetrievalApiServer(gateway, { resolve_identity: () => undefined }),
    /allow_unauthenticated/u,
  );
});

test("a rejected authenticator returns 401 before the body is parsed", async () => {
  let gatewayCalls = 0;
  const counting = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => { gatewayCalls += 1; return []; } }],
    authorization: { canRead: async () => true },
  });
  await withRetrievalServer({ authenticate: () => false, allow_unauthenticated: true }, async (base) => {
    const response = await httpJson(base, "POST", "/retrieval", sampleRequest);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: "unauthorized" });
    assert.equal(gatewayCalls, 0);
  }, counting);
});

test("an expired or tampered identity claim is rejected", async () => {
  const secret = "identity-secret-value-at-least-32-chars";
  const now = 1_760_000_000_000;
  const sign = (claims: unknown): { encoded: string; signature: string } => {
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { encoded, signature: createHmac("sha256", secret).update(encoded).digest("hex") };
  };
  await withRetrievalServer({
    authenticate: () => true,
    resolve_identity: createHmacRetrievalIdentityResolver(secret, { now: () => now }),
  }, async (base) => {
    const expired = sign({
      principal: { tenant_id: "tenant.a" },
      agent_id: "learning-director",
      expires_at_ms: now - 60_000,
    });
    const expiredResponse = await httpJson(base, "POST", "/retrieval", sampleRequest, {
      "x-firefly-identity": expired.encoded,
      "x-firefly-signature": expired.signature,
    });
    assert.equal(expiredResponse.status, 401);

    const valid = sign({
      principal: { tenant_id: "tenant.a" },
      agent_id: "learning-director",
      expires_at_ms: now + 60_000,
    });
    const flipped = `${valid.signature.slice(0, -1)}${valid.signature.endsWith("0") ? "1" : "0"}`;
    const tampered = await httpJson(base, "POST", "/retrieval", sampleRequest, {
      "x-firefly-identity": valid.encoded,
      "x-firefly-signature": flipped,
    });
    assert.equal(tampered.status, 401);

    const missing = await httpJson(base, "POST", "/retrieval", sampleRequest);
    assert.equal(missing.status, 401);
  });
});

test("an oversize body is refused with 413 and never reaches the gateway", async () => {
  let gatewayCalls = 0;
  const counting = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => { gatewayCalls += 1; return []; } }],
    authorization: { canRead: async () => true },
  });
  await withRetrievalServer({ allow_unauthenticated: true, max_body_bytes: 2_048 }, async (base) => {
    const response = await httpJson(base, "POST", "/retrieval", {
      ...sampleRequest,
      original_query: "x".repeat(4_096),
    });
    assert.equal(response.status, 413);
    assert.equal(gatewayCalls, 0);
  }, counting);
});

test("every retriever failing returns 503, not an empty 200 pack", async () => {
  const failing = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => {
      throw new Error('select * from "questlab"."memory_chunk" - password authentication failed for user "questlab"');
    } }],
    authorization: { canRead: async () => true },
  });
  await withRetrievalServer({ allow_unauthenticated: true }, async (base) => {
    const response = await httpJson(base, "POST", "/retrieval", sampleRequest);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "retrieval_unavailable" });
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("memory_chunk"), false);
  }, failing);
});

test("an authorization backend that is down returns 503 instead of an empty pack", async () => {
  const failing = new RetrievalGateway({
    retrievers: [{ id: "fake.lexical", stage: "lexical", retrieve: async () => [
      { id: "hit.1", content: "text evidence one", score: 1, token_count: 3, source_type: "text/plain", citation: { artifact_id: "a.1", uri: "s3://bucket/a.txt", digest: `sha256:${"a".repeat(64)}` } },
    ] }],
    authorization: { canRead: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=secret"); } },
  });
  await withRetrievalServer({ allow_unauthenticated: true }, async (base) => {
    const response = await httpJson(base, "POST", "/retrieval", sampleRequest);
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(response.body).includes("10.0.0.5"), false);
  }, failing);
});

test("malformed numeric planner inputs are rejected as client errors, not retriever failures", async () => {
  await withRetrievalServer({ allow_unauthenticated: true }, async (base) => {
    // "abc" previously became candidate_k=NaN, reached `LIMIT NaN`, and every retriever was
    // reported as failed with a 422 instead of the request being refused.
    for (const bad of ["abc", 0, -1, 1.5, 100_000]) {
      const response = await httpJson(base, "POST", "/retrieval", { ...sampleRequest, required_entity_count: bad });
      assert.equal(response.status, 400, `required_entity_count=${String(bad)}`);
    }
    for (const bad of ["abc", 5, -1]) {
      const response = await httpJson(base, "POST", "/retrieval", { ...sampleRequest, evidence_coverage_target: bad });
      assert.equal(response.status, 400, `evidence_coverage_target=${String(bad)}`);
    }
    const good = await httpJson(base, "POST", "/retrieval", {
      ...sampleRequest, required_entity_count: 3, evidence_coverage_target: 0.9,
    });
    assert.equal(good.status, 200);
  });
});

test("filters and unknown top-level keys are bounded", async () => {
  await withRetrievalServer({ allow_unauthenticated: true }, async (base) => {
    const badValue = await httpJson(base, "POST", "/retrieval", { ...sampleRequest, filters: { subject: { nested: 1 } } });
    assert.equal(badValue.status, 400);

    const badName = await httpJson(base, "POST", "/retrieval", { ...sampleRequest, filters: { "Bad-Name": "x" } });
    assert.equal(badName.status, 400);

    const tooMany = await httpJson(base, "POST", "/retrieval", {
      ...sampleRequest,
      filters: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, "v"])),
    });
    assert.equal(tooMany.status, 400);

    const unknown = await httpJson(base, "POST", "/retrieval", { ...sampleRequest, injected_field: "surprise" });
    assert.equal(unknown.status, 400);

    const good = await httpJson(base, "POST", "/retrieval", {
      ...sampleRequest, filters: { source_type: "text/plain", verified: true, weight: 2 },
    });
    assert.equal(good.status, 200);
  });
});
