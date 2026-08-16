# ADR 0041: Rerank only authorized evidence through a governed provider boundary

## Context

The Retrieval Planner already computed a dynamic `rerank_k`, but the Gateway only truncated the fused RRF list and passed its scores to evidence selection. A text-generation model is not a reranker, and routing this stage through pi-ai would blur capability, cost and trust boundaries. Sending candidates before authorization would also disclose inaccessible memory to an external provider.

## Decision

`HttpRerankerProvider` implements the existing `RerankPort` independently from pi-ai. It accepts a fixed HTTPS endpoint and model; plain HTTP is available only for an explicitly enabled localhost development endpoint. URL credentials and redirects are forbidden. Timeout, response bytes and document count are bounded, and API credentials remain deployment configuration.

The provider sends `model`, the text query, an ordered document array and `top_k`. It requires exactly `top_k` unique, in-range indexes with finite normalized scores in `[0,1]`. Both `results[].score` and the common `results[].relevance_score` response field are accepted. Token, cost and duration usage are checked against an explicit `ModelBudget`.

The Retrieval Gateway runs ACL authorization before creating the rerank window. The number of documents and `top_k` can never exceed the planner's dynamic `rerank_k`. Provider indexes are resolved only against that immutable local window, so a provider cannot introduce an evidence ID or content. The Gateway repeats count, uniqueness, index, score and usage checks before evidence selection and retains the final ACL check after Parent/Child expansion.

Retryable transport, timeout and HTTP 5xx failures may use the configured `fallback` policy, which preserves deterministic RRF ordering. `strict` mode fails closed on any reranker failure. Non-retryable protocol, identity, score and budget failures always fail closed; they never silently become a valid ranking.

## Consequences

- pi-ai remains responsible only for multi-model generation and streaming; embedding and reranking are explicit provider ports.
- Unauthorized evidence is never disclosed to the reranking provider.
- Dynamic TopK remains planner-owned rather than a fixed provider constant.
- Provider outages can degrade without making malformed provider output trustworthy.
- A concrete production reranker, credentials, network egress policy and SLO remain deployment responsibilities.
