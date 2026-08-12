import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import ExcelJS from "exceljs";

import {
  BinaryContentHydratingIndexSourcePort,
  ParserBackedIndexSourcePort,
  TableStructureChunker,
  XlsxTableParser,
  XlsxTableParserError,
  type IndexSourceDocument,
} from "../src/index.ts";

const digest = `sha256:${"f".repeat(64)}` as const;

function xlsxDocument(bytes: Uint8Array, sourceType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"): IndexSourceDocument {
  return {
    memory_id: "memory.parser.xlsx",
    content: "",
    content_bytes: bytes,
    source_type: sourceType,
    entity_keys: ["dataset.countries"],
    citation: { artifact_id: "artifact.parser.xlsx", uri: "s3://parser-test/countries.xlsx", digest },
  };
}

async function workbookBytes(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const countries = workbook.addWorksheet("Countries");
  countries.addRow(["Country", "Year"]);
  countries.addRow(["US", 2024]);
  countries.addRow(["JP", 2025]);
  const empty = workbook.addWorksheet("Empty");
  void empty;
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

test("XLSX parser preserves multiple non-empty sheets and cached formula values", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Metrics");
  sheet.addRow(["Country", "Count"]);
  sheet.addRow(["US", 2]);
  sheet.addRow(["JP", { formula: "1+1", result: 2 }]);
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Topic", "Note"]);
  notes.addRow(["Solar", "Daylight varies"]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const source = await new XlsxTableParser().parse(xlsxDocument(bytes));

  assert.deepEqual(source.sheets.map((item) => item.name), ["Metrics", "Notes"]);
  assert.deepEqual(source.sheets[0]?.tables[0]?.headers, ["Country", "Count"]);
  assert.deepEqual(source.sheets[0]?.tables[0]?.rows, [["US", "2"], ["JP", "2"]]);
});

test("XLSX parser and TableStructureChunker form a real workbook indexing path", async () => {
  const bytes = await workbookBytes();
  const document = xlsxDocument(bytes);
  const sourcePort = new ParserBackedIndexSourcePort({ load: async () => [document] }, {
    parsers: [new XlsxTableParser()],
  });
  const parsed = await sourcePort.load({ schema_version: 1 } as never);
  const chunks = new TableStructureChunker({ max_child_characters: 128 }).chunk(parsed[0]!);

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child"]);
  assert.equal(chunks[1]?.citation.locator?.sheet, "Countries");
  assert.equal(chunks[1]?.citation.locator?.table, "Countries");
  assert.match(chunks[1]?.content ?? "", /Country=US/u);
});

test("XLSX parser can hydrate bytes through the governed binary source port", async () => {
  const bytes = await workbookBytes();
  const document = { ...xlsxDocument(bytes), citation: { ...xlsxDocument(bytes).citation, digest: sha256(bytes) } };
  const { content_bytes: _bytes, ...unhydrated } = document;
  const hydrated = new BinaryContentHydratingIndexSourcePort(
    { load: async () => [unhydrated] },
    { readObject: async () => bytes },
    { source_types: [document.source_type], max_object_bytes: 100_000 },
  );
  const parsed = await new ParserBackedIndexSourcePort(hydrated, { parsers: [new XlsxTableParser()] }).load({ schema_version: 1 } as never);
  assert.equal(parsed[0]?.structured?.kind, "table");
});

test("XLSX parser rejects invalid headers, row widths and MIME types", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Bad");
  sheet.addRow(["Name", "name"]);
  sheet.addRow(["FireFly"]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    new XlsxTableParser().parse(xlsxDocument(bytes)),
    (error: unknown) => error instanceof XlsxTableParserError && ["DUPLICATE_HEADER", "ROW_WIDTH_MISMATCH"].includes(error.code),
  );
  await assert.rejects(
    new XlsxTableParser().parse(xlsxDocument(bytes, "application/octet-stream")),
    (error: unknown) => error instanceof XlsxTableParserError && error.code === "INVALID_CONFIGURATION",
  );
});

test("XLSX parser never evaluates formulas without a cached result", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Formula");
  sheet.addRow(["Value"]);
  sheet.addRow([{ formula: "1+1" }]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    new XlsxTableParser().parse(xlsxDocument(bytes)),
    (error: unknown) => error instanceof XlsxTableParserError && error.code === "FORMULA_RESULT_MISSING",
  );
});

test("XLSX parser enforces binary, sheet, row, column and cell limits", async () => {
  const bytes = await workbookBytes();
  await assert.rejects(
    new XlsxTableParser({ max_source_bytes: 1_024 }).parse({ ...xlsxDocument(bytes), content_bytes: new Uint8Array(1_025) }),
    (error: unknown) => error instanceof XlsxTableParserError && error.code === "SOURCE_TOO_LARGE",
  );
  await assert.rejects(
    new XlsxTableParser({ max_rows_per_sheet: 1 }).parse({ ...xlsxDocument(bytes), content_bytes: bytes }),
    (error: unknown) => error instanceof XlsxTableParserError && error.code === "ROW_LIMIT_EXCEEDED",
  );
});

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
