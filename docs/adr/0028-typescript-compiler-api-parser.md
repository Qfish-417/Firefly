# ADR 0028: Parse TypeScript and JavaScript with the compiler API

## Status

Accepted

## Context

The Code AST Chunker consumed typed parser output but the repository had no real code parser. Regex-based declaration extraction would lose syntax, nesting and exact source locations, and would misrepresent malformed code as structured evidence.

## Decision

Add `TypeScriptAstParser` using the official TypeScript Compiler API. It accepts an explicit TypeScript/JavaScript MIME allowlist, parses TS/TSX/JS/JSX, reports syntax diagnostics, and emits `IndexCodeAstSource` with top-level declarations, class/interface/module members, signatures, source text and exact line ranges.

The parser enforces source character, emitted node and nesting depth limits. Unsupported MIME types, syntax errors and resource-limit violations are non-retryable parser errors. `ParserBackedIndexSourcePort` remains responsible for strict blocking or explicitly diagnosed degradation.

## Consequences

- Code citations can resolve to real symbols and line ranges without an external parser service.
- The TypeScript package is a runtime dependency of `@firefly/memory-workers`.
- Semantic type checking and cross-file symbol resolution are not performed; the parser provides syntactic structure only.
- Other languages require separate parser providers under the same port.
