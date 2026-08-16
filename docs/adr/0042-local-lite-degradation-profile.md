# ADR 0042: Define an explicit low-resource local profile

## Context

The full development Compose stack starts PostgreSQL, MinIO, Retrieval API, index and deletion Workers, and may be combined with embedding, reranking and Sandbox runtimes. That surface is useful for integration verification but is unnecessarily heavy as the default completion target for a personal development computer. Treating unavailable infrastructure as successful would be unsafe, while requiring production BM25, ANN and multimodal services would make the project impractical to run locally.

## Decision

Add `infra/compose/questlab-lite.yml` as an explicit local profile. Its steady state contains only a resource-bounded PostgreSQL instance and Retrieval API; the migration container exits after schema setup. PostgreSQL uses a named volume so local memory and structured facts survive ordinary `down` and restart operations.

The default profile advertises lexical PostgreSQL FTS only. Embedding/vector retrieval and HTTP reranking remain opt-in through their existing complete environment-variable sets. MinIO, index/deletion Workers, OCR/ASR and Docker Sandbox are omitted. Stub Agents or text-only models remain valid because they use the same governed Task, Event, Artifact, approval and Loop Sentinel contracts.

Degradation is allowed only for quality or infrastructure capabilities. ACL checks, deterministic structured aggregation, graph bounds, conflict visibility, Citation Digests, budgets, approval and loop prevention remain fail closed. An omitted service must be reported as unavailable, skipped or explicitly degraded and may never emit success evidence.

## Consequences

- A normal laptop can run the durable fact layer and governed retrieval boundary with a small steady-state service set.
- PostgreSQL FTS, exact pgvector when enabled, and deterministic RRF are accepted local baselines; production BM25 and partitioned HNSW are optional enhancements.
- The lite profile does not claim external deletion completion, index-worker operation, multimodal extraction or Sandbox verification.
- Full integration checks remain available through the existing development stack and environment-gated tests.
