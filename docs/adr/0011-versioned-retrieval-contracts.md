# ADR 0011: Validate versioned retrieval contracts at the gateway boundary

- Status: accepted
- Date: 2026-08-10

## Context

The retrieval planner and gateway initially shared local TypeScript interfaces. Those interfaces disappear at process boundaries and do not prevent a Retriever, Aggregator or future remote service from returning structurally valid-looking but unsafe data. In particular, an insufficient package could accidentally authorize generation, a structured intent could be labeled as plain RAG, and a citation could omit its immutable digest.

## Decision

Define `QueryPlan`, `EvidenceCitation`, `StructuredResult`, `EvidenceItem` and `EvidencePack` in `@firefly/contracts` and publish their JSON Schema definitions under schema version 1.

`QueryPlan` carries `schema_version` and `query_id` in addition to the dynamic candidate, fusion, rerank and context limits. Structured intents must require the structured stage and use `structured_plus_evidence` as their answer source.

`EvidencePack` is the versioned retrieval response. It carries the original query, plan, deterministic result when required, bounded untrusted evidence, digest-bound citations, conflicts, coverage, allowed usage and execution trace. Its schema enforces these safety invariants:

- `status=insufficient` implies `generation_allowed=false`.
- `generation_allowed=true` requires sufficient evidence and no reported conflict.
- a structured plan requires a `structured_result`.
- participating IDs in a structured result are unique.
- every citation uses an immutable SHA-256 digest.

The Retrieval Gateway constructs the versioned plan and calls `assertContract("EvidencePack", pack)` immediately before returning. Any invalid Aggregator output or composition regression therefore fails closed at the producer boundary. Remote consumers must repeat schema validation on ingress; transport trust does not replace contract validation.

## Consequences

- Retrieval can move out of process without changing the Agent-facing data model.
- TypeScript and JSON Schema now describe the same public retrieval vocabulary.
- Schema changes require a new version or a backward-compatible v1 addition; silent field reinterpretation is prohibited.
- JSON Schema cannot express every relational invariant, such as equality of nested and outer `query_id`; the Gateway owns those construction invariants and future consumers should add semantic validation where they accept independently produced plans.
