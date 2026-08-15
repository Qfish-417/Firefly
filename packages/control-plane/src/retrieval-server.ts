import { createDatabase } from "@firefly/persistence";
import { HttpEmbeddingProvider } from "@firefly/model-gateway";
import { PostgresLexicalRetriever, PostgresMemoryAuthorization, PostgresStructuredEventAggregator, PostgresVectorRetriever } from "@firefly/retrieval-postgres";
import { RetrievalGateway, createHmacRetrievalIdentityResolver, createRetrievalApiServer } from "@firefly/retrieval-service";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const apiToken = requiredEnvironment("RETRIEVAL_API_TOKEN");
const identitySecret = requiredEnvironment("RETRIEVAL_IDENTITY_HMAC_SECRET");
const port = integerEnvironment("RETRIEVAL_PORT", 3200, 1, 65_535);
const host = process.env.RETRIEVAL_HOST?.trim() || "127.0.0.1";
const logicalName = process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid";
const embedding = embeddingConfiguration();
const db = createDatabase(databaseUrl);
const gateway = new RetrievalGateway({
  retrievers: [
    new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName),
    ...(embedding ? [new PostgresVectorRetriever({
      db, embeddings: new HttpEmbeddingProvider(embedding.provider), embedding_model: embedding.model_snapshot,
      embedding_budget: embedding.budget, logical_name: logicalName,
    })] : []),
  ],
  authorization: new PostgresMemoryAuthorization(db, logicalName),
  aggregator: new PostgresStructuredEventAggregator(db),
});
const server = createRetrievalApiServer(gateway, {
  max_body_bytes: integerEnvironment("RETRIEVAL_MAX_BODY_BYTES", 256_000, 1_024, 10_000_000),
  request_timeout_ms: integerEnvironment("RETRIEVAL_REQUEST_TIMEOUT_MS", 30_000, 100, 300_000),
  authenticate: (request) => request.headers.authorization === `Bearer ${apiToken}`,
  resolve_identity: createHmacRetrievalIdentityResolver(identitySecret),
});
const shutdown = (): void => { server.close(() => { void db.destroy().finally(() => process.exit(0)); }); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, host, () => process.stdout.write(`FireFly Retrieval API listening on http://${host}:${port}\n`));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
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
    provider: { endpoint, model, dimensions: parsedDimensions, timeout_ms: maxDuration, ...(process.env.EMBEDDING_API_KEY?.trim() ? { api_key: process.env.EMBEDDING_API_KEY.trim() } : {}) },
    model_snapshot: snapshot,
    budget: { max_tokens: maxTokens, max_cost_usd: 0, max_duration_ms: maxDuration },
  };
}
