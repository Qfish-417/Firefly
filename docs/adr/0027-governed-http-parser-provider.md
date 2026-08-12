# ADR 0027: Connect structured parsers through a governed HTTP adapter

## Status

Accepted

## Context

`ParserBackedIndexSourcePort` separated the Worker from parser implementations, but only in-process test parsers existed. Production PDF/OCR, AST, spreadsheet and transcript engines commonly run as separate services. A generic adapter must not introduce arbitrary URLs, redirects, unbounded responses or silent fallback behavior.

## Decision

Add `HttpIndexSourceParser` to `@firefly/memory-workers`. Each instance has a fixed absolute endpoint, stable parser ID and source-type allowlist. HTTPS is mandatory; explicitly enabled HTTP is allowed only for localhost development. URLs cannot contain credentials or fragments, redirects are rejected, reserved transport headers cannot be overridden, and request timeout and response byte limits are bounded.

Requests use a versioned JSON envelope containing immutable Memory, source, entity and Citation information. Responses must be UTF-8 `application/json` with `schema_version: 1` and one supported structured source kind. The adapter never performs a text fallback. Failures reach `ParserBackedIndexSourcePort`, where the existing strict or explicitly degraded policy remains authoritative.

## Consequences

- Local, remote and model-backed parsers can share one transport contract.
- Parser engine deployment, authentication secret injection and provider-specific quality evaluation remain external responsibilities.
- A compromised parser still cannot change index activation policy, ACL or the immutable source Citation.
- Large binary assets should be supplied through controlled object references in a future contract rather than embedded into this JSON request.
