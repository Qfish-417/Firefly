# ADR 0022: Preserve turn semantics in conversation chunks

- Status: accepted
- Date: 2026-08-11

## Context

Conversation evidence is not an ordinary paragraph stream. Removing speaker identity, turn order or timestamps makes a retrieved statement difficult to attribute and can merge conflicting claims from different participants. Conversation history also grows continuously, so retrieval-sized Children and context-sized Parents need separate boundaries.

## Decision

Add a typed `conversation` source with stable turn IDs, sequence numbers, speaker IDs, optional roles and optional ISO timestamps. `ConversationTurnChunker` sorts by sequence, validates unique identity, groups contiguous turns into Parent windows, and emits Child chunks at turn boundaries. A turn longer than the Child budget may be split, but every part retains the original turn locator. Parent chunks have no embeddings; only Children enter recall.

The chunker uses the same `strict` default and explicit `fallback_mode: "degraded"` as the PDF, code and table chunkers. Degraded output is plain text with an auditable parser marker and never claims speaker or time structure that was not parsed.

## Consequences

- Conversation retrieval can cite a specific turn, speaker and time range.
- Parent expansion provides nearby dialogue context without embedding entire sessions.
- Real transcript, diarization and message-store adapters remain outside the memory worker and can be added through `IndexSourcePort`.
