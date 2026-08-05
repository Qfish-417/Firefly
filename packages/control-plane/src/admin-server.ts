import { pathToFileURL } from "node:url";

import { createDatabase } from "@firefly/persistence";

import { AdminQueryService, createAdminApiServer } from "./admin-api.ts";

async function run(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const port = Number(process.env.ADMIN_PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ADMIN_PORT must be an integer between 1 and 65535");
  }

  const db = createDatabase(connectionString);
  const server = createAdminApiServer(new AdminQueryService(db));
  const shutdown = (): void => {
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`FireFly Admin API listening on http://127.0.0.1:${port}\n`);
  });
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  await run();
}
