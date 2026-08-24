import { pathToFileURL } from "node:url";

import { createDatabase } from "@firefly/persistence";

import { AdminQueryService, createAdminApiServer } from "./admin-api.ts";

async function run(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const port = integerEnvironment("ADMIN_PORT", 3100, 1, 65_535);
  // The Admin API returns full run traces and cost accounting, so it refuses to serve without a
  // token. `ADMIN_ALLOW_UNAUTHENTICATED=true` is the explicit, auditable local-only escape hatch.
  const apiToken = process.env.ADMIN_API_TOKEN?.trim();
  const allowUnauthenticated = process.env.ADMIN_ALLOW_UNAUTHENTICATED === "true";
  if (!apiToken && !allowUnauthenticated) {
    throw new Error(
      "ADMIN_API_TOKEN is required; set ADMIN_ALLOW_UNAUTHENTICATED=true only for loopback-only local use",
    );
  }
  const shutdownGraceMs = integerEnvironment("ADMIN_SHUTDOWN_GRACE_MS", 10_000, 100, 120_000);

  const db = createDatabase(connectionString);
  const server = createAdminApiServer(
    new AdminQueryService(db),
    apiToken ? { api_token: apiToken } : {},
  );
  const shutdown = (): void => {
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
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`${JSON.stringify({
      type: "admin_unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
    })}\n`);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `${JSON.stringify({
        type: "admin_listening",
        url: `http://127.0.0.1:${port}`,
        authenticated: Boolean(apiToken),
      })}\n`,
    );
  });
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  await run();
}
