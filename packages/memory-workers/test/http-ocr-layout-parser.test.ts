import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HttpOcrLayoutParser,
  HttpOcrLayoutParserError,
  PdfJsLayoutParserError,
  PdfLayoutChunker,
  PdfTextOrOcrParser,
  type IndexSourceDocument,
  type IndexSourceParserPort,
} from "../src/index.ts";

const bytes = new TextEncoder().encode("scanned-pdf-fixture");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const document: IndexSourceDocument = {
  memory_id: "memory.ocr.http",
  content: "",
  content_bytes: bytes,
  source_type: "application/pdf",
  entity_keys: ["concept.solar"],
  citation: {
    artifact_id: "artifact.ocr.http",
    uri: "s3://ocr-test/scanned.pdf",
    digest,
    locator: { path: "documents/scanned.pdf" },
  },
};

function validResponse(): Record<string, unknown> {
  return {
    schema_version: 1,
    contract: "firefly.ocr-layout.v1",
    document_digest: digest,
    provider: {
      provider_id: "ocr.example",
      model_id: "layout-reader",
      model_version: "2026-08-01",
    },
    pages: [{
      page: 1,
      width: 1200,
      height: 1600,
      coordinate_unit: "pixel",
      blocks: [{
        sequence: 1,
        kind: "paragraph",
        text: "Solar output changes with daylight.",
        bbox: [100, 200, 600, 80],
        region_id: "page-1-region-1",
        confidence: 0.97,
        language: "en",
      }],
    }],
  };
}

test("HTTP OCR parser sends verified multipart bytes and preserves quality provenance", async () => {
  let request: Request | undefined;
  const parser = new HttpOcrLayoutParser({
    parser_id: "ocr.gateway.unit",
    endpoint: "https://ocr.test/v1/layout",
    source_types: ["application/pdf"],
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json(validResponse());
    },
  });

  const structured = await parser.parse(document);
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  const form = await request?.formData();
  const metadata = form?.get("metadata");
  const artifact = form?.get("document");
  assert.ok(metadata instanceof File);
  assert.ok(artifact instanceof File);
  assert.equal(Buffer.compare(Buffer.from(await artifact.arrayBuffer()), Buffer.from(bytes)), 0);
  assert.equal(JSON.parse(await metadata.text()).document.citation.digest, digest);
  assert.deepEqual(structured.extraction, {
    method: "ocr",
    provider_id: "ocr.example",
    model_id: "layout-reader",
    model_version: "2026-08-01",
  });

  const chunks = new PdfLayoutChunker({ max_child_characters: 128 }).chunk({ ...document, structured });
  assert.equal(chunks[1]?.citation.locator?.extraction_method, "ocr");
  assert.equal(chunks[1]?.citation.locator?.extraction_provider, "ocr.example");
  assert.equal(chunks[1]?.citation.locator?.confidence, 0.97);
  assert.equal(chunks[1]?.citation.locator?.coordinate_unit, "pixel");
  assert.equal(chunks[1]?.citation.locator?.bbox_width, 600);
});

test("HTTP OCR parser rejects unverified bytes and invalid provider coordinates", async () => {
  const parser = new HttpOcrLayoutParser({
    endpoint: "https://ocr.test/v1/layout",
    source_types: ["application/pdf"],
    fetch: async () => Response.json(validResponse()),
  });
  await assert.rejects(
    parser.parse({ ...document, citation: { ...document.citation, digest: `sha256:${"0".repeat(64)}` } }),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "DIGEST_MISMATCH",
  );

  const invalid = validResponse();
  const pages = invalid.pages as Array<{ blocks: Array<{ bbox: number[] }> }>;
  pages[0]!.blocks[0]!.bbox = [1100, 200, 600, 80];
  const invalidParser = new HttpOcrLayoutParser({
    endpoint: "https://ocr.test/v1/layout",
    source_types: ["application/pdf"],
    fetch: async () => Response.json(invalid),
  });
  await assert.rejects(
    invalidParser.parse(document),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "INVALID_RESPONSE",
  );
});

test("HTTP OCR parser requires the versioned contract and deterministic reading order", async () => {
  const missingContract = validResponse();
  delete missingContract.contract;
  await assert.rejects(
    new HttpOcrLayoutParser({
      endpoint: "https://ocr.test/v1/layout",
      fetch: async () => Response.json(missingContract),
    }).parse(document),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "INVALID_RESPONSE",
  );

  const unstableOrder = validResponse();
  const pages = unstableOrder.pages as Array<{ blocks: Array<{ sequence: number }> }>;
  pages[0]!.blocks[0]!.sequence = 2;
  await assert.rejects(
    new HttpOcrLayoutParser({
      endpoint: "https://ocr.test/v1/layout",
      fetch: async () => Response.json(unstableOrder),
    }).parse(document),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "INVALID_RESPONSE",
  );
});

test("PDF text/OCR parser falls back only for image-only PDF results", async () => {
  let ocrCalls = 0;
  const ocr: IndexSourceParserPort = {
    parser_id: "ocr.stub",
    supports: (sourceType) => sourceType === "application/pdf",
    parse: () => {
      ocrCalls += 1;
      return {
        kind: "pdf-layout",
        pages: [{ page: 1, blocks: [{ kind: "paragraph", text: "Recovered by OCR" }] }],
        extraction: { method: "ocr", provider_id: "ocr.stub" },
      };
    },
  };
  const imageOnly: IndexSourceParserPort = {
    parser_id: "pdf.image-only",
    supports: (sourceType) => sourceType === "application/pdf",
    parse: () => { throw new PdfJsLayoutParserError("NO_EXTRACTABLE_TEXT", "OCR required"); },
  };
  const parsed = await new PdfTextOrOcrParser({ native: imageOnly, ocr }).parse(document);
  assert.equal(parsed.extraction?.method, "ocr");
  assert.equal(ocrCalls, 1);

  const malformed: IndexSourceParserPort = {
    parser_id: "pdf.malformed",
    supports: (sourceType) => sourceType === "application/pdf",
    parse: () => { throw new PdfJsLayoutParserError("PDF_PARSE_FAILED", "Malformed PDF"); },
  };
  await assert.rejects(
    new PdfTextOrOcrParser({ native: malformed, ocr }).parse(document),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "PDF_PARSE_FAILED",
  );
  assert.equal(ocrCalls, 1);
});

test("HTTP OCR parser rejects insecure endpoints and oversized streamed responses", async () => {
  assert.throws(
    () => new HttpOcrLayoutParser({ endpoint: "http://ocr.example/v1/layout" }),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "INVALID_CONFIGURATION",
  );
  const parser = new HttpOcrLayoutParser({
    endpoint: "https://ocr.test/v1/layout",
    max_response_bytes: 1_024,
    fetch: async () => Response.json({ ...validResponse(), padding: "x".repeat(2_000) }),
  });
  await assert.rejects(
    parser.parse(document),
    (error: unknown) => error instanceof HttpOcrLayoutParserError && error.code === "RESPONSE_TOO_LARGE",
  );
});
