# ADR 0012: Start hybrid retrieval with PostgreSQL and propagate deletion from the fact layer

- Status: accepted
- Date: 2026-08-10

## Context

The governed Retrieval Gateway previously had only provider ports and test doubles. A usable vertical slice needs persistent chunks, lexical and vector retrieval, a second authorization check, and deletion behavior that keeps structured counts consistent with source-memory erasure. Introducing Elasticsearch, a dedicated vector database, object storage and a queue consumer at once would expand the operational surface before the contracts are proven.

## Decision

Add `questlab.memory_chunk` as a rebuildable PostgreSQL projection. It stores derived text, a generated `tsvector`, optional pgvector data, embedding model and dimension snapshots, entity keys, token count and digest-bound citation metadata. Chunk identity is immutable: reusing a Chunk ID with a different source, digest, locator or embedding snapshot fails closed.

Add `@firefly/retrieval-postgres` as a concrete adapter package:

- `PostgresLexicalRetriever` uses PostgreSQL `websearch_to_tsquery` and `ts_rank_cd` as the first lexical baseline.
- `PostgresVectorRetriever` receives query vectors through the explicit Model Gateway `EmbeddingPort`, routes by embedding model and dimension, and performs cosine search through pgvector.
- both retrievers apply tenant, owner and explicit read-ACL predicates before recall.
- `PostgresMemoryAuthorization` repeats authorization against the current database row and verifies Chunk ID plus citation artifact, URI and digest before the Gateway accepts a hit.

PostgreSQL full-text ranking is not described as BM25. Production BM25 remains a separate Elasticsearch, OpenSearch or ParadeDB Retriever behind the same port. The first pgvector implementation uses exact search because a single variable-dimension table cannot safely share one ANN index; production indexing will partition by embedding model and dimension before adding HNSW.

`MemoryRepository.deleteMemory` is an authorized, idempotent transaction. It marks the source memory deleted, removes local chunks, deletes structured events that depend on that source, writes a deletion receipt and emits one `MemoryDeleted` Outbox event. The tombstone and receipt remain auditable. External object storage, caches and future search providers consume the Outbox event; a local receipt alone does not claim global erasure completion.

## Consequences

- The RAG path now runs against real PostgreSQL FTS and pgvector without changing Gateway contracts.
- Index-side ACL filtering reduces exposure and the independent final authorization check protects against stale or tampered hits.
- Deleting a source immediately removes it from local recall and deterministic aggregates.
- Derived Chunk text now exists in PostgreSQL and must inherit backup, encryption and retention controls from its source memory.
- Multilingual analyzers, production BM25, ANN partitions, external deletion acknowledgements and index rebuild orchestration remain later milestones.
