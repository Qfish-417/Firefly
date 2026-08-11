# ADR 0021: Preserve parser structure in PDF, code and table chunks

- Status: accepted
- Date: 2026-08-11

## Context

Character windows are insufficient for PDF layout, source code and tables. They lose page regions, symbol boundaries and row/column meaning, which makes citations and later aggregation unreliable. The existing `IndexChunkerPort` and Parent/Child index contract provide a stable place to add parser-specific boundaries without coupling the retrieval layer to a parser implementation.

## Decision

Extend `IndexSourceDocument` with optional typed parser output and add three deterministic chunkers:

- `PdfLayoutChunker` consumes pages and layout blocks, preserving page, heading path, bounding box and region locators.
- `CodeAstChunker` consumes language-tagged AST nodes, preserving symbol paths, node kinds and start/end lines.
- `TableStructureChunker` consumes sheets, tables, headers and rows, preserving row groups and sheet/table coordinates.

All three emit a Parent for context and Child chunks for recall. Parent chunks never receive embeddings. Child identity remains a function of index version, Memory, ordinal and immutable content. Missing or mismatched parser output is a non-retryable `STRUCTURED_SOURCE_MISSING` error; a structured chunker must never silently fall back to character slicing. Parser provenance and configuration belong in the source watermark/configuration Digest so a parser upgrade creates a new build and quality report.

## Consequences

- Evidence can cite the original page/region, code lines or table coordinates.
- Retrieval and context expansion share one contract across content types.
- Real PDF/OCR, AST and spreadsheet parsers still need SourcePort adapters; the chunkers deliberately do not embed third-party parser dependencies.
- Oversized parser nodes can still require policy-specific splitting, but every split retains its structural path and locator.
