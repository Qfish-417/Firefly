# ADR 0014: Run index builds and deletion propagation as durable targeted workers

- Status: accepted
- Date: 2026-08-10

## Context

ADR 0013 established immutable index versions and per-target deletion acknowledgements, but contracts and repository state alone did not execute either workflow. A process crash could leave a build or external deletion between provider side effects, database acknowledgement and Outbox publication. Generic Outbox consumers could also claim work intended for another deletion target. Object deletion tasks carried only a content digest, which cannot locate a concrete object.

## Decision

Add `@firefly/memory-workers` as an adapter-level package. `RetrievalIndexBuildWorker` claims only `RetrievalIndexBuildRequested` events under an Outbox lease, loads versioned source documents through `IndexSourcePort`, performs deterministic chunking, calls the independent Model Gateway `EmbeddingPort`, writes stable version-bound Chunk identities through `PostgresMemoryIndexer`, evaluates a Ready Gate, and optionally activates the ready version atomically.

Recovery is driven by persisted index state rather than in-memory progress. A `building` version may be rebuilt idempotently, a `ready` version only needs activation, `active` and `retired` versions are complete, and a `failed` version is not rebuilt. Retryable failures use bounded exponential backoff. Exhausted or non-retryable work marks both the build and Outbox event with an auditable terminal failure.

Extend `DeletionPropagationTask` with validated `resource_refs`. Deletion workers claim by both event type and `payload.target`, so independently deployed consumers cannot steal each other's tasks. The first consumer handles `object_store`: it accepts only concrete `s3://` references, deduplicates bucket/key pairs, and calls the official AWS S3 client, including against S3-compatible MinIO.

Only a provider deletion failure creates a failed `DeletionPropagationAck`. Failures while writing the acknowledgement, reading database state or marking the Outbox event published are queue/database failures and must not be mislabeled as provider failures. If a completed acknowledgement commits before publication fails, redelivery observes the completed target and only repairs publication. Failed targets use monotonic attempts and bounded backoff; exhausted events are discarded from dispatch while preserving `last_error`. `reconcileFailedDeletionTargets` locks stale failed targets, rechecks state and emits an idempotent fresh task before returning the target to pending.

## Consequences

- Index and deletion work can survive process restarts and at-least-once delivery without exposing partial index versions or corrupting deletion truth.
- Stable Chunk identities and provider idempotency make retries safe; external adapters must preserve that property.
- Outbox `published_at` now also denotes a discarded terminal event when `last_error` is present. Operational views must distinguish successful publication from discard.
- `resource_refs` reveal concrete storage locations and therefore inherit the Memory's tenant, sensitivity and audit requirements.
- The built-in Ready Gate proves structural integrity, not retrieval quality. ACL sampling, Recall/Citation regression and source-watermark checks remain release requirements.
- Reconciliation is implemented as a repository operation but still requires a production scheduler, metrics and alerting.
- Real MinIO deletion and PostgreSQL recovery are covered by integration tests; production BM25/ANN providers, other deletion targets, retired-index garbage collection and multimodal indexing remain future work.
