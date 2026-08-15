import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { RetrievalGateway, RetrievalPrincipal, RetrievalRequest } from "./index.ts";

export interface RetrievalApiOptions {
  readonly max_body_bytes?: number;
  readonly request_timeout_ms?: number;
  readonly authenticate?: (request: IncomingMessage) => Promise<boolean> | boolean;
  readonly resolve_identity?: (request: IncomingMessage) => Promise<TrustedRetrievalIdentity | undefined> | TrustedRetrievalIdentity | undefined;
}

export interface TrustedRetrievalIdentity {
  readonly principal: RetrievalPrincipal;
  readonly agent_id: RetrievalRequest["agent_id"];
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
      const parsed = parseRetrievalRequest(body, Boolean(options.resolve_identity));
      const trusted = await options.resolve_identity?.(request);
      if (options.resolve_identity && !trusted) {
        writeJson(response, 401, { error: "untrusted_identity" });
        return;
      }
      const governedRequest: RetrievalRequest = trusted
        ? { ...parsed, principal: trusted.principal, agent_id: trusted.agent_id }
        : parsed;
      const pack = await gateway.retrieve(governedRequest, controller.signal);
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

export function createHmacRetrievalIdentityResolver(
  secret: string,
  options: { readonly max_clock_skew_ms?: number; readonly now?: () => number } = {},
): (request: IncomingMessage) => TrustedRetrievalIdentity | undefined {
  if (secret.length < 32) throw new TypeError("Retrieval identity HMAC secret must contain at least 32 characters");
  const maxClockSkew = options.max_clock_skew_ms ?? 30_000;
  const now = options.now ?? Date.now;
  return (request) => {
    const encoded = singleHeader(request.headers["x-firefly-identity"]);
    const signature = singleHeader(request.headers["x-firefly-signature"]);
    if (!encoded || !signature || !/^[a-f0-9]{64}$/u.test(signature)) return undefined;
    const expected = createHmac("sha256", secret).update(encoded, "utf8").digest();
    const supplied = Buffer.from(signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    let claims: unknown;
    try { claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return undefined; }
    if (!validIdentityClaims(claims)) return undefined;
    const instant = now();
    if (claims.issued_at_ms > instant + maxClockSkew || claims.expires_at_ms < instant - maxClockSkew) return undefined;
    return { principal: claims.principal, agent_id: claims.agent_id };
  };
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

function parseRetrievalRequest(value: unknown, identityResolverConfigured = false): RetrievalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Retrieval request must be a JSON object");
  const item = value as Record<string, unknown>;
  const requiredStrings = ["query_id", "original_query", "purpose"] as const;
  for (const key of requiredStrings) if (typeof item[key] !== "string" || !item[key].trim()) throw new SyntaxError(`${key} must be a non-empty string`);
  if (!["fact_lookup", "count_events", "comparison", "multi_hop", "exploratory", "temporal", "multimodal"].includes(item.intent as string)) throw new SyntaxError("intent is invalid");
  if (!["learning-director", "learning-scientist", "experience-engineer"].includes(item.agent_id as string)) throw new SyntaxError("agent_id is invalid");
  if (!identityResolverConfigured && (!item.principal || typeof item.principal !== "object" || typeof (item.principal as Record<string, unknown>).tenant_id !== "string")) throw new SyntaxError("principal.tenant_id is required");
  if (!Number.isInteger(item.token_budget) || (item.token_budget as number) <= 0 || !Number.isInteger(item.estimated_chunk_tokens) || (item.estimated_chunk_tokens as number) <= 0) throw new SyntaxError("token budgets must be positive integers");
  if (typeof item.require_citations !== "boolean") throw new SyntaxError("require_citations must be boolean");
  return item as unknown as RetrievalRequest;
}

function validIdentityClaims(value: unknown): value is TrustedRetrievalIdentity & { readonly issued_at_ms: number; readonly expires_at_ms: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const principal = item.principal as Record<string, unknown> | undefined;
  return Boolean(
    principal && typeof principal.tenant_id === "string" && principal.tenant_id.trim() &&
    ["learning-director", "learning-scientist", "experience-engineer"].includes(item.agent_id as string) &&
    Number.isSafeInteger(item.issued_at_ms) && Number.isSafeInteger(item.expires_at_ms) &&
    (item.expires_at_ms as number) > (item.issued_at_ms as number) &&
    (item.expires_at_ms as number) - (item.issued_at_ms as number) <= 300_000
  );
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
