# ADR 0030: Normalize transcripts through a versioned JSON envelope

## Status

Accepted

## Context

`ConversationTurnChunker` required typed turns, but ASR engines and message stores expose incompatible transcript formats. Passing provider-specific payloads into the indexing core would couple retrieval evidence to a vendor and make turn identity, diarization and timestamps difficult to validate consistently.

## Decision

Add `TranscriptJsonParser` for a FireFly-owned `schema_version: 1` JSON envelope under dedicated transcript MIME types. Every turn carries a stable `turn_id`, non-negative integer `sequence`, `speaker_id`, content, an optional governed role and optional ISO timestamps. Roles are never inferred from speaker labels.

The parser rejects malformed JSON, unknown schema versions, empty transcripts, duplicate turn IDs or sequences, invalid roles, invalid or reversed timestamps and bounded-resource violations. `ParserBackedIndexSourcePort` remains responsible for strict blocking or explicitly diagnosed degradation.

ASR, diarization and message-store adapters must map their output into this envelope before indexing. They remain separate providers and must preserve the original Artifact Citation and Digest.

## Consequences

- `ConversationTurnChunker` receives one canonical, versioned turn model.
- ASR and message providers can change without changing Chunker contracts.
- Speaker identity and role remain distinct, avoiding unsupported user/assistant inference.
- This parser does not transcribe audio or perform speaker diarization; those capabilities remain external providers.
