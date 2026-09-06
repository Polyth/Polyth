import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime } from "@polyth/contracts";
import { createHttpServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

test("provider OAuth callback accepts auto flows without a code", async () => {
  const calls: Array<{ providerID: string; method: number; code?: string }> = [];
  const runtime = {
    providerAuthCallback: async (providerID: string, method: number, code?: string) => {
      calls.push({ providerID, method, ...(code ? { code } : {}) });
      return true;
    },
  } as AgentRuntime;
  const tenancy = await testTenancy();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-auth-")),
    version: "test",
    visibility: {} as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  try {
    const url = `http://127.0.0.1:${port}/api/providers/github-copilot/connect/oauth/callback`;
    const auto = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 1 }),
    });
    assert.equal(auto.status, 200);

    const code = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 2, code: " pasted-code " }),
    });
    assert.equal(code.status, 200);

    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 3, code: "   " }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(calls, [
      { providerID: "github-copilot", method: 1 },
      { providerID: "github-copilot", method: 2, code: "pasted-code" },
    ]);
  } finally {
    server.close();
  }
});
