import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Migrator, type Migration, type MigrationProvider } from "kysely";

import { createDatabase, type QuestLabDatabase } from "./database.ts";

export interface MigrationSummary {
  readonly applied: readonly string[];
}

class PortableFileMigrationProvider implements MigrationProvider {
  private readonly migrationFolder: string;

  constructor(migrationFolder: string) {
    this.migrationFolder = migrationFolder;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    const fileNames = await fs.readdir(this.migrationFolder);

    for (const fileName of fileNames.sort()) {
      if (!fileName.endsWith(".ts") || fileName.endsWith(".d.ts")) {
        continue;
      }

      const moduleUrl = pathToFileURL(path.join(this.migrationFolder, fileName)).href;
      const loaded: unknown = await import(moduleUrl);
      const module = loaded as { readonly default?: unknown; readonly up?: unknown };
      const migration = isMigration(module.default) ? module.default : module;
      if (!isMigration(migration)) {
        throw new TypeError(`Migration ${fileName} does not export an up function`);
      }

      migrations[fileName.slice(0, -3)] = migration;
    }

    return migrations;
  }
}

function isMigration(value: unknown): value is Migration {
  return typeof value === "object" && value !== null && typeof (value as { up?: unknown }).up === "function";
}

export async function migrateToLatest(connectionString: string): Promise<MigrationSummary> {
  const db = createDatabase(connectionString);
  const migrationFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  const migrator = new Migrator({
    db,
    provider: new PortableFileMigrationProvider(migrationFolder),
    migrationTableName: "questlab_migration",
    migrationLockTableName: "questlab_migration_lock",
  });

  try {
    const { error, results = [] } = await migrator.migrateToLatest();
    if (error) {
      throw error;
    }

    return {
      applied: results
        .filter((result) => result.status === "Success")
        .map((result) => result.migrationName),
    };
  } finally {
    await db.destroy();
  }
}

async function runCli(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const summary = await migrateToLatest(connectionString);
  process.stdout.write(`Applied migrations: ${summary.applied.join(", ") || "none"}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  await runCli();
}
