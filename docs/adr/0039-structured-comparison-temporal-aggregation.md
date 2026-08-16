# ADR 0039: Aggregate comparison and temporal questions in the structured fact layer

## Context

The Retrieval Gateway already required deterministic aggregation for count, comparison, temporal and multi-hop intents, but the PostgreSQL adapter implemented only `count_events`. Answering questions such as "which learner completed more lessons?" or "when was this learner's first attempt?" through TopK RAG would make the result depend on chunk recall, duplicate mentions and inaccessible evidence. It would also give the model responsibility for arithmetic, conflict handling and access control.

## Decision

Comparison and temporal requests use a discriminated `structured_query` instead of free-form filters. The HTTP boundary accepts only the fields belonging to the selected intent, validates identifiers and ISO time ranges, rejects a comparison against the same subject and permits only `first` or `last` temporal selectors. Internal adapter calls repeat the time-range check so callers cannot bypass the HTTP boundary.

`PostgresStructuredEventAggregator` reads ordered `StructuredEvent` rows through `MemoryRepository.listReadableEvents`, which applies public, tenant, user, Agent and session visibility before aggregation. Rows are ordered by `occurred_from` and `event_id`, and the first visible representative of each `dedupe_key` is retained deterministically.

A comparison counts the distinct non-conflicting events for two subjects under one event type and optional time window. Its scalar `value` is `left_value - right_value`; typed `comparison_counts` details preserve both operands and subject identities. A temporal query selects the first or last distinct non-conflicting event and returns its start time plus typed `temporal_event` details. An empty temporal result is represented explicitly with a null scalar and null event fields.

Conflict IDs are always returned. By default conflicting rows are excluded and the exclusion count is explained. `include_conflicts=true` permits them to participate in the deterministic calculation but does not hide their conflict identity, so the Gateway's existing contract still prevents conflicted structure from authorizing generation.

`multi_hop` remains fail closed. It will not be implemented until `StructuredEvent.object` is replaced or supplemented by a versioned graph-edge contract with explicit source, predicate, target, direction, validity interval, provenance and ACL semantics.

## Consequences

- Counts, comparisons and event-time answers no longer depend on TopK completeness or model arithmetic.
- Cross-tenant and private-memory boundaries are enforced before deduplication or selection.
- Comparison and temporal `StructuredResult` values are machine-readable and JSON Schema rejects missing or mismatched detail variants.
- Stable ordering and dedupe rules make retries reproducible, including first/last selection.
- Unresolved conflicts remain visible and cannot silently authorize a generated answer.
- Graph traversal was intentionally unavailable at M5.25 until its truth and authorization model became explicit; [ADR 0040](./0040-versioned-structured-edge-multi-hop.md) completes that follow-up with a separate `StructuredEdge` fact layer.
