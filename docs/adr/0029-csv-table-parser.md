# ADR 0029: Parse CSV tables with a standards-compliant library

## Status

Accepted

## Context

The table Chunker consumed typed sheet, table, header and row structures, but the repository had no real table parser. Hand-written delimiter splitting would corrupt quoted commas, embedded newlines and escaped quotes, while permissive repair of malformed rows would make citation coordinates unreliable.

## Decision

Add `CsvTableParser` using `csv-parse`. It accepts an explicit CSV MIME allowlist, removes a UTF-8 BOM, preserves quoted fields and emits one `IndexTableSource` sheet and table. The first record is the header; remaining records are data rows. The table name is configured explicitly or deterministically derived from the Citation path/URI.

Empty or case-insensitively duplicate headers and inconsistent row widths fail closed. Source characters, data rows, columns and cell characters have configurable hard limits. Syntax and validation failures are non-retryable parser errors. `ParserBackedIndexSourcePort` remains responsible for strict blocking or explicitly diagnosed degradation.

## Consequences

- CSV evidence reaches `TableStructureChunker` without ad hoc delimiter handling.
- Quoted delimiters, embedded newlines and escaped quotes remain intact.
- `csv-parse` is a runtime dependency of `@firefly/memory-workers`.
- XLSX, formulas, merged cells and multi-sheet workbooks require separate providers under the same parser port.
- The parser does not infer types or silently repair malformed tables.
