# ADR 0035: Text-first runtime boundary

## Context

FireFly keeps versioned multimodal ingestion contracts, but the currently deployed model runtime is text-only. Passing image, audio, PDF or arbitrary binary payloads directly to the Agent or embedding route would make provenance, cost and safety behavior implicit.

## Decision

The production index-build entry point is text-first. `PostgresMemoryIndexSourcePort` reads only active tenant-scoped Memories, resolves immutable `source_refs`, verifies the Artifact SHA-256 digest and UTF-8 decoding, then emits `IndexSourceDocument` text. Non-text Artifacts fail closed with `TEXT_SOURCE_REQUIRES_PARSER`. Multimodal parsers remain supported as governed adapters; they must produce structured text with Citation locators before indexing.

The default `memory:index-build` process uses the deterministic Markdown Parent/Child chunker and does not auto-activate an index. Activation still requires the full Ready Gate quality report. Private scopes require a separate principal-aware indexing worker and are not included by the default tenant worker.

## Consequences

- Text models and embeddings have a single stable input contract.
- OCR/ASR/PDF failures are visible parser failures instead of silent empty text.
- Multimodal support can be added without changing Agent or RAG contracts.
- A future multimodal model route can be introduced behind a new explicit capability without weakening the text-only deployment boundary.
