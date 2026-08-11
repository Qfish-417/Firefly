import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.retrieval_index_version
      ADD COLUMN quality_report JSONB
        CHECK (quality_report IS NULL OR jsonb_typeof(quality_report) = 'object');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE questlab.retrieval_index_version
      DROP COLUMN IF EXISTS quality_report;
  `.execute(db);
}
