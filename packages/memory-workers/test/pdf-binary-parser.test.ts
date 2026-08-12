import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BinaryContentHydratingIndexSourcePort,
  IndexBuildWorkerError,
  ParserBackedIndexSourcePort,
  PdfJsLayoutParser,
  PdfJsLayoutParserError,
  PdfLayoutChunker,
  type IndexSourceDocument,
} from "../src/index.ts";

function pdfDocument(bytes: Uint8Array, digest = sha256(bytes)): IndexSourceDocument {
  return {
    memory_id: "memory.parser.pdf",
    content: "",
    source_type: "application/pdf",
    entity_keys: ["concept.solar"],
    citation: {
      artifact_id: "artifact.parser.pdf",
      uri: "s3://parser-test/solar.pdf",
      digest,
      locator: { path: "documents/solar.pdf" },
    },
  };
}

test("binary source hydration reads bounded object bytes and verifies Citation digest", async () => {
  const bytes = minimalPdf("Solar output changes with daylight.");
  const source = new BinaryContentHydratingIndexSourcePort(
    { load: async () => [pdfDocument(bytes)] },
    { readObject: async (input) => {
      assert.deepEqual(input, { bucket: "parser-test", key: "solar.pdf", max_bytes: 100_000 });
      return bytes;
    } },
    { source_types: ["application/pdf"], max_object_bytes: 100_000 },
  );

  const documents = await source.load({ schema_version: 1 } as never);
  assert.deepEqual(documents[0]?.content_bytes, bytes);
});

test("binary source hydration rejects digest mismatch and invalid object URIs", async () => {
  const bytes = minimalPdf("Trusted text");
  const objects = { readObject: async () => bytes };
  await assert.rejects(
    new BinaryContentHydratingIndexSourcePort(
      { load: async () => [pdfDocument(bytes, `sha256:${"0".repeat(64)}`)] },
      objects,
      { source_types: ["application/pdf"] },
    ).load({ schema_version: 1 } as never),
    (error: unknown) => error instanceof IndexBuildWorkerError && error.code === "BINARY_SOURCE_DIGEST_MISMATCH",
  );
  await assert.rejects(
    new BinaryContentHydratingIndexSourcePort(
      { load: async () => [{ ...pdfDocument(bytes), citation: { ...pdfDocument(bytes).citation, uri: "https://example.test/solar.pdf" } }] },
      objects,
      { source_types: ["application/pdf"] },
    ).load({ schema_version: 1 } as never),
    (error: unknown) => error instanceof IndexBuildWorkerError && error.code === "INVALID_BINARY_SOURCE_URI",
  );
});

test("PDF.js parser extracts real page text and coordinates into the PDF Chunker path", async () => {
  const bytes = minimalPdf("Solar output changes with daylight.");
  const binarySource = new BinaryContentHydratingIndexSourcePort(
    { load: async () => [pdfDocument(bytes)] },
    { readObject: async () => bytes },
    { source_types: ["application/pdf"] },
  );
  const parsedSource = new ParserBackedIndexSourcePort(binarySource, { parsers: [new PdfJsLayoutParser()] });
  const documents = await parsedSource.load({ schema_version: 1 } as never);
  const structured = documents[0]?.structured;
  const chunks = new PdfLayoutChunker({ max_child_characters: 128 }).chunk(documents[0]!);

  assert.equal(structured?.kind, "pdf-layout");
  assert.equal(structured?.kind === "pdf-layout" ? structured.pages[0]?.blocks[0]?.text : undefined,
    "Solar output changes with daylight.");
  assert.equal(structured?.kind === "pdf-layout" ? structured.pages[0]?.blocks[0]?.bbox?.length : undefined, 4);
  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child"]);
  assert.equal(chunks[1]?.citation.locator?.page, 1);
  assert.match(chunks[1]?.content ?? "", /Solar output changes/u);
});

test("PDF.js parser fails closed for missing, malformed and image-only sources", async () => {
  const parser = new PdfJsLayoutParser();
  await assert.rejects(
    parser.parse(pdfDocument(new Uint8Array([1]))),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "BINARY_SOURCE_MISSING",
  );
  await assert.rejects(
    parser.parse({ ...pdfDocument(new Uint8Array([1, 2, 3])), content_bytes: new Uint8Array([1, 2, 3]) }),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "PDF_PARSE_FAILED",
  );
  const empty = minimalPdf("");
  await assert.rejects(
    parser.parse({ ...pdfDocument(empty), content_bytes: empty }),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "NO_EXTRACTABLE_TEXT",
  );
});

test("PDF.js parser enforces byte and extracted-text limits", async () => {
  const bytes = minimalPdf("Solar output");
  await assert.rejects(
    new PdfJsLayoutParser({ max_source_bytes: 1_024 }).parse({
      ...pdfDocument(new Uint8Array(1_025)), content_bytes: new Uint8Array(1_025),
    }),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "SOURCE_TOO_LARGE",
  );
  await assert.rejects(
    new PdfJsLayoutParser({ max_text_characters: 4 }).parse({ ...pdfDocument(bytes), content_bytes: bytes }),
    (error: unknown) => error instanceof PdfJsLayoutParserError && error.code === "TEXT_LIMIT_EXCEEDED",
  );
});

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = text ? `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
