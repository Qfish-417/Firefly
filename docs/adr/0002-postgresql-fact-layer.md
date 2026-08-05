# ADR 0002: PostgreSQL fact layer and durable leases

- Status: accepted
- Date: 2026-08-05

## Context

Agent context, queues, caches and vector indexes cannot be the source of truth for a long-running learning evolution loop. The system must survive duplicate delivery, worker termination and delayed human approval without allowing Agents to mutate workflow state directly.

## Decision

Use PostgreSQL as the first authoritative store. Keep the M1 schema limited to the cross-cutting workflow backbone:

- EvolutionRun and immutable transition history;
- durable WorkflowTask leases and checkpoints;
- Approval records;
- transactional Outbox and idempotent Inbox receipts;
- immutable Artifact metadata, ACL and lineage.

Use Kysely for typed queries, transactions and migrations. A transition is accepted only after the M0 domain state machine validates it. The state row, transition record and Outbox event are committed in one transaction.

Task workers claim work with `FOR UPDATE SKIP LOCKED`, an owner identity and an expiry time. An expired lease may be reclaimed; completion and checkpoint writes require the current unexpired lease.

## Consequences

- RabbitMQ, RocketMQ or another broker may be added later without becoming the fact source.
- Delivery remains at-least-once; Inbox and side-effect idempotency provide business consistency.
- Artifact content remains outside PostgreSQL, while URI, digest, visibility and lineage remain transactional metadata.
- Learning, plugin and evaluation tables will be added only when their vertical slice is implemented.
- Integration tests run against real PostgreSQL, not an in-memory approximation.
