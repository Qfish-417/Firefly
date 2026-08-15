# ADR 0036: Keep text embeddings behind an explicit HTTP provider boundary

## Context

The deployed runtime uses text-only generation models through pi-ai. pi-ai provides the generation and streaming model catalog used by FireFly, but it is not an embedding provider. Enabling vector retrieval by silently reusing the generation gateway would make model identity, dimensions, timeout and deletion/rebuild behavior implicit.

## Decision

Add `HttpEmbeddingProvider` as a separate `EmbeddingPort` adapter for OpenAI-compatible `/embeddings` endpoints. The adapter sends text only, validates response count and ordering, rejects non-finite or inconsistent vectors, enforces configured dimensions and request budgets, propagates cancellation/timeouts, and never logs credentials or source text.

Vector retrieval and index building remain optional at runtime. `memory:index-build` enables embeddings only when `EMBEDDING_ENDPOINT`, `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` are configured together. `retrieval:start` additionally requires the immutable `EMBEDDING_MODEL_SNAPSHOT`; this must match the index build task snapshot. Partial configuration fails closed at startup. Without embedding configuration, lexical retrieval remains available and vector/hybrid requests are not advertised.

## Consequences

- pi-ai remains the governed multi-provider text generation boundary; embedding credentials and provider lifecycle are independent.
- Vector/hybrid retrieval has an explicit model and dimension contract that can be audited and rebuilt deterministically.
- Text-only deployments can run without an embedding service, while later providers can implement the same port.
- Provider usage currently reports zero cost because cost accounting is provider-specific; deployments should add a metered adapter before relying on cost limits for paid embedding APIs.
