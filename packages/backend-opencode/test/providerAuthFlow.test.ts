import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, ProviderAuthMethod, ProviderAuthorization } from "@polyth/contracts";
import { createHttpServer } from "../../server/src/http.ts";
import { createProviderAuthController } from "../src/providerAuth.ts";
import { providerAuthRoutes } from "../src/providerAuthRoutes.ts";
import { testTenancy } from "../../server/test/support/spaces.ts";

test("legacy OAuth routes are gone; attempt complete without an attempt is stale", async () => {
  let calls = 0;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      "github-copilot": [{ type: "oauth", label: "Sign in", upstreamIndex: 0 }],
    }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "auto",
      instructions: "Continue",
    }),
    providerAuthCallback: async () => { calls += 1; return true; },
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => {},
  });
  const tenancy = await testTenancy();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-auth-")),
    version: "test",
    routes: [providerAuthRoutes({ auth, runtime: async () => runtime })],
    visibility: {} as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  try {
    const legacy = await fetch(`http://127.0.0.1:${port}/api/providers/github-copilot/connect/oauth/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 0 }),
    });
    assert.equal(legacy.status, 404);
    assert.equal(calls, 0);

    const missing = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/missing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status >= 400, true);
    assert.equal(calls, 0);

    const caps = await (await fetch(`http://127.0.0.1:${port}/api/providers/auth-capabilities`)).json() as {
      providers: Record<string, { methods: Array<{ id: string }> }>;
    };
    const methodId = caps.providers["github-copilot"]?.methods[0]?.id;
    assert.ok(methodId);
    const authorize = await fetch(`http://127.0.0.1:${port}/api/providers/github-copilot/auth/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodId }),
    });
    assert.equal(authorize.status, 200);
    const started = await authorize.json() as { id?: string };
    assert.ok(started.id);

    const complete = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(complete.status, 200);

    const invalid = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "   " }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});
