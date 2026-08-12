# ADR 0031: Hydrate verified binary artifacts before PDF parsing

## Status

Accepted

## Context

`IndexSourceDocument` originally carried text content, while PDF and workbook providers require immutable bytes. Passing base64 strings through text fields would obscure size accounting and allow a parser to consume bytes that no longer match the Artifact Citation digest.

## Decision

Add an optional `content_bytes` field and a `BinaryContentHydratingIndexSourcePort`. For configured binary MIME types it reads only `s3://` artifacts through a bounded object-store port, enforces a byte limit and verifies the exact SHA-256 Citation digest before exposing bytes to a parser.

Add `PdfJsLayoutParser` using PDF.js. It consumes hydrated bytes, enforces page/text budgets, extracts text lines with page-local bounding boxes and emits `IndexPdfLayoutSource`. Malformed PDFs, missing bytes, limits and PDFs with no extractable text fail closed; scanned documents require an explicit OCR provider.

## Consequences

- Binary parsers no longer need to reinterpret text or trust an unverified payload.
- PDF citations retain page, line-region and bounding-box provenance.
- PDF.js is a runtime dependency of `@firefly/memory-workers`.
- OCR, tables embedded in PDFs and workbook formats remain separate providers.
- Existing text parsers are unaffected and continue using `content`.
