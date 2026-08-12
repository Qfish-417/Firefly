import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpIndexSourceParser,
  HttpIndexSourceParserError,
  ParserBackedIndexSourcePort,
  type IndexSourceDocument,
} from "../src/index.ts";

const document: IndexSourceDocument = {
  memory_id: "memory.parser.http",
  content: "Solar output changes with daylight.",
  source_type: "application/pdf",
  citation: {
    artifact_id: "artifact.parser.http",
    uri: "s3://parser-test/input.pdf",
    digest: `sha256:${"a".repeat(64)}`,
  },
};

test("HTTP parser posts an immutable document envelope and returns typed structure", async () => {
  let request: Request | undefined;
  const parser = new HttpIndexSourceParser({
    parser_id: "parser.pdf.unit",
    endpoint: "https://parser.test/v1/parse",
    source_types: ["application/pdf"],
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        schema_version: 1,
        structured: {
          kind: "pdf-layout",
          pages: [{ page: 1, blocks: [{ kind: "paragraph", text: document.content, region_id: "r-1" }] }],
        },
      });
    },
  });

  const structured = await parser.parse(document);

  assert.equal(structured.kind, "pdf-layout");
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  assert.equal((await request?.json()).document.memory_id, document.memory_id);
});

test("HTTP parser rejects insecure remote endpoints and forbidden header overrides", () => {
  assert.throws(
    () => new HttpIndexSourceParser({
      parser_id: "parser.invalid",
      endpoint: "http://parser.example/v1/parse",
      source_types: ["application/pdf"],
    }),
    (error: unknown) => error instanceof HttpIndexSourceParserError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () => new HttpIndexSourceParser({
      parser_id: "parser.invalid-header",
      endpoint: "https://parser.test/v1/parse",
      source_types: ["application/pdf"],
      headers: { host: "attacker.test" },
    }),
    (error: unknown) => error instanceof HttpIndexSourceParserError && error.code === "INVALID_CONFIGURATION",
  );
});

test("HTTP parser enforces response content type and byte limit", async () => {
  const invalidType = new HttpIndexSourceParser({
    parser_id: "parser.invalid-type",
    endpoint: "https://parser.test/v1/parse",
    source_types: ["application/pdf"],
    fetch: async () => new Response("not json", { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(
    invalidType.parse(document),
    (error: unknown) => error instanceof HttpIndexSourceParserError && error.code === "INVALID_RESPONSE",
  );

  const tooLarge = new HttpIndexSourceParser({
    parser_id: "parser.too-large",
    endpoint: "https://parser.test/v1/parse",
    source_types: ["application/pdf"],
    max_response_bytes: 1_024,
    fetch: async () => Response.json({ schema_version: 1, structured: { kind: "pdf-layout", pages: [] }, padding: "x".repeat(2_000) }),
  });
  await assert.rejects(
    tooLarge.parse(document),
    (error: unknown) => error instanceof HttpIndexSourceParserError && error.code === "RESPONSE_TOO_LARGE",
  );
});

test("parser-backed source port controls strict failure and explicit degradation", async () => {
  const source = { load: async () => [document] };
  const parser = new HttpIndexSourceParser({
    parser_id: "parser.failure",
    endpoint: "https://parser.test/v1/parse",
    source_types: ["application/pdf"],
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  const task = { schema_version: 1 } as never;

  await assert.rejects(
    new ParserBackedIndexSourcePort(source, { parsers: [parser] }).load(task),
    /SOURCE_PARSER_FAILED|parser-failed/u,
  );
  const degraded = await new ParserBackedIndexSourcePort(source, {
    parsers: [parser],
    parser_failure_mode: "degraded",
  }).load(task);
  assert.deepEqual(degraded[0]?.parser_diagnostic, { parser_id: parser.parser_id, code: "parser-failed" });
});
