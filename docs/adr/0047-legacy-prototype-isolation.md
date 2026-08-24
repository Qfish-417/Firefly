# ADR 0047: Isolate the v0 prototype from the v3 trunk

## Context

The repository root carried two unrelated systems side by side. The v3 QuestLab trunk is a TypeScript
modular monolith under `packages/` and `agents/`, type-checked with `tsc --noEmit`, tested with
`node --test`, and deployed through the profiles in `infra/compose/`. Beside it sat the v0 prototype:
`main-agent` (Java/Spring Boot), `scout-agent` and `upgrade-agent` (Python/FastAPI), a `shared/proto`
gRPC contract, an `rag/scripts` index builder, an 11-service root `docker-compose.yml`, and
`infra/init-db.sql` — a schema unrelated to the `questlab` schema the v3 migrations own.

Nothing in the trunk imported the prototype, but the adjacency was itself a defect:

- Two `docker-compose.yml`-shaped entry points existed with no signal about which one a reader should
  start. The root file had never been startable: it bound host port 8080 twice.
- `infra/` mixed the v3 compose profiles with a legacy `init-db.sql`, implying the v3 migrator and
  that file described one schema. They do not.
- The prototype has no test suite, so nothing detected that it decayed while the trunk moved on.
- Root-level `.dockerignore` entries had to name each prototype directory individually, and a new
  prototype directory would silently enter every v3 build context.

## Decision

Move the prototype into `legacy/prototype-v0/` as one unit: `main-agent`, `scout-agent`,
`upgrade-agent`, `shared`, `rag`, its `docker-compose.yml`, and `init-db.sql`. Nothing is deleted and
no prototype behaviour changes; its compose file resolves against its own directory, so the relative
build contexts and the `init-db.sql` mount continue to work from the new location.

The boundary is enforced rather than documented:

- `tsconfig.json` already includes only `packages/**` and `agents/**`, so the trunk cannot come to
  depend on the prototype.
- `.dockerignore` excludes `legacy` as a single entry, so no prototype file can enter a v3 build
  context and a newly added one cannot leak in.
- CI runs a dedicated `legacy` job that byte-compiles the Python Agents and runs
  `mvn -DskipTests compile` on the Java Agent. The prototype has no tests, so a syntax and
  compilation gate is the floor that stops further undetected decay.
- The CI `compose` job validates all four compose files and asserts that the three carrying secrets
  refuse to resolve without them.

`infra/` now holds v3 deployment assets only, and the repository root holds exactly one runnable
system.

## Consequences

- A reader reaching the repository root sees one system, and `infra/compose/` describes only profiles
  the v3 trunk can actually run.
- The prototype stays available for reference and comparison, and stays buildable, without competing
  with the trunk for the root namespace.
- Prototype paths changed, so any external runbook referencing `./main-agent` or the root
  `docker-compose.yml` must be repointed at `legacy/prototype-v0/`.
- The prototype's own defects are unchanged apart from those already fixed (port collision,
  endpoint authentication, JSONB writes, DAG file keying, connection lifetimes, worktree cleanup).
  It is not a supported deployment target and its `evaluation_baseline` and `improvement` flows are
  still incomplete.
