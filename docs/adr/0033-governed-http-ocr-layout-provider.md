# ADR 0033: Govern OCR as a versioned binary layout provider

## Status

Accepted

## Context

PDF.js extracts trustworthy text coordinates from born-digital PDFs but intentionally rejects image-only documents. A remote OCR engine needs original bytes, not the text-only `HttpIndexSourceParser` envelope. Sending an object-store URL would delegate storage credentials and fetch policy to the provider, while accepting unbounded or weakly identified OCR output would make derived evidence impossible to audit.

## Decision

Add `HttpOcrLayoutParser` as a fixed-endpoint adapter. It accepts only hydrated binary content whose SHA-256 digest matches the immutable Artifact Citation, enforces source size and MIME allowlists, and sends multipart data to HTTPS endpoints only. Explicitly enabled localhost HTTP remains available for development. Redirects, credentials in URLs and reserved transport-header overrides are rejected.

The provider response uses `schema_version: 1`, declares `contract: firefly.ocr-layout.v1` and must echo the input document digest. It identifies the provider and optional model/version, then returns pages numbered contiguously from one with pixel dimensions. Blocks carry a contiguous page-local reading-order sequence, controlled kind, non-empty text, page-local `[x, y, width, height]` bounding box, unique region ID, confidence in `[0,1]` and optional language. Response bytes, pages, blocks and text are bounded. Invalid UTF-8/JSON, digest mismatch, unstable ordering, empty output, duplicate or out-of-page coordinates and resource-limit violations fail closed.

Add `PdfTextOrOcrParser` to select native extraction first and invoke OCR only when `PdfJsLayoutParser` returns `NO_EXTRACTABLE_TEXT`. Other PDF failures are preserved. Both paths emit `IndexPdfLayoutSource`; extraction identity, page geometry and OCR quality metadata flow into Chunk Citation locators.

## Consequences

- The Worker remains independent of any OCR vendor or native OCR runtime.
- Verified bytes cross only one configured outbound boundary; providers do not receive object-store credentials or arbitrary fetch URLs.
- OCR output stays derived and auditable rather than becoming indistinguishable from source content.
- Provider credentials, rate limits, data residency, retention and concrete engine deployment remain environment concerns.
- OCR is not a catch-all recovery path for malformed, oversized or unverified PDFs.
