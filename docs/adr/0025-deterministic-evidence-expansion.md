# ADR 0025: Govern deterministic evidence context expansion

## Status

Accepted

## Context

Dynamic TopK chooses a bounded set of evidence, but a small retrieved Child can omit the layout region, adjacent turn, related entity or temporal event needed to interpret it. Letting each Retriever or Agent perform unrestricted follow-up searches makes authorization, ordering and token cost inconsistent. Parent expansion alone also cannot represent entity and temporal relationships.

## Decision

Add an optional `EvidenceExpansionPort` to `@firefly/retrieval-service` and provide `DeterministicEvidenceExpander` as the provider-neutral baseline. The expander accepts only selected anchor hits and explicit candidates with one of four relations: `region`, `neighbor`, `entity`, or `temporal`.

Candidates are ordered by a versioned relation priority, then descending score, then ascending Evidence ID. Each anchor has a bounded candidate count. Evidence IDs are immutable: conflicting content, citation URI or citation digest is a policy error. The expander never exceeds the `max_context_tokens` budget; candidates that do not fit are skipped while already selected evidence is retained.

The Gateway keeps the security boundary. It performs initial ACL before selection, invokes expansion, then performs final ACL/active-index checks and validates the resulting EvidencePack. Expansion supports `AbortSignal`; cancellation fails the request rather than returning a partial generation-eligible pack.

## Consequences

- Region, neighbor, entity and temporal providers can be added without changing Agent contracts.
- Context growth is deterministic and auditable, but low-scoring candidates may be omitted when the budget is full.
- Every new relation or provider requires fixed Recall, Citation, ACL and budget evaluation cases.
- Expansion is not a substitute for structured aggregation. Counts, deduplication and temporal truth still belong to the deterministic Aggregator.

## Rejected alternatives

- A fixed global expansion K: it ignores evidence size and can overflow the model budget.
- Agent-side follow-up retrieval: it weakens the final ACL and provenance boundary.
- Model-selected expansion order: it is difficult to replay and can turn untrusted content into control flow.
