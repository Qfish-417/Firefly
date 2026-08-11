# ADR 0017: Evaluate building indexes with digest-bound fixed lexical sets

- Status: accepted
- Date: 2026-08-11

## Context

ADR 0015 made ACL, Recall and Citation mandatory quality checks, but deterministic pass-through probes only proved orchestration. Normal retrievers cannot evaluate a candidate because they intentionally read only the active index. Relaxing that rule would expose an unactivated version, while evaluating the old active version would say nothing about the candidate being approved.

Quality results also need a stable meaning. Queries, principals, expected evidence, forbidden evidence, citation expectations and thresholds must not change without changing the evidence identity referenced by the report.

## Decision

Introduce the versioned `IndexEvaluationSet` contract. Each lexical case declares its query, purpose, principal, TopK, expected Memory IDs, forbidden Memory IDs and exact Citation expectations. The set declares independent ACL, Recall and Citation thresholds and carries an `ArtifactRef`. `FixedIndexEvaluationRunner` canonicalizes the payload and requires its SHA-256 Digest to match that Artifact before executing any case.

Three quality probes share one cached runner result per build. ACL measures forbidden Memory non-disclosure, Recall measures expected Memory coverage, and Citation matches artifact ID, URI, Digest and any declared locator fields. Every check cites the immutable evaluation-set Artifact.

`PostgresBuildingIndexQualityEvaluator` is a separate evaluation-only adapter. It requires the candidate version to remain `building`, binds the query to the task's index version, tenant, logical name, configuration Digest and source watermark, retrieves only Child chunks, and applies the same PostgreSQL Memory ACL predicate as production retrieval. It never changes the active-only behavior of normal retrievers. Once the version is active, this adapter refuses to read it.

This decision currently covers PostgreSQL lexical evaluation. Vector and fused hybrid evaluation require a later adapter that binds query embeddings and embedding-model identity to the fixed dataset.

## Consequences

- Candidate quality is measured against the candidate version rather than the previous active index.
- An evaluation payload cannot change while retaining the same evidence Digest.
- ACL, Recall and Citation checks are based on one consistent result set and remain independently auditable.
- The building-index path is narrow and cannot become a general retrieval bypass after activation.
- A passing lexical report does not claim pgvector or fused hybrid quality; those stages remain explicit follow-up work.
