import path from "node:path";

import { parse as parseCsv } from "csv-parse/sync";

import type {
  IndexSourceDocument,
  IndexSourceParserPort,
  IndexTableSource,
} from "./index-build-worker.ts";

const defaultSourceTypes = ["text/csv", "application/csv"] as const;

export interface CsvTableParserOptions {
  readonly parser_id?: string;
  readonly source_types?: readonly string[];
  readonly sheet_name?: string;
  readonly table_name?: string;
  readonly max_source_characters?: number;
  readonly max_rows?: number;
  readonly max_columns?: number;
  readonly max_cell_characters?: number;
}

export class CsvTableParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "SOURCE_TOO_LARGE"
    | "SYNTAX_ERROR"
    | "EMPTY_TABLE"
    | "INVALID_HEADER"
    | "DUPLICATE_HEADER"
    | "ROW_LIMIT_EXCEEDED"
    | "COLUMN_LIMIT_EXCEEDED"
    | "CELL_LIMIT_EXCEEDED"
    | "ROW_WIDTH_MISMATCH";
  readonly retryable = false;

  constructor(code: CsvTableParserError["code"], message: string) {
    super(message);
    this.name = "CsvTableParserError";
    this.code = code;
  }
}

/** RFC-style CSV parser that emits one bounded, explicitly named table. */
export class CsvTableParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly sheetName: string;
  private readonly tableName: string | undefined;
  private readonly maxSourceCharacters: number;
  private readonly maxRows: number;
  private readonly maxColumns: number;
  private readonly maxCellCharacters: number;

  constructor(options: CsvTableParserOptions = {}) {
    this.parser_id = options.parser_id?.trim() || "csv-parse";
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.sheetName = options.sheet_name?.trim() || "CSV";
    this.tableName = options.table_name?.trim() || undefined;
    this.maxSourceCharacters = options.max_source_characters ?? 5_000_000;
    this.maxRows = options.max_rows ?? 100_000;
    this.maxColumns = options.max_columns ?? 512;
    this.maxCellCharacters = options.max_cell_characters ?? 100_000;

    if (this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("CSV parser source types must be non-empty and unique");
    }
    validateName(this.sheetName, "sheet");
    if (this.tableName) validateName(this.tableName, "table");
    validateInteger(this.maxSourceCharacters, 1_024, 50_000_000, "source character limit");
    validateInteger(this.maxRows, 0, 1_000_000, "row limit");
    validateInteger(this.maxColumns, 1, 10_000, "column limit");
    validateInteger(this.maxCellCharacters, 1, 5_000_000, "cell character limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  parse(document: IndexSourceDocument): IndexTableSource {
    if (!this.supports(document.source_type)) {
      throw configurationError(`Unsupported CSV source type: ${document.source_type}`);
    }
    if (document.content.length > this.maxSourceCharacters) {
      throw new CsvTableParserError("SOURCE_TOO_LARGE", "CSV source exceeds the configured character limit");
    }

    let records: string[][];
    try {
      records = parseCsv(document.content, {
        bom: true,
        encoding: "utf8",
        relax_column_count: true,
        skip_empty_lines: true,
      }) as string[][];
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown CSV syntax error";
      throw new CsvTableParserError("SYNTAX_ERROR", detail.slice(0, 2_048));
    }

    if (records.length === 0) throw new CsvTableParserError("EMPTY_TABLE", "CSV source must contain a header row");
    const headers = records[0]!.map((header) => header.trim());
    if (headers.length > this.maxColumns) {
      throw new CsvTableParserError("COLUMN_LIMIT_EXCEEDED", "CSV header exceeds the configured column limit");
    }
    if (headers.some((header) => !header)) {
      throw new CsvTableParserError("INVALID_HEADER", "CSV headers must be non-empty after trimming");
    }
    const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase("en-US"));
    if (new Set(normalizedHeaders).size !== normalizedHeaders.length) {
      throw new CsvTableParserError("DUPLICATE_HEADER", "CSV headers must be unique ignoring case");
    }

    const rows = records.slice(1);
    if (rows.length > this.maxRows) {
      throw new CsvTableParserError("ROW_LIMIT_EXCEEDED", "CSV source exceeds the configured data row limit");
    }
    for (const [index, row] of rows.entries()) {
      if (row.length !== headers.length) {
        throw new CsvTableParserError(
          "ROW_WIDTH_MISMATCH",
          `CSV data row ${index + 2} has ${row.length} columns; expected ${headers.length}`,
        );
      }
    }
    for (const [rowIndex, row] of records.entries()) {
      for (const [columnIndex, cell] of row.entries()) {
        if (cell.length > this.maxCellCharacters) {
          throw new CsvTableParserError(
            "CELL_LIMIT_EXCEEDED",
            `CSV cell at row ${rowIndex + 1}, column ${columnIndex + 1} exceeds the configured character limit`,
          );
        }
      }
    }

    return {
      kind: "table",
      sheets: [{
        name: this.sheetName,
        tables: [{ name: this.tableName ?? deriveTableName(document), headers, rows }],
      }],
    };
  }
}

function deriveTableName(document: IndexSourceDocument): string {
  const locator = document.citation.locator;
  const locatorPath = typeof locator?.path === "string" ? locator.path : undefined;
  const candidate = locatorPath ?? uriPath(document.citation.uri);
  const baseName = path.posix.basename(candidate.replaceAll("\\", "/"));
  const extension = path.posix.extname(baseName);
  const stem = (extension ? baseName.slice(0, -extension.length) : baseName).trim();
  return stem ? stem.slice(0, 128) : "Table";
}

function uriPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.split(/[?#]/u, 1)[0] ?? "";
  }
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`CSV parser ${label} must be between ${minimum} and ${maximum}`);
  }
}

function validateName(value: string, label: string): void {
  if (!value || value.length > 128) throw configurationError(`CSV parser ${label} name must contain 1 to 128 characters`);
}

function configurationError(message: string): CsvTableParserError {
  return new CsvTableParserError("INVALID_CONFIGURATION", message);
}
