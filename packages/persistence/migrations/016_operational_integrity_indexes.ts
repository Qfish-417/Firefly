import { sql, type Kysely } from "kysely";

/**
 * Database-level guarantees for invariants that were only enforced in application code.
 *
 * 1. One active version per plugin. `activateVersion` deactivates then activates in a transaction,
 *    but two concurrent promotions could interleave and leave two rows `active` (or none). A partial
 *    unique index makes the second writer fail instead of corrupting the routing state.
 * 2. Outbox dispatch by `event_type`. Consumers filter on `event_type`, which had no index, so every
 *    type-scoped read was a sequential scan over the whole outbox.
 * 3. Task reaping. The reaper looks for expired leases and passed deadlines; without an index it
 *    scans every task row on each pass.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS plugin_version_single_active_idx
      ON questlab.plugin_version (plugin_id)
      WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS outbox_event_type_idx
      ON questlab.outbox_event (event_type, available_at)
      WHERE published_at IS NULL;

    CREATE INDEX IF NOT EXISTS workflow_task_reap_idx
      ON questlab.workflow_task (deadline, lease_expires_at)
      WHERE status IN ('pending', 'leased');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS questlab.plugin_version_single_active_idx;
    DROP INDEX IF EXISTS questlab.outbox_event_type_idx;
    DROP INDEX IF EXISTS questlab.workflow_task_reap_idx;
  `.execute(db);
}
