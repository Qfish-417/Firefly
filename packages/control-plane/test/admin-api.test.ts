import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAdminApiServer, type AdminQueryPort } from "../src/index.ts";

test("Admin API exposes read-only Agent usage and per-run audit endpoints", async () => {
  const queries: AdminQueryPort = {
    async getAgentUsage() {
      return [{ agent_id: "learning-director", total_tokens: 42 }];
    },
    async getRunAudit(runId) {
      return runId === "run.api-unit"
        ? { run_id: runId, privacy: "metadata_and_digests_only" }
        : undefined;
    },
    async getEvolutionTrace() {
      return undefined;
    },
  };
  const server = createAdminApiServer(queries);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const agents = await fetch(`http://127.0.0.1:${port}/admin/audit/agents`);
    assert.equal(agents.status, 200);
    assert.deepEqual(await agents.json(), {
      agents: [{ agent_id: "learning-director", total_tokens: 42 }],
    });

    const run = await fetch(`http://127.0.0.1:${port}/admin/audit/runs/run.api-unit`);
    assert.equal(run.status, 200);
    assert.deepEqual(await run.json(), {
      run_id: "run.api-unit",
      privacy: "metadata_and_digests_only",
    });

    const missing = await fetch(`http://127.0.0.1:${port}/admin/audit/runs/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "run_not_found" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
