# ADR 0023: Keep parser providers outside the index worker

- Status: accepted
- Date: 2026-08-11

## Context

PDF/OCR, AST, spreadsheet and transcript parsers have different runtimes and may be backed by local libraries, remote services or models. Binding any one parser to `RetrievalIndexBuildWorker` would make deployment and failure behavior implicit. A parser outage must be distinguishable from an empty source and must not silently produce trusted structural coordinates.

## Decision

Add `IndexSourceParserPort` and `ParserBackedIndexSourcePort`. The adapter selects the first parser whose `supports(source_type)` matches, validates that the result is one of the typed `IndexStructuredSource` variants, and preserves source order. Parser IDs are unique and parser failures are classified as `parser-missing`, `parser-failed` or `parser-invalid-output`.

`parser_failure_mode` defaults to `strict`, which raises a non-retryable worker error. Explicit `degraded` mode returns the original document with a parser diagnostic; the configured structured Chunker may then use its explicit plain-text fallback and expose that diagnostic in the Citation Locator. The adapter contains no third-party parser dependency.

## Consequences

- Real parser implementations can be local, remote or model-backed without changing the Worker.
- Parser availability and parser output validity are observable and policy-controlled.
- A degraded build must remain distinguishable from a structurally parsed build for evaluation and activation policy.
