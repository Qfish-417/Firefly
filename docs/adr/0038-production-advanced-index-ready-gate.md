# ADR 0038: Require the Advanced Index Ready Gate in production

## Context

The index Worker already persisted structural quality reports, and the repository refused to activate reports without source-watermark, ACL, Recall and Citation checks. However, the production process entry point still constructed `DefaultIndexReadyGate`, so builds could reach `ready` while remaining intentionally impossible to activate. This was safe but operationally incomplete and easy to misinterpret.

## Decision

The `memory:index-build` entry point defaults to `MEMORY_INDEX_READY_GATE_MODE=advanced`. Advanced mode requires an absolute `MEMORY_INDEX_EVALUATION_SET_FILE` containing a valid v1 `IndexEvaluationSet`. The loader bounds file size, requires UTF-8 JSON, validates the contract and verifies the Artifact digest against the canonical evaluation payload.

The Worker composes `SourceWatermarkQualityProbe` with the fixed PostgreSQL ACL, Recall and Citation probes. Evaluation reads only the task's building index version and checks tenant, logical-name, configuration, source-watermark and embedding snapshot identity. `MEMORY_INDEX_AUTO_ACTIVATE=true` is accepted only with the advanced gate.

`structural` mode remains available only as an explicit development setting. It cannot auto-activate, and the repository activation boundary continues to reject its incomplete quality report. A production process should be scoped to the tenant/logical index represented by its fixed evaluation set; use separate Worker deployments for different evaluation sets.

## Consequences

- A production-ready version now carries all five required, auditable checks from the process that built it.
- Evaluation dataset drift changes the Artifact digest and prevents startup or quality evaluation.
- Development can still exercise ingestion without maintaining a representative evaluation corpus, but those versions cannot be activated.
- Evaluation set distribution and mounting become deployment responsibilities and must be version controlled as immutable artifacts.
