# ADR 0024: Separate degraded index build from degraded activation

- Status: accepted
- Date: 2026-08-11

## Context

Parser-backed sources can remain temporarily unavailable. A plain-text fallback can keep an ingestion pipeline moving, but it does not prove that page, symbol, table or conversation semantics were recovered. Treating such chunks as ordinary quality evidence would allow an outage to silently replace a production index.

## Decision

`RetrievalIndexBuildWorker` detects `parser_mode=degraded` in Chunk Citation Locators. Degraded builds are rejected unless `allow_degraded_build=true`. Automatic activation additionally requires `allow_degraded_activation=true`; the two permissions are independent. The default is strict for both. The rejection is non-retryable and records `DEGRADED_INDEX_BUILD_NOT_ALLOWED` or `DEGRADED_INDEX_ACTIVATION_NOT_ALLOWED`.

## Consequences

- Parser outages cannot silently change the active retrieval index.
- Operators can explicitly choose continuity for a bounded build while keeping activation blocked.
- A future quality policy can evaluate degraded evidence separately without changing the source or Chunker contracts.
