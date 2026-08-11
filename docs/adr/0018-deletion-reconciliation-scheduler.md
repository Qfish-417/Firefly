# ADR 0018: Run deletion reconciliation as an observable stoppable scheduler

- Status: accepted
- Date: 2026-08-11

## Context

The deletion repository can safely requeue stale failed targets using a row lock, a status recheck and deterministic Outbox identities, but invoking that method manually does not provide an operational recovery loop. A deployment needs bounded periodic execution, clean shutdown, useful cycle telemetry and protection against overlapping ticks. Multiple scheduler replicas must not turn a repeated scan into duplicate deletion side effects.

## Decision

Introduce `DeletionReconciliationScheduler`. A cycle computes a stale cutoff from a validated age, invokes `reconcileFailedDeletionTargets` with a bounded batch limit, and emits a structured result containing scheduler, instance and cycle identities, timestamps, cutoff, limit, requeued count and a bounded failure summary.

Concurrent `runOnce` calls on one instance share the same in-flight Promise. The long-running `run` method executes immediately, waits a validated interval, continues after failed reconciliation cycles and stops opening new cycles when its `AbortSignal` is canceled. It does not cancel a database transaction already in progress. Observer failures are counted in the scheduler snapshot but cannot rewrite a reconciliation result or terminate the recovery loop.

Cross-instance safety remains database-owned. Candidate scans may overlap, but `requeueDeletionTarget` locks each target, requires it still to be failed, updates it to pending and enqueues a deterministic retry identity in one transaction. Other replicas then observe the changed state and do no work.

Add `reconciliation-main.ts` and `npm run memory:reconcile` as a real process entry point. `DATABASE_URL` is mandatory; scheduler identity, instance identity, interval, stale age and batch size are environment-configurable and validated. SIGINT and SIGTERM abort the loop and close the database connection after the current cycle.

## Consequences

- Failed deletion targets can recover without a manual API call.
- One process cannot overlap its own ticks, while multiple replicas remain safe through existing database invariants.
- Reconciliation failures are visible and do not permanently stop future attempts.
- Deployment logging and metrics can consume one stable JSON event per cycle.
- A durable scheduler-run ledger, alert rules, Provider evidence verification and non-object-store deletion consumers remain follow-up work.
