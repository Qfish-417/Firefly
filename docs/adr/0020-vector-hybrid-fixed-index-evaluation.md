# ADR 0020: Bind vector and hybrid fixed evaluation to query embedding snapshots

- Status: accepted
- Date: 2026-08-11

## Context

Lexical fixed evaluation is insufficient for a vector or fused index. A query embedding generated later by a different model or dimension would change the measured result without changing the evaluation dataset identity. Candidate evaluation must also remain isolated from the normal active-only retrieval path.

## Decision

Extend `IndexEvaluationCase.stage` to `lexical`, `vector` or `hybrid`. Vector and hybrid cases must carry a finite non-zero `query_embedding` and its `embedding_model`; these fields are part of the canonical dataset payload and therefore change the Artifact Digest. The evaluator requires the case snapshot to match the building task's embedding model and dimension. Vector cases require a vector-capable build; hybrid cases require a hybrid build.

`PostgresBuildingIndexQualityEvaluator` keeps the existing identity, tenant and ACL checks, then selects the stage-specific path: PostgreSQL FTS for lexical, cosine distance for vector, and a deterministic 50/50 normalized lexical/vector score for hybrid. Every path reads only Child chunks from the task-bound building version and returns the same citable hit contract consumed by ACL, Recall and Citation probes. Activation still closes the evaluation-only path.

## Consequences

- Vector and hybrid quality reports are reproducible against a pinned embedding snapshot.
- A model or dimension change requires a new evaluation dataset Artifact and a new quality report.
- Hybrid scoring is deterministic and auditable, but its weights remain a policy baseline that can be tuned only through a new versioned evaluation contract.
- ANN providers, rerank quality, multilingual embedding calibration and production-scale latency evaluation remain follow-up work.
