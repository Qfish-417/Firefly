import { createDatabase } from "@firefly/persistence";
import { PostgresLexicalRetriever, PostgresMemoryAuthorization, PostgresStructuredEventAggregator } from "@firefly/retrieval-postgres";
import { RetrievalGateway, createHmacRetrievalIdentityResolver, createRetrievalApiServer } from "@firefly/retrieval-service";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const apiToken = requiredEnvironment("RETRIEVAL_API_TOKEN");
const identitySecret = requiredEnvironment("RETRIEVAL_IDENTITY_HMAC_SECRET");
const port = integerEnvironment("RETRIEVAL_PORT", 3200, 1, 65_535);
const logicalName = process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid";
const db = createDatabase(databaseUrl);
const gateway = new RetrievalGateway({
  retrievers: [new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName)],
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
server.listen(port, "127.0.0.1", () => process.stdout.write(`FireFly Retrieval API listening on http://127.0.0.1:${port}\n`));

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
