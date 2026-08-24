import ExcelJS from "exceljs";

import type {
  IndexSourceDocument,
  IndexSourceParserPort,
  IndexTable,
  IndexTableSheet,
  IndexTableSource,
} from "./index-build-worker.ts";

const defaultSourceTypes = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
] as const;

export interface XlsxTableParserOptions {
  readonly parser_id?: string;
  readonly source_types?: readonly string[];
  readonly max_source_bytes?: number;
  readonly max_sheets?: number;
  readonly max_rows_per_sheet?: number;
  readonly max_columns?: number;
  readonly max_cell_characters?: number;
  readonly max_tables?: number;
  /**
   * Cap on the total *decompressed* size of the workbook's ZIP entries.
   *
   * `max_source_bytes` only bounds the compressed input, and XML of repeated whitespace compresses
   * at roughly 1000:1, so a file that passes that check can still expand into tens of gigabytes.
   */
  readonly max_decompressed_bytes?: number;
  /** Cap on the compression ratio of any single entry. */
  readonly max_compression_ratio?: number;
}

export class XlsxTableParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "BINARY_SOURCE_MISSING"
    | "SOURCE_TOO_LARGE"
    | "DECOMPRESSION_LIMIT_EXCEEDED"
    | "XLSX_PARSE_FAILED"
    | "SHEET_LIMIT_EXCEEDED"
    | "TABLE_LIMIT_EXCEEDED"
    | "ROW_LIMIT_EXCEEDED"
    | "COLUMN_LIMIT_EXCEEDED"
    | "CELL_LIMIT_EXCEEDED"
    | "FORMULA_RESULT_MISSING"
    | "UNSUPPORTED_CELL_VALUE"
    | "INVALID_HEADER"
    | "DUPLICATE_HEADER"
    | "ROW_WIDTH_MISMATCH"
    | "EMPTY_WORKBOOK";
  readonly retryable = false;

  constructor(code: XlsxTableParserError["code"], message: string) {
    super(message);
    this.name = "XlsxTableParserError";
    this.code = code;
  }
}

/** Reads XLSX workbooks into deterministic sheets/tables without executing formulas. */
export class XlsxTableParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly maxSourceBytes: number;
  private readonly maxSheets: number;
  private readonly maxRowsPerSheet: number;
  private readonly maxColumns: number;
  private readonly maxCellCharacters: number;
  private readonly maxTables: number;
  private readonly maxDecompressedBytes: number;
  private readonly maxCompressionRatio: number;

  constructor(options: XlsxTableParserOptions = {}) {
    this.parser_id = options.parser_id?.trim() || "exceljs-xlsx";
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.maxSourceBytes = options.max_source_bytes ?? 50_000_000;
    this.maxSheets = options.max_sheets ?? 128;
    this.maxRowsPerSheet = options.max_rows_per_sheet ?? 100_000;
    this.maxColumns = options.max_columns ?? 512;
    this.maxCellCharacters = options.max_cell_characters ?? 100_000;
    this.maxTables = options.max_tables ?? 512;
    this.maxDecompressedBytes = options.max_decompressed_bytes ?? 400_000_000;
    this.maxCompressionRatio = options.max_compression_ratio ?? 200;
    if (!this.parser_id || this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("XLSX parser ID and source types must be non-empty and unique");
    }
    validateInteger(this.maxSourceBytes, 1_024, 500_000_000, "source byte limit");
    validateInteger(this.maxSheets, 1, 10_000, "sheet limit");
    validateInteger(this.maxRowsPerSheet, 1, 1_000_000, "row limit");
    validateInteger(this.maxColumns, 1, 10_000, "column limit");
    validateInteger(this.maxCellCharacters, 1, 5_000_000, "cell character limit");
    validateInteger(this.maxTables, 1, 100_000, "table limit");
    validateInteger(this.maxDecompressedBytes, 1_024, 4_000_000_000, "decompressed byte limit");
    validateInteger(this.maxCompressionRatio, 2, 100_000, "compression ratio limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  async parse(document: IndexSourceDocument): Promise<IndexTableSource> {
    if (!this.supports(document.source_type)) throw configurationError(`Unsupported XLSX source type: ${document.source_type}`);
    const bytes = document.content_bytes;
    if (!bytes?.byteLength) throw new XlsxTableParserError("BINARY_SOURCE_MISSING", "XLSX parser requires hydrated binary source bytes");
    if (bytes.byteLength > this.maxSourceBytes) throw new XlsxTableParserError("SOURCE_TOO_LARGE", "XLSX source exceeds the configured byte limit");
    // Checked before handing the bytes to ExcelJS, which decompresses everything eagerly.
    assertSafeArchive(bytes, this.maxDecompressedBytes, this.maxCompressionRatio);

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);
    } catch (error) {
      throw new XlsxTableParserError("XLSX_PARSE_FAILED", safeErrorMessage(error));
    }
    if (workbook.worksheets.length === 0) throw new XlsxTableParserError("EMPTY_WORKBOOK", "XLSX workbook contains no worksheets");
    if (workbook.worksheets.length > this.maxSheets) throw new XlsxTableParserError("SHEET_LIMIT_EXCEEDED", "XLSX workbook exceeds the configured sheet limit");

    let tableCount = 0;
    const sheets: IndexTableSheet[] = [];
    for (const worksheet of workbook.worksheets) {
      const rows: string[][] = [];
      let maxColumn = 0;
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        if (row.number > this.maxRowsPerSheet + 1) throw new XlsxTableParserError("ROW_LIMIT_EXCEEDED", `Worksheet ${worksheet.name} exceeds the configured row limit`);
        maxColumn = Math.max(maxColumn, row.cellCount);
        if (maxColumn > this.maxColumns) throw new XlsxTableParserError("COLUMN_LIMIT_EXCEEDED", `Worksheet ${worksheet.name} exceeds the configured column limit`);
        const values = Array.from({ length: maxColumn }, (_, index) => valueToText(row.getCell(index + 1).value));
        if (values.some((value) => value.length > this.maxCellCharacters)) throw new XlsxTableParserError("CELL_LIMIT_EXCEEDED", `Worksheet ${worksheet.name} contains an oversized cell`);
        rows.push(values);
      });
      if (rows.length === 0) continue;
      const normalizedRows = rows.map((row) => Array.from({ length: maxColumn }, (_, index) => row[index] ?? ""));
      const table = makeTable(worksheet.name, normalizedRows, maxColumn);
      tableCount += 1;
      if (tableCount > this.maxTables) throw new XlsxTableParserError("TABLE_LIMIT_EXCEEDED", "XLSX workbook exceeds the configured table limit");
      sheets.push({ name: worksheet.name, tables: [table] });
    }
    if (sheets.length === 0) throw new XlsxTableParserError("EMPTY_WORKBOOK", "XLSX workbook contains no non-empty worksheets");
    return { kind: "table", sheets };
  }
}

function makeTable(sheetName: string, rows: readonly (readonly string[])[], width: number): IndexTable {
  const headers = rows[0]!.map((value) => value.trim());
  if (headers.length !== width || headers.some((value) => !value)) throw new XlsxTableParserError("INVALID_HEADER", `Worksheet ${sheetName} requires non-empty headers`);
  const normalized = headers.map((value) => value.toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) throw new XlsxTableParserError("DUPLICATE_HEADER", `Worksheet ${sheetName} contains duplicate headers`);
  const dataRows = rows.slice(1).map((row) => {
    if (row.length !== width) throw new XlsxTableParserError("ROW_WIDTH_MISMATCH", `Worksheet ${sheetName} contains an inconsistent row width`);
    return row;
  });
  return { name: sheetName.slice(0, 128), headers, rows: dataRows };
}

function valueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "formula" in value) {
    if (!("result" in value) || value.result === undefined) {
      throw new XlsxTableParserError("FORMULA_RESULT_MISSING", "XLSX formula cells require a cached result");
    }
    return valueToText(value.result as ExcelJS.CellValue);
  }
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "text" in value) return String(value.text);
  throw new XlsxTableParserError("UNSUPPORTED_CELL_VALUE", "XLSX cell value type is not supported for indexing");
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw configurationError(`XLSX parser ${label} must be between ${minimum} and ${maximum}`);
}

function configurationError(message: string): XlsxTableParserError {
  return new XlsxTableParserError("INVALID_CONFIGURATION", message);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "XLSX parsing failed";
}

/**
 * Reads declared entry sizes from the ZIP central directory and rejects implausible expansion.
 *
 * The central directory is authoritative for an intact archive and is read without decompressing
 * anything, so a bomb is refused before any memory is committed. A mismatch between the declared
 * and actual size would surface as an ExcelJS parse failure, which is already handled.
 */
function assertSafeArchive(bytes: Uint8Array, maxDecompressedBytes: number, maxRatio: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endSignature = 0x0605_4b50;
  const centralSignature = 0x0201_4b50;
  let end = -1;
  // The end-of-central-directory record sits in the last 64KiB (22 bytes + comment).
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === endSignature) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new XlsxTableParserError("XLSX_PARSE_FAILED", "XLSX source is not a readable ZIP archive");

  const entryCount = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== centralSignature) break;
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    totalUncompressed += uncompressed;
    if (totalUncompressed > maxDecompressedBytes) {
      throw new XlsxTableParserError(
        "DECOMPRESSION_LIMIT_EXCEEDED",
        "XLSX archive declares more decompressed bytes than the configured limit",
      );
    }
    if (compressed > 0 && uncompressed / compressed > maxRatio) {
      throw new XlsxTableParserError(
        "DECOMPRESSION_LIMIT_EXCEEDED",
        "XLSX archive contains an entry whose compression ratio exceeds the configured limit",
      );
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
}
