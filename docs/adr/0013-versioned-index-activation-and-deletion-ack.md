# ADR 0013: Version retrieval indexes and require per-target deletion acknowledgements

- Status: accepted
- Date: 2026-08-10

## Context

The PostgreSQL retrieval slice could rebuild Chunk projections, but it had no persisted build identity or atomic activation boundary. Rebuilding in place would expose a partially populated index, while changing an embedding model could mix incompatible vectors. Deletion also emitted a local Outbox event without tracking whether object storage, external search, caches, summaries or evaluation derivatives had actually removed the data.

## Decision

Introduce versioned `IndexBuildTask` and `IndexBuildResult` v1 contracts. `RetrievalIndexRepository` persists each immutable build snapshot in `questlab.retrieval_index_version`, including tenant, logical index name, provider, configuration Digest, source watermark and optional embedding model/dimensions. A build moves from `building` to `ready` or `failed`; only a `ready` version may be activated.

Activation takes a transaction-scoped advisory lock for the tenant and logical index, retires the prior active version and activates the new version in one transaction. A partial unique index enforces one active version per tenant and logical name. Every new Chunk is bound to `index_version_id`; the indexer rejects cross-tenant writes, non-building/non-active versions and embedding snapshots that differ from the version. Retrievers and the final authorization adapter join the version table and read only the configured active logical index. Legacy unversioned Chunks therefore fail closed until rebuilt.

Introduce `DeletionPropagationTask` and `DeletionPropagationAck` v1 contracts with an allowlisted target vocabulary. `deleteMemory` completes the local tombstone, local Chunk removal and dependent-event invalidation transaction first, then records one pending row and one Outbox task per requested external target. The local receipt exposes `propagation_status`; it is not a claim of global erasure.

`acknowledgeDeletion` accepts monotonic per-target attempts. A failed target may later complete with a higher attempt. Ack IDs are immutable and idempotent; stale attempts, unrequested targets and conflicting replay content fail closed. The receipt is `failed` if any target failed, `pending` while any target remains pending, and `completed` only when every target completed. Final completion emits `MemoryDeletionPropagationCompleted`.

## Consequences

- Rebuilds are invisible to queries until an explicit atomic activation.
- Rollback remains possible by building and activating another immutable version; retired data is still a projection and may be garbage-collected by a separate retention policy.
- Index configuration and embedding shape are auditable and cannot silently drift per Chunk.
- External erasure progress is observable per target and retry, rather than inferred from local deletion.
- Consumers still need to be implemented for each external provider. Acknowledgement proves the target reported completion; provider-specific evidence and periodic reconciliation remain required.
- PostgreSQL FTS remains a baseline rather than BM25, and current pgvector retrieval remains exact rather than ANN.
