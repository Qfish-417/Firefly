import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { VerticalSliceRepository, type EvolutionTrace, type QuestLabDatabase } from "@firefly/persistence";
import type { Kysely } from "kysely";

import { AuditAgent } from "./audit-agent.ts";

export class AdminQueryService {
  private readonly repository: VerticalSliceRepository;
  private readonly auditor: AuditAgent;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.repository = new VerticalSliceRepository(db);
    this.auditor = new AuditAgent(db);
  }

  async getRunAudit(runId: string) { return this.auditor.analyzeRun(runId); }
  async getAgentUsage() { return this.auditor.summarizeAgents(); }

  async getEvolutionTrace(runId: string): Promise<EvolutionTrace | undefined> {
    return this.repository.getTrace(runId);
  }
}

export interface AdminQueryPort {
  getRunAudit(runId: string): Promise<unknown | undefined>;
  getAgentUsage(): Promise<unknown>;
  getEvolutionTrace(runId: string): Promise<EvolutionTrace | undefined>;
}

export interface AdminApiOptions {
  /**
   * Bearer token required by every route except `/health`. Traces carry prompts, model spend and
   * learner identifiers, so an unauthenticated reader is a data-exposure boundary.
   */
  readonly api_token?: string;
  readonly request_timeout_ms?: number;
}

/** Run identifiers are `[A-Za-z0-9][A-Za-z0-9._:-]{2,79}` everywhere they are minted. */
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/u;

export function createAdminApiServer(
  queryService: AdminQueryPort,
  options: AdminApiOptions = {},
): Server {
  const requestTimeoutMs = options.request_timeout_ms ?? 30_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 300_000) {
    throw new TypeError("request_timeout_ms must be between 100 and 300000");
  }
  const expected = options.api_token?.trim();
  if (options.api_token !== undefined && (!expected || expected.length < 16)) {
    throw new TypeError("Admin API token must contain at least 16 characters");
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { status: "ok", service: "admin" });
        return;
      }
      if (expected && !authorized(request, expected)) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/admin/audit/agents") {
        writeJson(response, 200, { agents: await queryService.getAgentUsage() });
        return;
      }
      const auditMatch = request.method === "GET"
        ? /^\/admin\/audit\/runs\/([^/?]+)$/.exec(request.url ?? "")
        : null;
      if (auditMatch) {
        const runId = decodeRunId(auditMatch[1]!);
        if (!runId) {
          writeJson(response, 400, { error: "invalid_run_id" });
          return;
        }
        const report = await queryService.getRunAudit(runId);
        writeJson(response, report ? 200 : 404, report ?? { error: "run_not_found" });
        return;
      }
      const match = request.method === "GET"
        ? /^\/admin\/evolution-runs\/([^/?]+)$/.exec(request.url ?? "")
        : null;
      if (!match) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const runId = decodeRunId(match[1]!);
      if (!runId) {
        writeJson(response, 400, { error: "invalid_run_id" });
        return;
      }
      const trace = await queryService.getEvolutionTrace(runId);
      if (!trace) {
        writeJson(response, 404, { error: "run_not_found" });
        return;
      }
      writeJson(response, 200, trace);
    } catch (error) {
      // The message can carry SQL text and column values, so only the code crosses the boundary.
      process.stderr.write(`${JSON.stringify({
        type: "admin_api_error",
        url: request.url,
        message: error instanceof Error ? error.message : "Unknown error",
      })}\n`);
      writeJson(response, 500, { error: "internal_error" });
    }
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 20_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function decodeRunId(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return runIdPattern.test(decoded) ? decoded : undefined;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
