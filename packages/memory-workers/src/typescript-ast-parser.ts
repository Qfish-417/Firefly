import ts from "typescript";

import type {
  IndexCodeAstNode,
  IndexCodeAstSource,
  IndexSourceDocument,
  IndexSourceParserPort,
} from "./index-build-worker.ts";

const defaultSourceTypes = [
  "text/typescript",
  "application/typescript",
  "text/tsx",
  "application/tsx",
  "text/javascript",
  "application/javascript",
  "text/jsx",
  "application/jsx",
] as const;

export interface TypeScriptAstParserOptions {
  readonly parser_id?: string;
  readonly source_types?: readonly string[];
  readonly max_source_characters?: number;
  readonly max_nodes?: number;
  readonly max_depth?: number;
}

export class TypeScriptAstParserError extends Error {
  readonly code: "INVALID_CONFIGURATION" | "SOURCE_TOO_LARGE" | "SYNTAX_ERROR" | "AST_LIMIT_EXCEEDED";
  readonly retryable = false;

  constructor(code: TypeScriptAstParserError["code"], message: string) {
    super(message);
    this.name = "TypeScriptAstParserError";
    this.code = code;
  }
}

/** Real TypeScript Compiler API parser for TypeScript and JavaScript sources. */
export class TypeScriptAstParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly maxSourceCharacters: number;
  private readonly maxNodes: number;
  private readonly maxDepth: number;

  constructor(options: TypeScriptAstParserOptions = {}) {
    this.parser_id = options.parser_id?.trim() || "typescript-compiler-api";
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.maxSourceCharacters = options.max_source_characters ?? 2_000_000;
    this.maxNodes = options.max_nodes ?? 10_000;
    this.maxDepth = options.max_depth ?? 32;
    if (this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("AST parser source types must be non-empty and unique");
    }
    if (!Number.isInteger(this.maxSourceCharacters) || this.maxSourceCharacters < 1_024 || this.maxSourceCharacters > 20_000_000) {
      throw configurationError("AST parser source size must be between 1024 and 20000000 characters");
    }
    if (!Number.isInteger(this.maxNodes) || this.maxNodes < 1 || this.maxNodes > 100_000) {
      throw configurationError("AST parser node limit must be between 1 and 100000");
    }
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1 || this.maxDepth > 128) {
      throw configurationError("AST parser depth must be between 1 and 128");
    }
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  parse(document: IndexSourceDocument): IndexCodeAstSource {
    if (!this.supports(document.source_type)) {
      throw configurationError(`Unsupported AST source type: ${document.source_type}`);
    }
    if (document.content.length > this.maxSourceCharacters) {
      throw new TypeScriptAstParserError("SOURCE_TOO_LARGE", "AST source exceeds the configured character limit");
    }
    const language = languageFor(document.source_type);
    const fileName = fileNameFor(document, language);
    const scriptKind = scriptKindFor(document.source_type);
    const diagnostics = ts.transpileModule(document.content, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
      },
    }).diagnostics ?? [];
    const syntactic = diagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (syntactic) {
      throw new TypeScriptAstParserError("SYNTAX_ERROR", formatDiagnostic(syntactic));
    }
    const sourceFile = ts.createSourceFile(fileName, document.content, ts.ScriptTarget.ES2024, true, scriptKind);
    const budget = { nodes: 0 };
    const declarations = sourceFile.statements.filter(isIndexableDeclaration);
    const nodes = declarations.length > 0
      ? declarations.map((node) => convertNode(node, sourceFile, budget, 1, this.maxNodes, this.maxDepth))
      : [sourceFileNode(sourceFile, budget, this.maxNodes)];
    return { kind: "code-ast", language, nodes };
  }
}

function convertNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  budget: { nodes: number },
  depth: number,
  maxNodes: number,
  maxDepth: number,
): IndexCodeAstNode {
  consumeNodeBudget(budget, maxNodes);
  if (depth > maxDepth) throw new TypeScriptAstParserError("AST_LIMIT_EXCEEDED", "AST nesting exceeds the configured depth limit");
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getStart(sourceFile), node.getEnd() - 1)).line + 1;
  const children = childDeclarations(node).map((child) =>
    convertNode(child, sourceFile, budget, depth + 1, maxNodes, maxDepth),
  );
  const name = nodeName(node, sourceFile);
  const signature = nodeSignature(node, sourceFile);
  return {
    kind: syntaxKind(node),
    ...(name ? { name } : {}),
    ...(signature ? { signature } : {}),
    text: node.getText(sourceFile),
    start_line: start,
    end_line: end,
    ...(children.length > 0 ? { children } : {}),
  };
}

function sourceFileNode(sourceFile: ts.SourceFile, budget: { nodes: number }, maxNodes: number): IndexCodeAstNode {
  consumeNodeBudget(budget, maxNodes);
  const lineCount = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1;
  return {
    kind: "source-file",
    name: sourceFile.fileName,
    text: sourceFile.getFullText(),
    start_line: 1,
    end_line: Math.max(1, lineCount),
  };
}

function childDeclarations(node: ts.Node): readonly ts.Node[] {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node)) {
    return [...node.members];
  }
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    return node.body.statements.filter(isIndexableDeclaration);
  }
  return [];
}

function isIndexableDeclaration(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node);
}

function nodeName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((declaration) => declaration.name.getText(sourceFile)).join(", ");
  }
  if (ts.isImportDeclaration(node)) return node.importClause?.name?.text ?? node.moduleSpecifier.getText(sourceFile);
  if (ts.isExportDeclaration(node)) return node.moduleSpecifier?.getText(sourceFile) ?? "export";
  const named = node as ts.Node & { readonly name?: ts.Node };
  return named.name?.getText(sourceFile);
}

function nodeSignature(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const text = node.getText(sourceFile).trim();
  if (!text) return undefined;
  const bodyStart = text.indexOf("{");
  const signature = (bodyStart >= 0 ? text.slice(0, bodyStart) : text.split(/\r?\n/u)[0] ?? text).trim();
  return signature.slice(0, 1_024) || undefined;
}

function syntaxKind(node: ts.Node): string {
  return ts.SyntaxKind[node.kind]?.replace(/(Declaration|Statement|Signature)$/u, "").toLowerCase() || "unknown";
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return message.slice(0, 2_048);
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`.slice(0, 2_048);
}

function consumeNodeBudget(budget: { nodes: number }, maxNodes: number): void {
  budget.nodes += 1;
  if (budget.nodes > maxNodes) throw new TypeScriptAstParserError("AST_LIMIT_EXCEEDED", "AST exceeds the configured node limit");
}

function languageFor(sourceType: string): string {
  const normalized = normalizeSourceType(sourceType);
  return normalized.includes("typescript") || normalized.includes("tsx") ? "typescript" : "javascript";
}

function scriptKindFor(sourceType: string): ts.ScriptKind {
  const normalized = normalizeSourceType(sourceType);
  if (normalized.includes("tsx")) return ts.ScriptKind.TSX;
  if (normalized.includes("jsx")) return ts.ScriptKind.JSX;
  return normalized.includes("typescript") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function fileNameFor(document: IndexSourceDocument, language: string): string {
  const locator = document.citation.locator;
  const candidate = typeof locator?.path === "string" ? locator.path : undefined;
  return candidate || (language === "typescript" ? "source.ts" : "source.js");
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function configurationError(message: string): TypeScriptAstParserError {
  return new TypeScriptAstParserError("INVALID_CONFIGURATION", message);
}
