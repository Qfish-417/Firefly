# ADR 0040: Traverse a versioned structured-edge fact layer for multi-hop queries

## Context

The Retrieval Planner classified `multi_hop` as a structured intent, but no trustworthy graph fact existed. Treating arbitrary `StructuredEvent.object` fields or retrieved chunks as graph edges would leave direction, validity, provenance, access control and deletion behavior undefined. It would also allow a model to invent intermediate nodes or recurse without a deterministic hop bound.

## Decision

Migration 013 introduces `questlab.structured_edge` and a v1 `StructuredEdge` contract. Every edge has an immutable identity, tenant, source node, predicate, target node, `directed` or `bidirectional` semantics, memory scope and owner, half-open validity interval, dedupe key, source Memory provenance, confidence and conflict status. Self edges, reversed validity, missing sources, broader visibility than a source Memory and identity-changing replay fail closed.

`MemoryRepository.listReadableEdges` applies public, tenant, user, Agent and session visibility before returning edges. It filters by an explicit `as_of` timestamp and an optional predicate allowlist, uses a governed row limit and returns a stable order. Deleting any source Memory removes dependent edges in the same transaction and records `invalidated_edge_count` in the deletion receipt and Outbox payload.

The Retrieval HTTP boundary accepts a discriminated `find_relation_path` query only for `multi_hop`. Start and target must differ; direction is `outbound`, `inbound` or `both`; predicates are bounded and unique; `max_hops` is between one and six; and `as_of` is required so retries do not depend on wall-clock time.

`PostgresStructuredEventAggregator` performs a deterministic breadth-first search over the authorized snapshot. Edges are sorted and deduplicated, visited nodes prevent cycles, the hop bound prevents unbounded traversal and a configurable graph-edge limit prevents memory amplification. Directed and bidirectional traversal are explicit. Conflicting reachable edges are always surfaced; excluded conflicts are counted, while included conflicts still cause the Gateway to block generation through the existing structured-conflict invariant.

The result uses `operation: path` and typed `relation_path` details containing the exact node sequence and traversed edge identities. A missing path is explicit: null scalar, null hop count and empty node/edge arrays. RAG evidence may explain the path but cannot replace the structured computation.

## Consequences

- Multi-hop answers now derive from ACL-filtered, time-bound facts instead of model-inferred links.
- Cycles cannot create infinite work, and path cost is bounded by both hop count and graph size.
- Edge provenance participates in memory deletion and cannot outlive a deleted source fact.
- Deterministic ordering makes equal-length path selection reproducible.
- Large production graphs may later need a dedicated graph provider, but it must preserve this contract, ACL, conflict and limit behavior.
