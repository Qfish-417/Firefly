import { createHash, timingSafeEqual } from "node:crypto";

import { createDatabase } from "@firefly/persistence";
import { HttpEmbeddingProvider, HttpRerankerProvider } from "@firefly/model-gateway";
import { PostgresLexicalRetriever, PostgresMemoryAuthorization, PostgresStructuredEventAggregator, PostgresVectorRetriever } from "@firefly/retrieval-postgres";
import { RetrievalGateway, createHmacRetrievalIdentityResolver, createRetrievalApiServer } from "@firefly/retrieval-service";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const apiToken = requiredEnvironment("RETRIEVAL_API_TOKEN");
const identitySecret = requiredEnvironment("RETRIEVAL_IDENTITY_HMAC_SECRET");
const port = integerEnvironment("RETRIEVAL_PORT", 3200, 1, 65_535);
const host = process.env.RETRIEVAL_HOST?.trim() || "127.0.0.1";
const logicalName = process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid";
const embedding = embeddingConfiguration();
const reranker = rerankerConfiguration();
const db = createDatabase(databaseUrl);
const gateway = new RetrievalGateway({
  retrievers: [
    new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName),
    ...(embedding ? [new PostgresVectorRetriever({
      db, embeddings: new HttpEmbeddingProvider(embedding.provider), embedding_model: embedding.model_snapshot,
      embedding_budget: embedding.budget, logical_name: logicalName,
      distance_element_type: distanceElementType(embedding.dimensions),
    })] : []),
  ],
  authorization: new PostgresMemoryAuthorization(db, logicalName),
  aggregator: new PostgresStructuredEventAggregator(db),
  ...(reranker ? {
    reranker: new HttpRerankerProvider(reranker.provider),
    reranker_budget: reranker.budget,
    reranker_failure_mode: reranker.failure_mode,
  } : {}),
});
const server = createRetrievalApiServer(gateway, {
  max_body_bytes: integerEnvironment("RETRIEVAL_MAX_BODY_BYTES", 256_000, 1_024, 10_000_000),
  request_timeout_ms: integerEnvironment("RETRIEVAL_REQUEST_TIMEOUT_MS", 30_000, 100, 300_000),
  authenticate: (request) => matchesBearerToken(request.headers.authorization, apiToken),
  resolve_identity: createHmacRetrievalIdentityResolver(identitySecret),
});
const shutdownGraceMs = integerEnvironment("RETRIEVAL_SHUTDOWN_GRACE_MS", 10_000, 100, 120_000);
const shutdown = (): void => {
  // An idle keep-alive socket keeps `close` from ever firing, so idle sockets are dropped first and
  // a bounded deadline force-closes the rest instead of waiting for SIGKILL mid-query.
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    void db.destroy().finally(() => process.exit(0));
  }, shutdownGraceMs);
  deadline.unref();
  server.close(() => {
    clearTimeout(deadline);
    void db.destroy().finally(() => process.exit(0));
  });
};
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${JSON.stringify({
    type: "retrieval_unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason),
  })}
`);
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host, () => process.stdout.write(`FireFly Retrieval API listening on http://${host}:${port}\n`));

/**
 * Digest-then-compare keeps the check constant-time regardless of the supplied length, so the token
 * cannot be recovered byte by byte from response timing.
 */
function matchesBearerToken(header: string | string[] | undefined, expectedToken: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(header.slice(7), "utf8").digest();
  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(supplied, expected);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}
/**
 * Chooses the distance element type.
 *
 * pgvector caps an ANN index at 2000 dimensions for `vector` and 4000 for `halfvec` (one 8KB index
 * page holds 2000 fp32 or 4000 fp16 components), and no setting relaxes it. Above 2000 dimensions
 * `vector` therefore cannot be ANN-indexed at all, so the default switches to `halfvec` — otherwise
 * vector retrieval silently degrades to a full scan on every query with no way to fix it.
 *
 * Set `EMBEDDING_DISTANCE_ELEMENT_TYPE=vector` to force exact fp32 distances and accept the scan.
 */
function distanceElementType(dimensions: number): "vector" | "halfvec" {
  const configured = process.env.EMBEDDING_DISTANCE_ELEMENT_TYPE?.trim();
  if (configured === "vector" || configured === "halfvec") return configured;
  if (configured !== undefined && configured !== "") {
    throw new TypeError("EMBEDDING_DISTANCE_ELEMENT_TYPE must be 'vector' or 'halfvec'");
  }
  return dimensions > 2000 ? "halfvec" : "vector";
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
function embeddingConfiguration(): {
  readonly provider: ConstructorParameters<typeof HttpEmbeddingProvider>[0];
  readonly model_snapshot: string;
  readonly dimensions: number;
  readonly budget: { readonly max_tokens: number; readonly max_cost_usd: number; readonly max_duration_ms: number };
} | undefined {
  const endpoint = process.env.EMBEDDING_ENDPOINT?.trim();
  const model = process.env.EMBEDDING_MODEL?.trim();
  const snapshot = process.env.EMBEDDING_MODEL_SNAPSHOT?.trim();
  const dimensions = process.env.EMBEDDING_DIMENSIONS?.trim();
  if (!endpoint && !model && !snapshot && !dimensions) return undefined;
  if (!endpoint || !model || !snapshot || !dimensions || !/^\d+$/u.test(dimensions)) {
    throw new TypeError("EMBEDDING_ENDPOINT, EMBEDDING_MODEL, EMBEDDING_MODEL_SNAPSHOT and EMBEDDING_DIMENSIONS must be configured together");
  }
  const parsedDimensions = Number(dimensions);
  if (!Number.isSafeInteger(parsedDimensions) || parsedDimensions < 1 || parsedDimensions > 4096) throw new TypeError("EMBEDDING_DIMENSIONS must be between 1 and 4096");
  const maxTokens = integerEnvironment("EMBEDDING_MAX_TOKENS", 32_000, 1, 100_000_000);
  const maxDuration = integerEnvironment("EMBEDDING_MAX_DURATION_MS", 30_000, 100, 300_000);
  return {
    provider: {
      endpoint,
      model,
      dimensions: parsedDimensions,
      timeout_ms: maxDuration,
      max_response_bytes: integerEnvironment("EMBEDDING_MAX_RESPONSE_BYTES", 8_000_000, 1_024, 100_000_000),
      allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
      // Only Matryoshka-capable models accept `dimensions`; others reject the request outright
      // (measured: vLLM 0.27.0 + Qwen3-VL-Embedding-2B returns HTTP 400). Off unless asked for.
      send_dimensions: process.env.EMBEDDING_SEND_DIMENSIONS === "true",
      ...(process.env.EMBEDDING_API_KEY?.trim() ? { api_key: process.env.EMBEDDING_API_KEY.trim() } : {}),
    },
    model_snapshot: snapshot,
    dimensions: parsedDimensions,
    budget: { max_tokens: maxTokens, max_cost_usd: 0, max_duration_ms: maxDuration },
  };
}

function rerankerConfiguration(): {
  readonly provider: ConstructorParameters<typeof HttpRerankerProvider>[0];
  readonly budget: { readonly max_tokens: number; readonly max_cost_usd: number; readonly max_duration_ms: number };
  readonly failure_mode: "fallback" | "strict";
} | undefined {
  const endpoint = process.env.RERANK_ENDPOINT?.trim();
  const model = process.env.RERANK_MODEL?.trim();
  if (!endpoint && !model) return undefined;
  if (!endpoint || !model) throw new TypeError("RERANK_ENDPOINT and RERANK_MODEL must be configured together");
  const maxDuration = integerEnvironment("RERANK_MAX_DURATION_MS", 10_000, 100, 300_000);
  // Silently degrading ranking quality contradicts the rule that unavailable capabilities are
  // reported, not hidden, so strict is the default and fallback must be chosen deliberately.
  const failureMode = process.env.RERANK_FAILURE_MODE?.trim() || "strict";
  if (failureMode !== "fallback" && failureMode !== "strict") throw new TypeError("RERANK_FAILURE_MODE must be fallback or strict");
  return {
    provider: {
      endpoint,
      model,
      timeout_ms: maxDuration,
      max_response_bytes: integerEnvironment("RERANK_MAX_RESPONSE_BYTES", 1_000_000, 1_024, 10_000_000),
      max_documents: integerEnvironment("RERANK_MAX_DOCUMENTS", 64, 50, 1_000),
      allow_insecure_localhost: process.env.RERANK_ALLOW_INSECURE_LOCALHOST === "true",
      ...(process.env.RERANK_API_KEY?.trim() ? { api_key: process.env.RERANK_API_KEY.trim() } : {}),
    },
    budget: {
      max_tokens: integerEnvironment("RERANK_MAX_TOKENS", 32_000, 1, 100_000_000),
      max_cost_usd: numberEnvironment("RERANK_MAX_COST_USD", 0.05, 0, 1_000),
      max_duration_ms: maxDuration,
    },
    failure_mode: failureMode,
  };
}

function numberEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
