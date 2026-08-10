# ADR 0010: Compose retrieval through a governed EvidencePack gateway

- Status: accepted
- Date: 2026-08-10

## Context

Dynamic TopK planning and memory ACL storage do not by themselves create a safe RAG path. Retriever scores are not comparable across providers, duplicated evidence may disagree, index ACL filters may be stale, and an Agent must not generate from an incomplete aggregation result.

## Decision

Introduce `@firefly/retrieval-service` as a provider-neutral orchestration boundary. Search Retrievers own one stage each and execute in parallel with an explicit candidate limit. The gateway sorts every result list independently, applies reciprocal rank fusion, validates immutable Evidence IDs, and then performs a mandatory authorization check independent of index-side filtering.

The dynamic retrieval plan controls fusion, rerank-window and context limits. Selected content is labeled `untrusted_content` and carries a digest-bound citation. Evidence below the minimum coverage produces an `insufficient` package with `generation_allowed=false`.

Aggregation, comparison, temporal and multi-hop intents require a configured structured Aggregator. Missing structure fails closed. The returned scalar is always accompanied by included IDs, exclusion reasons and conflicts; RAG evidence is citation support and cannot replace the deterministic result.

## Consequences

- Elasticsearch, pgvector, Milvus and other providers can be added without changing Agent contracts.
- A stale or permissive index filter cannot bypass the final authorization port.
- One failed Retriever degrades traceably; conflicting immutable evidence identities terminate retrieval.
- Versioned cross-process `QueryPlan` and `EvidencePack` contracts are defined by [ADR 0011](./0011-versioned-retrieval-contracts.md).
