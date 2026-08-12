import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type {
  IndexPdfLayoutBlock,
  IndexPdfLayoutSource,
  IndexSourceDocument,
  IndexSourceParserPort,
} from "./index-build-worker.ts";

const defaultSourceTypes = ["application/pdf"] as const;

export interface PdfJsLayoutParserOptions {
  readonly parser_id?: string;
  readonly source_types?: readonly string[];
  readonly max_source_bytes?: number;
  readonly max_pages?: number;
  readonly max_text_items?: number;
  readonly max_text_characters?: number;
}

export class PdfJsLayoutParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "BINARY_SOURCE_MISSING"
    | "SOURCE_TOO_LARGE"
    | "PDF_PARSE_FAILED"
    | "PAGE_LIMIT_EXCEEDED"
    | "TEXT_LIMIT_EXCEEDED"
    | "NO_EXTRACTABLE_TEXT";
  readonly retryable = false;

  constructor(code: PdfJsLayoutParserError["code"], message: string) {
    super(message);
    this.name = "PdfJsLayoutParserError";
    this.code = code;
  }
}

/** Extracts real PDF page text coordinates through PDF.js; scanned documents require a separate OCR provider. */
export class PdfJsLayoutParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly maxSourceBytes: number;
  private readonly maxPages: number;
  private readonly maxTextItems: number;
  private readonly maxTextCharacters: number;

  constructor(options: PdfJsLayoutParserOptions = {}) {
    this.parser_id = options.parser_id?.trim() || "pdfjs-layout";
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.maxSourceBytes = options.max_source_bytes ?? 50_000_000;
    this.maxPages = options.max_pages ?? 2_000;
    this.maxTextItems = options.max_text_items ?? 1_000_000;
    this.maxTextCharacters = options.max_text_characters ?? 20_000_000;
    if (!this.parser_id || this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("PDF parser ID and source types must be non-empty and unique");
    }
    validateInteger(this.maxSourceBytes, 1_024, 500_000_000, "source byte limit");
    validateInteger(this.maxPages, 1, 100_000, "page limit");
    validateInteger(this.maxTextItems, 1, 5_000_000, "text item limit");
    validateInteger(this.maxTextCharacters, 1, 100_000_000, "text character limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  async parse(document: IndexSourceDocument): Promise<IndexPdfLayoutSource> {
    if (!this.supports(document.source_type)) throw configurationError(`Unsupported PDF source type: ${document.source_type}`);
    const bytes = document.content_bytes;
    if (!bytes?.byteLength) throw new PdfJsLayoutParserError("BINARY_SOURCE_MISSING", "PDF parser requires hydrated binary source bytes");
    if (bytes.byteLength > this.maxSourceBytes) {
      throw new PdfJsLayoutParserError("SOURCE_TOO_LARGE", "PDF source exceeds the configured byte limit");
    }

    let pdf: Awaited<ReturnType<typeof getDocument>["promise"]>;
    try {
      pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    } catch (error) {
      throw new PdfJsLayoutParserError("PDF_PARSE_FAILED", safeErrorMessage(error));
    }
    try {
      if (pdf.numPages > this.maxPages) {
        throw new PdfJsLayoutParserError("PAGE_LIMIT_EXCEEDED", "PDF exceeds the configured page limit");
      }
      let itemCount = 0;
      let characterCount = 0;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const text = await page.getTextContent();
        const items: PdfTextItem[] = [];
        for (const item of text.items) {
          if (isTextItem(item)) items.push(item);
        }
        itemCount += items.length;
        characterCount += items.reduce((total, item) => total + item.str.length, 0);
        if (itemCount > this.maxTextItems || characterCount > this.maxTextCharacters) {
          throw new PdfJsLayoutParserError("TEXT_LIMIT_EXCEEDED", "PDF text exceeds the configured item or character limit");
        }
        pages.push({ page: pageNumber, blocks: lineBlocks(items, pageNumber) });
      }
      if (pages.every((page) => page.blocks.length === 0)) {
        throw new PdfJsLayoutParserError("NO_EXTRACTABLE_TEXT", "PDF contains no extractable text and requires an OCR provider");
      }
      return { kind: "pdf-layout", pages };
    } catch (error) {
      if (error instanceof PdfJsLayoutParserError) throw error;
      throw new PdfJsLayoutParserError("PDF_PARSE_FAILED", safeErrorMessage(error));
    } finally {
      await pdf.destroy();
    }
  }
}

interface PositionedText {
  readonly text: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

function lineBlocks(items: readonly PdfTextItem[], page: number): readonly IndexPdfLayoutBlock[] {
  const positioned = items
    .filter((item) => item.str.trim())
    .map((item): PositionedText => {
      const x = item.transform[4]!;
      const y = item.transform[5]!;
      const height = Math.max(Math.abs(item.height), Math.abs(item.transform[3]!), 1);
      return { text: item.str.trim(), x1: x, y1: y, x2: x + Math.max(item.width, 1), y2: y + height };
    })
    .sort((left, right) => right.y1 - left.y1 || left.x1 - right.x1);
  const lines: PositionedText[][] = [];
  for (const item of positioned) {
    const line = lines.find((candidate) => Math.abs(candidate[0]!.y1 - item.y1) <= Math.max(2, (item.y2 - item.y1) * 0.35));
    if (line) line.push(item);
    else lines.push([item]);
  }
  return lines.map((line, index) => {
    line.sort((left, right) => left.x1 - right.x1);
    return {
      kind: "paragraph",
      text: line.map((item) => item.text).join(" "),
      bbox: [
        Math.min(...line.map((item) => item.x1)),
        Math.min(...line.map((item) => item.y1)),
        Math.max(...line.map((item) => item.x2)),
        Math.max(...line.map((item) => item.y2)),
      ],
      region_id: `page-${page}-line-${index + 1}`,
    };
  });
}

function isTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PdfTextItem>;
  return typeof item.str === "string" && Array.isArray(item.transform) && item.transform.length >= 6 &&
    item.transform.every((part) => typeof part === "number" && Number.isFinite(part)) &&
    typeof item.width === "number" && Number.isFinite(item.width) &&
    typeof item.height === "number" && Number.isFinite(item.height);
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`PDF parser ${label} must be between ${minimum} and ${maximum}`);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "PDF parsing failed";
}

function configurationError(message: string): PdfJsLayoutParserError {
  return new PdfJsLayoutParserError("INVALID_CONFIGURATION", message);
}
