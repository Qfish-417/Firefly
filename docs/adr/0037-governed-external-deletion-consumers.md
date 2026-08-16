# ADR 0037: Govern external deletion consumers through fixed endpoints and durable acknowledgements

## Context

Deleting a Memory from PostgreSQL removes the local chunks and structured events, but external lexical/vector indexes, multimodal projections, caches, summaries and evaluation stores may retain derived content. Recording a local deletion receipt without executing these provider deletions would overstate erasure completion.

## Decision

Add `HttpDeletionTargetConsumer` for every non-object-store deletion target. It calls one fixed HTTPS endpoint, rejects redirects and unsafe transport headers, bounds time and response bytes, and binds the response to the requested deletion ID, target and content digest. A successful provider response must contain at least one tenant-owned immutable `ArtifactRef` with the deletion-receipt media type. Identity drift, malformed evidence and evidence-free success are permanent failures; timeouts, HTTP 408/429 and server failures remain retryable.

Add `memory:delete` as the shared durable process entry point. One process owns one target selected by `MEMORY_DELETION_TARGET`; targeted Outbox leasing prevents it from claiming another provider's work. The existing `DeletionPropagationWorker` persists failed/completed acknowledgements, applies bounded retry/backoff and cooperates with deletion reconciliation. Object storage continues to use the S3 adapter, while all other allowlisted targets use the governed HTTP adapter.

## Consequences

- A global deletion is completed only after every requested target supplies its own durable acknowledgement.
- Provider credentials stay in process environment and never enter Task, Event or acknowledgement payloads.
- External providers must expose an idempotent deletion endpoint and persist an immutable receipt artifact.
- Each target is deployed independently, so a cache or search outage cannot consume or block another target's queue lease.
