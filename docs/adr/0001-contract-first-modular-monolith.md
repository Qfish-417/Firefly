# ADR 0001: Contract-first modular monolith

- Status: accepted
- Date: 2026-08-05

## Context

QuestLab has three top-level Agent boundaries, but the first vertical slice needs shared transactions, deterministic state transitions and fast contract iteration. Deploying three services before those contracts stabilize would add transport and consistency failure modes without proving the learning loop.

## Decision

Start with a TypeScript workspace and keep the three Agent bundles logically independent inside a modular monolith. Put sandboxed code execution and replay workers in separate processes from the beginning.

All cross-boundary messages use versioned JSON Schema. PostgreSQL will become the source of truth for business and workflow state. Transport adapters may later move a worker from in-process dispatch to a durable queue without changing domain contracts.

The first implementation milestone contains:

- v1 schemas for Task, Event, Artifact and the evidence-to-outcome artifacts;
- deterministic Journey, Mission, PluginRelease and EvolutionRun state machines;
- optimistic version checks and idempotent event replay;
- contract and transition tests that run without infrastructure.

## Consequences

- We optimize for a working vertical slice rather than early service topology.
- Agent code cannot mutate state directly; it submits contract-validated results.
- Breaking schema changes require a new major contract version.
- PostgreSQL, Outbox/Inbox and Agent workers can be added after the pure domain layer is stable.
- The legacy Java/Python prototype remains in place but is not imported into the new packages.
