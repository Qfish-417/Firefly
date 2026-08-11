# ADR 0015: Persist an auditable quality report before index activation

- Status: accepted
- Date: 2026-08-11

## Context

The durable index worker from ADR 0014 could prove structural completeness, but a successful process did not prove that the source snapshot remained current, access controls were preserved, relevant evidence was recalled, or citations still resolved correctly. Keeping these checks only in logs would make activation decisions difficult to audit and would allow a quality result from one build to be reused for another.

## Decision

Introduce versioned `IndexQualityCheck` and `IndexQualityReport` contracts. Each check records a governed name, pass/fail outcome, normalized score, threshold, sample size, summary and optional immutable evidence references. A report binds those checks to the build ID, index version ID, source watermark and configuration Digest, and records its evaluation time.

`AdvancedIndexReadyGate` always runs the structural gate and requires exactly one configured probe for source watermark, ACL, Recall and Citation concerns. Missing or duplicate probes fail at construction. Probe results fail closed when values are out of bounds, when the declared outcome disagrees with score versus threshold, or when the aggregate outcome disagrees with its checks. `SourceWatermarkQualityProbe` provides the built-in immutable snapshot comparison; deployment-specific ACL and evaluation dataset adapters implement the remaining ports.

`RetrievalIndexBuildWorker` creates a stable report identity from the build and canonicalized checks, validates the report at the contract boundary, and includes it in `IndexBuildResult`. Migration 009 stores the report on `questlab.retrieval_index_version`. `RetrievalIndexRepository` verifies report identity against the persisted build before accepting completion and includes the report in idempotent replay comparison. A failed report cannot produce a ready build.

`IndexBuildResult.quality_report` remains optional in v1 so historical result events can still be decoded and failed builds can terminate before quality evaluation. New background Worker completions always include it. `RetrievalIndexRepository.activate` requires a valid report containing each of the five governed checks exactly once, re-evaluates score versus threshold, and rechecks persisted identity. A reportless, incomplete or internally inconsistent legacy result cannot bypass the activation boundary.

## Consequences

- Activation evidence survives process logs and can be inspected with the index version.
- Quality reports cannot be transplanted across builds, source snapshots or configuration changes.
- Structural and source-watermark checks have concrete implementations.
- ACL, Recall and Citation are explicit required ports, not simulated by the model or inferred from build success.
- Deterministic integration probes verify orchestration and persistence only. Production evaluation datasets, ACL samplers and evidence artifacts remain required before claiming retrieval quality readiness.
- Parent/Child chunking, retired-index garbage collection and production BM25/ANN remain separate changes.
