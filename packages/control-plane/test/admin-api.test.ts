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

const authorizedQueries: AdminQueryPort = {
  async getAgentUsage() {
    return [{ agent_id: "learning-director", total_tokens: 7 }];
  },
  async getRunAudit(runId) {
    return { run_id: runId, privacy: "metadata_and_digests_only" };
  },
  async getEvolutionTrace() {
    return undefined;
  },
};

async function withServer(
  options: Parameters<typeof createAdminApiServer>[1],
  body: (port: number) => Promise<void>,
  queries: AdminQueryPort = authorizedQueries,
): Promise<void> {
  const server = createAdminApiServer(queries, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await body((server.address() as AddressInfo).port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("a configured token gates every route except /health", async () => {
  const token = "admin-token-for-unit-tests";
  await withServer({ api_token: token }, async (port) => {
    const open = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { status: "ok", service: "admin" });

    for (const path of ["/admin/audit/agents", "/admin/audit/runs/run.auth-unit", "/admin/evolution-runs/run.auth-unit"]) {
      const anonymous = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(anonymous.status, 401, path);
      assert.deepEqual(await anonymous.json(), { error: "unauthorized" });
    }

    const wrong = await fetch(`http://127.0.0.1:${port}/admin/audit/agents`, {
      headers: { authorization: `Bearer ${token}x` },
    });
    assert.equal(wrong.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${port}/admin/audit/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);
  });
});

test("a short or empty token is refused at construction", () => {
  assert.throws(() => createAdminApiServer(authorizedQueries, { api_token: "too-short" }), /at least 16/u);
  assert.throws(() => createAdminApiServer(authorizedQueries, { api_token: "   " }), /at least 16/u);
});

test("malformed and out-of-contract run identifiers are client errors", async () => {
  await withServer({}, async (port) => {
    const malformed = await fetch(`http://127.0.0.1:${port}/admin/audit/runs/%ZZ`);
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_run_id" });

    const unsafe = await fetch(`http://127.0.0.1:${port}/admin/evolution-runs/${encodeURIComponent("../etc/passwd")}`);
    assert.equal(unsafe.status, 400);
  });
});

test("an internal failure returns a static body and leaks no query detail", async () => {
  const failing: AdminQueryPort = {
    async getAgentUsage() {
      throw new Error('select * from "questlab"."model_invocation" - password authentication failed');
    },
    async getRunAudit() {
      return undefined;
    },
    async getEvolutionTrace() {
      return undefined;
    },
  };
  await withServer({}, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/admin/audit/agents`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "internal_error" });
    assert.equal(text.includes("password"), false);
    assert.equal(text.includes("model_invocation"), false);
  }, failing);
});
