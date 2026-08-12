# ADR 0026: Persist maintenance cycle outcomes

## Status

Accepted

## Context

Deletion reconciliation and retired-index garbage collection previously exposed only an in-memory snapshot and JSON stdout. Restarting a worker lost the durable audit trail, and a second observer could not distinguish an unseen cycle from a failed publication.

## Decision

Migration 012 adds `questlab.maintenance_cycle`. Each reconciliation or GC cycle writes one immutable row keyed by its deterministic `cycle_id`, with worker/instance identity, status, timestamps, a bounded JSON payload and optional structured error. `MaintenanceCycleRepository.record` is idempotent: replaying the same identity and content returns the existing row; reusing an identity with different content fails closed.

Both Worker constructors accept an optional ledger port. The production process entry points provide `MaintenanceCycleRepository`. A ledger outage increments `ledger_failures` and is observable, but does not change the already completed or failed maintenance result. This prevents an audit sink outage from blocking deletion repair or index cleanup.

## Consequences

- Operators can query maintenance history after process restarts.
- Cycle payloads remain bounded and provider-neutral; high-cardinality logs do not enter the ledger.
- Ledger storage is a second reliability boundary and needs its own retention and alerting policy.
- The ledger records maintenance facts; it is not a job queue or a replacement for Outbox delivery state.
