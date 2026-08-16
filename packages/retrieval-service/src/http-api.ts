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

const agentIds = ["learning-director", "learning-scientist", "experience-engineer"] as const;
const structuredFilterKeys = new Set(["subject_id", "event_type", "from", "to", "include_conflicts"]);

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
  if (!agentIds.includes(item.agent_id as typeof agentIds[number])) throw new SyntaxError("agent_id is invalid");
  if (!identityResolverConfigured && !validPrincipal(item.principal, item.agent_id as RetrievalRequest["agent_id"])) throw new SyntaxError("principal is invalid");
  if (!Number.isInteger(item.token_budget) || (item.token_budget as number) <= 0 || !Number.isInteger(item.estimated_chunk_tokens) || (item.estimated_chunk_tokens as number) <= 0) throw new SyntaxError("token budgets must be positive integers");
  if (typeof item.require_citations !== "boolean") throw new SyntaxError("require_citations must be boolean");
  validateStructuredFilters(item.structured_filters, item.intent as RetrievalRequest["intent"]);
  validateStructuredQuery(item.structured_query, item.intent as RetrievalRequest["intent"]);
  return item as unknown as RetrievalRequest;
}

function validIdentityClaims(value: unknown): value is TrustedRetrievalIdentity & { readonly issued_at_ms: number; readonly expires_at_ms: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const principal = item.principal as Record<string, unknown> | undefined;
  return Boolean(
    validPrincipal(principal, item.agent_id as RetrievalRequest["agent_id"]) &&
    agentIds.includes(item.agent_id as typeof agentIds[number]) &&
    Number.isSafeInteger(item.issued_at_ms) && Number.isSafeInteger(item.expires_at_ms) &&
    (item.expires_at_ms as number) > (item.issued_at_ms as number) &&
    (item.expires_at_ms as number) - (item.issued_at_ms as number) <= 300_000
  );
}

function validPrincipal(value: unknown, expectedAgent?: RetrievalRequest["agent_id"]): value is RetrievalPrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  if (!validIdentifier(principal.tenant_id)) return false;
  for (const key of ["user_id", "agent_id", "session_id"] as const) {
    if (principal[key] !== undefined && !validIdentifier(principal[key])) return false;
  }
  if (principal.agent_id !== undefined && !agentIds.includes(principal.agent_id as typeof agentIds[number])) return false;
  if (expectedAgent && principal.agent_id !== undefined && principal.agent_id !== expectedAgent) return false;
  if (principal.role_ids !== undefined) {
    if (!Array.isArray(principal.role_ids) || principal.role_ids.length > 64) return false;
    if (new Set(principal.role_ids).size !== principal.role_ids.length || principal.role_ids.some((role) => !validIdentifier(role))) return false;
  }
  return true;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function validateStructuredFilters(value: unknown, intent: RetrievalRequest["intent"]): void {
  if (value === undefined) {
    if (intent === "count_events") throw new SyntaxError("count_events requires structured_filters");
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("structured_filters must be an object");
  const filters = value as Record<string, unknown>;
  if (Object.keys(filters).some((key) => !structuredFilterKeys.has(key))) throw new SyntaxError("structured_filters contains an unknown field");
  for (const key of ["subject_id", "event_type", "from", "to"] as const) {
    if (filters[key] !== undefined && !validIdentifier(filters[key])) throw new SyntaxError(`structured_filters.${key} must be a non-empty string`);
  }
  if (filters.include_conflicts !== undefined && typeof filters.include_conflicts !== "boolean") {
    throw new SyntaxError("structured_filters.include_conflicts must be boolean");
  }
  const from = filters.from === undefined ? undefined : new Date(filters.from as string);
  const to = filters.to === undefined ? undefined : new Date(filters.to as string);
  if (from && !Number.isFinite(from.getTime())) throw new SyntaxError("structured_filters.from must be an ISO timestamp");
  if (to && !Number.isFinite(to.getTime())) throw new SyntaxError("structured_filters.to must be an ISO timestamp");
  if (from && to && from.getTime() > to.getTime()) throw new SyntaxError("structured_filters.from must not be after to");
  if (intent === "count_events" && (!validIdentifier(filters.subject_id) || !validIdentifier(filters.event_type))) {
    throw new SyntaxError("count_events requires structured_filters.subject_id and event_type");
  }
}

function validateStructuredQuery(value: unknown, intent: RetrievalRequest["intent"]): void {
  if (value === undefined) {
    if (intent === "comparison" || intent === "temporal" || intent === "multi_hop") throw new SyntaxError(`${intent} requires structured_query`);
    return;
  }
  if (intent !== "comparison" && intent !== "temporal" && intent !== "multi_hop") throw new SyntaxError("structured_query is not supported for this intent");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("structured_query must be an object");
  const query = value as Record<string, unknown>;
  if (intent === "multi_hop") {
    const allowed = new Set(["kind", "start_node_id", "target_node_id", "predicates", "direction", "max_hops", "as_of", "include_conflicts"]);
    if (Object.keys(query).some((key) => !allowed.has(key)) || query.kind !== "find_relation_path") {
      throw new SyntaxError("structured_query kind or fields do not match multi_hop intent");
    }
    if (!validIdentifier(query.start_node_id) || !validIdentifier(query.target_node_id) || query.start_node_id === query.target_node_id) {
      throw new SyntaxError("multi_hop requires two different node IDs");
    }
    if (query.direction !== "outbound" && query.direction !== "inbound" && query.direction !== "both") throw new SyntaxError("multi_hop direction is invalid");
    if (!Number.isInteger(query.max_hops) || (query.max_hops as number) < 1 || (query.max_hops as number) > 6) throw new SyntaxError("multi_hop max_hops must be between 1 and 6");
    if (!validIdentifier(query.as_of) || !Number.isFinite(new Date(query.as_of).getTime())) throw new SyntaxError("multi_hop as_of must be an ISO timestamp");
    if (query.predicates !== undefined) {
      if (!Array.isArray(query.predicates) || query.predicates.length < 1 || query.predicates.length > 32 ||
        new Set(query.predicates).size !== query.predicates.length || query.predicates.some((predicate) => !validIdentifier(predicate))) {
        throw new SyntaxError("multi_hop predicates must be 1-32 unique identifiers");
      }
    }
    if (query.include_conflicts !== undefined && typeof query.include_conflicts !== "boolean") throw new SyntaxError("structured_query.include_conflicts must be boolean");
    return;
  }
  const commonKeys = ["kind", "event_type", "from", "to", "include_conflicts"];
  const expectedKind = intent === "comparison" ? "compare_event_counts" : "select_event_time";
  const intentKeys = intent === "comparison"
    ? ["left_subject_id", "right_subject_id"]
    : ["subject_id", "selector"];
  const allowed = new Set([...commonKeys, ...intentKeys]);
  if (Object.keys(query).some((key) => !allowed.has(key)) || query.kind !== expectedKind) {
    throw new SyntaxError("structured_query kind or fields do not match intent");
  }
  if (!validIdentifier(query.event_type)) throw new SyntaxError("structured_query.event_type must be a non-empty string");
  for (const key of ["from", "to"] as const) {
    if (query[key] !== undefined && !validIdentifier(query[key])) throw new SyntaxError(`structured_query.${key} must be a non-empty string`);
  }
  if (query.include_conflicts !== undefined && typeof query.include_conflicts !== "boolean") {
    throw new SyntaxError("structured_query.include_conflicts must be boolean");
  }
  validateTimeRange(query.from, query.to, "structured_query");
  if (intent === "comparison") {
    if (!validIdentifier(query.left_subject_id) || !validIdentifier(query.right_subject_id) || query.left_subject_id === query.right_subject_id) {
      throw new SyntaxError("comparison requires two different subject IDs");
    }
  } else if (!validIdentifier(query.subject_id) || (query.selector !== "first" && query.selector !== "last")) {
    throw new SyntaxError("temporal query requires subject_id and first/last selector");
  }
}

function validateTimeRange(fromValue: unknown, toValue: unknown, prefix: string): void {
  const from = fromValue === undefined ? undefined : new Date(fromValue as string);
  const to = toValue === undefined ? undefined : new Date(toValue as string);
  if (from && !Number.isFinite(from.getTime())) throw new SyntaxError(`${prefix}.from must be an ISO timestamp`);
  if (to && !Number.isFinite(to.getTime())) throw new SyntaxError(`${prefix}.to must be an ISO timestamp`);
  if (from && to && from.getTime() > to.getTime()) throw new SyntaxError(`${prefix}.from must not be after to`);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
