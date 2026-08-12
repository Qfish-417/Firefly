import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeAstChunker,
  ParserBackedIndexSourcePort,
  TypeScriptAstParser,
  TypeScriptAstParserError,
  type IndexSourceDocument,
} from "../src/index.ts";

const digest = `sha256:${"c".repeat(64)}` as const;

function codeDocument(content: string, sourceType = "text/typescript"): IndexSourceDocument {
  return {
    memory_id: "memory.parser.typescript",
    content,
    source_type: sourceType,
    entity_keys: ["concept.parser"],
    citation: {
      artifact_id: "artifact.parser.typescript",
      uri: "s3://parser-test/source.ts",
      digest,
      locator: { path: "src/source.ts" },
    },
  };
}

test("TypeScript parser extracts declarations, members and exact line ranges", () => {
  const parser = new TypeScriptAstParser();
  const source = parser.parse(codeDocument([
    "export interface UserRepository {",
    "  find(id: string): Promise<string>;",
    "}",
    "",
    "export class UserService {",
    "  constructor(private readonly repository: UserRepository) {}",
    "  async load(id: string): Promise<string> {",
    "    return this.repository.find(id);",
    "  }",
    "}",
  ].join("\n")));

  assert.equal(source.language, "typescript");
  assert.deepEqual(source.nodes.map((node) => [node.kind, node.name, node.start_line, node.end_line]), [
    ["interface", "UserRepository", 1, 3],
    ["class", "UserService", 5, 10],
  ]);
  assert.deepEqual(source.nodes[1]?.children?.map((node) => [node.kind, node.name]), [
    ["constructor", undefined],
    ["method", "load"],
  ]);
});

test("TypeScript parser and CodeAstChunker form a real structured indexing path", async () => {
  const document = codeDocument("export function sum(left: number, right: number) {\n  return left + right;\n}");
  const sourcePort = new ParserBackedIndexSourcePort({ load: async () => [document] }, {
    parsers: [new TypeScriptAstParser()],
  });
  const parsed = await sourcePort.load({ schema_version: 1 } as never);
  const chunks = new CodeAstChunker().chunk(parsed[0]!);

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child"]);
  assert.equal(chunks[1]?.citation.locator?.language, "typescript");
  assert.equal(chunks[1]?.citation.locator?.start_line, 1);
  assert.equal(chunks[1]?.citation.locator?.end_line, 3);
  assert.match(chunks[1]?.content ?? "", /return left \+ right/u);
});

test("TypeScript parser rejects syntax errors and bounded-resource violations", () => {
  const parser = new TypeScriptAstParser({ max_source_characters: 1_024, max_nodes: 1 });
  assert.throws(
    () => parser.parse(codeDocument("export function broken( {")),
    (error: unknown) => error instanceof TypeScriptAstParserError && error.code === "SYNTAX_ERROR",
  );
  assert.throws(
    () => parser.parse(codeDocument("export const a = 1;\nexport const b = 2;")),
    (error: unknown) => error instanceof TypeScriptAstParserError && error.code === "AST_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parser.parse(codeDocument("x".repeat(1_025))),
    (error: unknown) => error instanceof TypeScriptAstParserError && error.code === "SOURCE_TOO_LARGE",
  );
});

test("TypeScript parser supports JavaScript and rejects unsupported MIME types", () => {
  const parser = new TypeScriptAstParser();
  assert.equal(parser.supports("Application/JavaScript"), true);
  assert.equal(parser.parse(codeDocument("export const value = 1;", "application/javascript")).language, "javascript");
  assert.throws(
    () => parser.parse(codeDocument("print('hello')", "text/x-python")),
    (error: unknown) => error instanceof TypeScriptAstParserError && error.code === "INVALID_CONFIGURATION",
  );
});
