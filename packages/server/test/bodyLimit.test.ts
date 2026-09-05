// P1 hardening: readBody buffers at most MAX_BODY_BYTES. An oversized JSON
// body is drained (bounded memory, clean connection) and answered with the
// standard {error,message} shape as 413, and the same server keeps answering
// normal-size requests afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Project, ProjectService } from "@polyth/contracts";
import { createHttpServer, MAX_BODY_BYTES } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

test("bodies beyond MAX_BODY_BYTES answer 413; normal bodies unaffected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-bodylimit-"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [],
    get: async () => project,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const server = createHttpServer({
    sessions: {} as never,
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // valid JSON that lands just past the cap once the envelope is counted
    const oversized = `{"path":"${"x".repeat(MAX_BODY_BYTES)}"}`;
    const big = await fetch(`${base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: oversized,
    });
    assert.equal(big.status, 413);
    const body = await big.json() as { error: string; message: string };
    assert.equal(body.error, "payload-too-large");
    assert.match(body.message, /request body too large/);

    // the server is still healthy for well-behaved clients
    const ok = await fetch(`${base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(ok.status, 200);
    // The gateway serves projects through the Space-scoped registry, so the
    // row that comes back is the real one it created for this tenant.
    assert.equal((await ok.json() as { path: string }).path, dir);
  } finally {
    server.close();
  }
});
