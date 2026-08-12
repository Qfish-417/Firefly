import assert from "node:assert/strict";
import test from "node:test";

import {
  CsvTableParser,
  CsvTableParserError,
  ParserBackedIndexSourcePort,
  TableStructureChunker,
  type IndexSourceDocument,
} from "../src/index.ts";

const digest = `sha256:${"d".repeat(64)}` as const;

function csvDocument(content: string, sourceType = "text/csv"): IndexSourceDocument {
  return {
    memory_id: "memory.parser.csv",
    content,
    source_type: sourceType,
    entity_keys: ["dataset.trips"],
    citation: {
      artifact_id: "artifact.parser.csv",
      uri: "s3://parser-test/trips.csv",
      digest,
      locator: { path: "datasets/country-trips.csv" },
    },
  };
}

test("CSV parser preserves quoted delimiters, newlines, escapes and deterministic names", () => {
  const source = new CsvTableParser().parse(csvDocument([
    "\ufeffCountry,Note,Count",
    "FR,\"Paris, Lyon\",2",
    "JP,\"line one",
    "line two with \"\"quote\"\"\",1",
  ].join("\n")));

  assert.equal(source.sheets[0]?.name, "CSV");
  assert.equal(source.sheets[0]?.tables[0]?.name, "country-trips");
  assert.deepEqual(source.sheets[0]?.tables[0]?.headers, ["Country", "Note", "Count"]);
  assert.deepEqual(source.sheets[0]?.tables[0]?.rows, [
    ["FR", "Paris, Lyon", "2"],
    ["JP", "line one\nline two with \"quote\"", "1"],
  ]);
});

test("CSV parser and TableStructureChunker form a real structured indexing path", async () => {
  const document = csvDocument("country,year\nUS,2024\nJP,2025");
  const sourcePort = new ParserBackedIndexSourcePort({ load: async () => [document] }, {
    parsers: [new CsvTableParser()],
  });
  const parsed = await sourcePort.load({ schema_version: 1 } as never);
  const chunks = new TableStructureChunker({ max_child_characters: 128 }).chunk(parsed[0]!);

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child"]);
  assert.deepEqual(chunks[1]?.structure_path, ["CSV", "country-trips"]);
  assert.equal(chunks[1]?.citation.locator?.sheet, "CSV");
  assert.equal(chunks[1]?.citation.locator?.table, "country-trips");
  assert.match(chunks[1]?.content ?? "", /country=US/u);
});

test("CSV parser rejects ambiguous headers and inconsistent row widths", () => {
  const parser = new CsvTableParser();
  assert.throws(
    () => parser.parse(csvDocument("country,,year\nUS,x,2024")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "INVALID_HEADER",
  );
  assert.throws(
    () => parser.parse(csvDocument("country,Country\nUS,FR")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "DUPLICATE_HEADER",
  );
  assert.throws(
    () => parser.parse(csvDocument("country,year\nUS")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "ROW_WIDTH_MISMATCH",
  );
});

test("CSV parser rejects syntax errors and bounded-resource violations", () => {
  const parser = new CsvTableParser({
    max_source_characters: 1_024,
    max_rows: 1,
    max_columns: 2,
    max_cell_characters: 4,
  });
  assert.throws(
    () => parser.parse(csvDocument("name\n\"unterminated")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "SYNTAX_ERROR",
  );
  assert.throws(
    () => parser.parse(csvDocument("a,b,c\n1,2,3")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "COLUMN_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parser.parse(csvDocument("a\n1\n2")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "ROW_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parser.parse(csvDocument("header\nvalue")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "CELL_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parser.parse(csvDocument("x".repeat(1_025))),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "SOURCE_TOO_LARGE",
  );
});

test("CSV parser has an explicit MIME allowlist and validates configuration", () => {
  const parser = new CsvTableParser({ table_name: "Configured" });
  assert.equal(parser.supports("Application/CSV"), true);
  assert.equal(parser.parse(csvDocument("name\nFireFly", "application/csv")).sheets[0]?.tables[0]?.name, "Configured");
  assert.throws(
    () => parser.parse(csvDocument("name\nFireFly", "application/vnd.ms-excel")),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () => new CsvTableParser({ source_types: ["text/csv", "TEXT/CSV"] }),
    (error: unknown) => error instanceof CsvTableParserError && error.code === "INVALID_CONFIGURATION",
  );
});
