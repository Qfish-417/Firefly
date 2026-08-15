import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { RetrievalGateway, RetrievalRequest } from "./index.ts";

export interface RetrievalApiOptions {
  readonly max_body_bytes?: number;
  readonly request_timeout_ms?: number;
  readonly authenticate?: (request: IncomingMessage) => Promise<boolean> | boolean;
}

/** Bounded HTTP/Agent-tool boundary around the governed RetrievalGateway. */
export function createRetrievalApiServer(
  gateway: RetrievalGateway,
  options: RetrievalApiOptions = {},
): Server {
  const maxBodyBytes = options.max_body_bytes ?? 256_000;
  const requestTimeoutMs = options.request_timeout_ms ?? 30_000;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 10_000_000) {
    throw new TypeError("max_body_bytes must be between 1024 and 10000000");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 300_000) {
    throw new TypeError("request_timeout_ms must be between 100 and 300000");
  }

  return createServer(async (request, response) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("retrieval request timed out")), requestTimeoutMs);
    request.on("aborted", () => controller.abort(new Error("client aborted retrieval request")));
    response.on("close", () => { if (!response.writableEnded) controller.abort(new Error("client closed retrieval response")); });
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { status: "ok", service: "retrieval" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/retrieval") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (options.authenticate && !(await options.authenticate(request))) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(request, maxBodyBytes, controller.signal);
      const parsed = parseRetrievalRequest(body);
      const pack = await gateway.retrieve(parsed, controller.signal);
      writeJson(response, 200, pack);
    } catch (error) {
      if (controller.signal.aborted) {
        writeJson(response, 408, { error: "request_timeout_or_canceled" });
      } else if (error instanceof RequestBodyError) {
        writeJson(response, error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error.code, message: error.message });
      } else if (error instanceof SyntaxError) {
        writeJson(response, 400, { error: "INVALID_REQUEST", message: error.message });
      } else {
        writeJson(response, 422, { error: "retrieval_rejected", message: error instanceof Error ? error.message : "Retrieval request rejected" });
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

class RequestBodyError extends Error {
  readonly code: "PAYLOAD_TOO_LARGE" | "INVALID_JSON";
  constructor(code: RequestBodyError["code"], message: string) { super(message); this.name = "RequestBodyError"; this.code = code; }
}

async function readJson(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyError("PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new RequestBodyError("PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit");
    chunks.push(bytes);
  }
  if (chunks.length === 0) throw new SyntaxError("Request body is required");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestBodyError("INVALID_JSON", "Request body must be valid JSON"); }
}

function parseRetrievalRequest(value: unknown): RetrievalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Retrieval request must be a JSON object");
  const item = value as Record<string, unknown>;
  const requiredStrings = ["query_id", "original_query", "purpose"] as const;
  for (const key of requiredStrings) if (typeof item[key] !== "string" || !item[key].trim()) throw new SyntaxError(`${key} must be a non-empty string`);
  if (!["fact_lookup", "count_events", "comparison", "multi_hop", "exploratory", "temporal", "multimodal"].includes(item.intent as string)) throw new SyntaxError("intent is invalid");
  if (!["learning-director", "learning-scientist", "experience-engineer"].includes(item.agent_id as string)) throw new SyntaxError("agent_id is invalid");
  if (!item.principal || typeof item.principal !== "object" || typeof (item.principal as Record<string, unknown>).tenant_id !== "string") throw new SyntaxError("principal.tenant_id is required");
  if (!Number.isInteger(item.token_budget) || (item.token_budget as number) <= 0 || !Number.isInteger(item.estimated_chunk_tokens) || (item.estimated_chunk_tokens as number) <= 0) throw new SyntaxError("token budgets must be positive integers");
  if (typeof item.require_citations !== "boolean") throw new SyntaxError("require_citations must be boolean");
  return item as unknown as RetrievalRequest;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
