# ADR 0019: Purge retired index projections behind retention and audit holds

- Status: accepted
- Date: 2026-08-11

## Context

Atomic index activation intentionally retains the previous version so rollback and audit remain possible. Keeping every retired version's derived chunks forever, however, creates unbounded database growth. A garbage collector must never remove an active projection, a recently retired rollback candidate, or a version still needed by an evaluation, incident, legal, or audit workflow. Deleting the version row itself would also erase its immutable build identity and quality report.

## Decision

Migration 011 adds `purged_at` to `retrieval_index_version` and introduces `retrieval_index_retention_hold`. A hold names the exact index version and external reference, carries a reason, and may be explicitly released or expire. Hold registration locks the version row and rejects versions whose projections were already purged, which closes the race between a new audit reference and collection.

`RetrievalIndexRepository.purgeRetiredIndexes` selects only retired, unpurged versions at or before a caller-supplied cutoff and without an effective hold. Selection is bounded, ordered, and uses `FOR UPDATE SKIP LOCKED`, allowing multiple collectors to divide work. In the same transaction it rechecks holds, deletes version-bound `memory_chunk` rows, records `purged_at`, and emits one deterministic `RetrievalIndexPurged` Outbox event. The version row, original chunk count, immutable build identity, source watermark, configuration Digest, and quality report remain available for audit.

`RetiredIndexGarbageCollector` computes the cutoff from a validated retention period, coalesces overlapping ticks in one process, emits structured cycle results, continues after failed cycles, and stops opening new cycles after AbortSignal cancellation. `npm run memory:index-gc` is the independent deployment entry point.

## Consequences

- Active and newly retired index projections are not eligible for collection.
- Explicit audit holds block collection without requiring the collector to infer references from arbitrary JSON payloads.
- Multi-replica collection is safe and bounded by database locks and a deterministic purge event identity.
- Projection capacity is reclaimed while version and quality evidence remain queryable.
- Hold producers, retention values, metrics, alerts, external provider index deletion, and restoration by rebuilding remain deployment responsibilities.
