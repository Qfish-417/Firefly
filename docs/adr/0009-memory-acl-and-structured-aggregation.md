# ADR 0009: Keep memory ACLs and structured aggregation in the fact layer

- Status: accepted
- Date: 2026-08-06

## Context

Vector and lexical indexes are retrieval accelerators, not reliable sources for ownership, deletion or exact counts. Allowing an Agent to infer a count from TopK chunks can duplicate events, omit records or cross a tenant boundary. Derived structured events must not become more visible than their source memories.

## Decision

Persist `memory_record`, `memory_acl` and `structured_event` in PostgreSQL. `MemoryRepository.listReadable` applies tenant, scope, owner and explicit ACL filters before returning active records. Public records are platform-visible; tenant-private records remain tenant-bound; user, Agent and session scopes require matching ownership or ACL grants.

`recordEvent` requires at least one source memory, rejects deleted or cross-tenant sources, and rejects any event scope broader than its sources. `aggregateReadableEvents` executes an allowlisted `COUNT DISTINCT dedupe_key` projection and returns the included event IDs, not just a scalar. RAG may provide citations for the result but cannot replace this calculation.

Event visibility fields are copied from source visibility at write time. A future version may add explicit event ACLs or a lineage-aware SQL policy; until then the conservative behavior is to under-return rather than broaden access.

## Consequences

- Exact counts and provenance remain restart-safe and independent of vector index freshness.
- ACL checks are testable against real PostgreSQL and reusable by retrieval services.
- PostgreSQL full-text, pgvector and local deletion propagation consume these fact-layer boundaries as defined by [ADR 0012](./0012-postgresql-hybrid-retrieval-and-deletion.md).
