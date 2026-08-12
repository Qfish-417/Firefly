# ADR 0032: Parse XLSX workbooks with ExcelJS

## Status

Accepted

## Context

CSV support covered one flat table but did not preserve workbook sheets, typed cell values or formula results. XLSX is a binary container and must use the verified binary hydration boundary before parsing.

## Decision

Add `XlsxTableParser` using ExcelJS for XLSX and macro-enabled workbook MIME types. Each non-empty worksheet becomes one named `IndexTableSheet` with one table. The first non-empty row is the header and remaining rows are normalized to a rectangular table. Empty trailing cells are preserved as empty strings.

The parser enforces source byte, sheet, table, row, column and cell limits. Headers must be non-empty and unique ignoring case. Formula expressions are never executed; a formula cell must contain a cached workbook result or parsing fails closed. Unsupported cell value types also fail closed.

## Consequences

- Multi-sheet workbooks reach `TableStructureChunker` with stable sheet/table coordinates.
- Binary bytes are loaded and digest-verified by `BinaryContentHydratingIndexSourcePort` before parsing.
- ExcelJS is a runtime dependency of `@firefly/memory-workers`.
- Formula recalculation, macros, merged-cell semantics and embedded charts/images are not executed or inferred.
