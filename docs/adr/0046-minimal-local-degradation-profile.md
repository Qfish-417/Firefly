# ADR 0046: Add a minimal local profile beside the lite profile

## Context

ADR 0042 defined `questlab-lite.yml` as the low-resource local target. Its steady state still contains two containers and its Retrieval API container is built from `infra/docker/questlab-runtime.Dockerfile`, which requires pulling a Node base image and running `npm ci` inside the container on first start. On a constrained or offline machine that build step is the only thing standing between a working repository and no runnable stack at all, even though the host already has a matching Node runtime and installed dependencies.

Removing the lite profile or relaxing its guarantees would lose a verified deployment shape. Treating an unavailable Retrieval container as success would be unsafe.

## Decision

Add `infra/compose/questlab-min.yml` and `infra/compose/questlab-min.env`（模板为 `questlab-min.env.example`） as an additional, further-degraded local profile. The lite and development profiles are unchanged.

The minimal profile containerizes only the one capability that may never be degraded: the PostgreSQL fact layer, using the already required `pgvector/pgvector:pg17` image so migration 007 can create the `vector` extension. Migration, the manual three-Agent loop, the Retrieval API and the read-only Admin API run as host Node processes through `node --env-file`. No image is built and no additional image is pulled, so the profile starts offline once the PostgreSQL image is cached.

The profile is isolated rather than overlaid: Compose project `firefly-questlab-min`, named volume `questlab-min-postgres`, and ports `55433`, `53201` and `3101` instead of `55432`, `53200` and `3100`. It can therefore run beside the lite or development stack without port conflicts or shared local data. All three ports bind to `127.0.0.1` only, because the profile ships public development placeholder values for the Retrieval API token and identity HMAC secret; process environment variables still take precedence over the env file.

Degradation matches ADR 0042 and is explicit: MinIO and object storage, index and deletion Workers, deletion reconciliation, retired-index GC, Docker Sandbox, OCR/ASR, Embedding with vector retrieval, reranking and real model calls are all off. Retrieval advertises PostgreSQL FTS only. ACL enforcement, deterministic structured aggregation, graph bounds, conflict visibility, Citation Digests, Loop Sentinel limits, budgets and human approval remain fail closed.

## Consequences

- A repository clone with a cached PostgreSQL image can reach `state: learned` on the durable fact layer with a single container and no build step.
- The verified containerized Retrieval API deployment shape remains available through the unchanged lite profile.
- Two local profiles must be kept consistent when runtime environment variables change; the minimal profile reads its configuration from a single committed env file to keep that surface small.
- The minimal profile does not claim external deletion completion, index-worker operation, vector or reranked retrieval, multimodal extraction, Sandbox verification or containerized service deployment.
