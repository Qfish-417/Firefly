import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Migrator, sql, type Migration, type MigrationProvider } from "kysely";

import { createDatabase, type QuestLabDatabase } from "./database.ts";

export interface MigrationSummary {
  readonly applied: readonly string[];
  readonly verified: readonly string[];
}

/**
 * An already-applied migration file no longer matches the checksum recorded when it ran.
 *
 * Kysely's ledger stores only names, so editing an applied migration is silently accepted and the
 * schema quietly diverges from the source tree — the divergence usually surfaces much later as an
 * unexplained runtime error.
 */
export class MigrationChecksumError extends Error {
  readonly migrationName: string;

  constructor(migrationName: string, expected: string, actual: string) {
    super(
      `Migration ${migrationName} changed after it was applied (recorded ${expected.slice(0, 12)}, ` +
        `found ${actual.slice(0, 12)}). Add a new migration instead of editing an applied one.`,
    );
    this.name = "MigrationChecksumError";
    this.migrationName = migrationName;
  }
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
    const checksums = await fileChecksums(migrationFolder);
    const { error, results = [] } = await migrator.migrateToLatest();
    if (error) {
      throw error;
    }

    const applied = results
      .filter((result) => result.status === "Success")
      .map((result) => result.migrationName);
    const verified = await recordAndVerifyChecksums(db, checksums);
    return { applied, verified };
  } finally {
    await db.destroy();
  }
}

/** SHA-256 of each migration file, keyed by the same name Kysely records in its ledger. */
async function fileChecksums(migrationFolder: string): Promise<ReadonlyMap<string, string>> {
  const checksums = new Map<string, string>();
  for (const fileName of (await fs.readdir(migrationFolder)).sort()) {
    if (!fileName.endsWith(".ts") || fileName.endsWith(".d.ts")) continue;
    const contents = await fs.readFile(path.join(migrationFolder, fileName));
    checksums.set(fileName.slice(0, -3), createHash("sha256").update(contents).digest("hex"));
  }
  return checksums;
}

/**
 * Records a checksum for each applied migration and rejects any that changed.
 *
 * Only migrations present in Kysely's ledger are checked, so a not-yet-applied file can still be
 * edited freely.
 */
async function recordAndVerifyChecksums(
  db: ReturnType<typeof createDatabase>,
  checksums: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS questlab_migration_checksum (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `.execute(db);

  const appliedRows = await sql<{ name: string }>`
    SELECT name FROM questlab_migration
  `.execute(db);
  const recordedRows = await sql<{ name: string; checksum: string }>`
    SELECT name, checksum FROM questlab_migration_checksum
  `.execute(db);
  const recorded = new Map(recordedRows.rows.map((row) => [row.name, row.checksum]));

  const verified: string[] = [];
  for (const { name } of appliedRows.rows) {
    const actual = checksums.get(name);
    // A migration in the ledger with no file is a checkout/branch problem, not schema drift.
    if (actual === undefined) continue;
    const expected = recorded.get(name);
    if (expected === undefined) {
      // Backfill for databases migrated before checksums existed.
      await sql`
        INSERT INTO questlab_migration_checksum (name, checksum)
        VALUES (${name}, ${actual})
        ON CONFLICT (name) DO NOTHING
      `.execute(db);
      verified.push(name);
      continue;
    }
    if (expected !== actual) {
      throw new MigrationChecksumError(name, expected, actual);
    }
    verified.push(name);
  }
  return verified;
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
