import { createServer, type Server, type ServerResponse } from "node:http";

import { VerticalSliceRepository, type EvolutionTrace, type QuestLabDatabase } from "@firefly/persistence";
import type { Kysely } from "kysely";

export class AdminQueryService {
  private readonly repository: VerticalSliceRepository;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.repository = new VerticalSliceRepository(db);
  }

  async getEvolutionTrace(runId: string): Promise<EvolutionTrace | undefined> {
    return this.repository.getTrace(runId);
  }
}

export function createAdminApiServer(queryService: AdminQueryService): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      const match = request.method === "GET"
        ? /^\/admin\/evolution-runs\/([^/?]+)$/.exec(request.url ?? "")
        : null;
      if (!match) {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      const trace = await queryService.getEvolutionTrace(decodeURIComponent(match[1]!));
      if (!trace) {
        writeJson(response, 404, { error: "run_not_found" });
        return;
      }
      writeJson(response, 200, trace);
    } catch (error) {
      writeJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
