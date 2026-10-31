import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuthService } from "../src/auth.ts";
import { createHttpHandler, createInternalControlServer, createPublicHttpServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const get = (options: Parameters<typeof request>[0]): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

test("internal control socket works while the public API remains authenticated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-control-test-"));
  const tenancy = await testTenancy();
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
    auth: createAuthService({ file: join(dir, "auth.json"), envPassword: "test-only" }),
  });
  const socketPath = join(dir, "control.sock");
  const internal = createInternalControlServer(handler);
  const publicServer = createPublicHttpServer(handler);
  await Promise.all([
    new Promise<void>((resolve) => internal.listen(socketPath, resolve)),
    new Promise<void>((resolve) => publicServer.listen(0, "127.0.0.1", resolve)),
  ]);
  try {
    const port = (publicServer.address() as { port: number }).port;
    assert.equal((await get({ hostname: "127.0.0.1", port, path: "/api/projects" })).status, 401);
    const controlled = await get({ socketPath, path: "/api/projects" });
    assert.equal(controlled.status, 200);
    assert.deepEqual(JSON.parse(controlled.body), []);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => internal.close(() => resolve())),
      new Promise<void>((resolve) => publicServer.close(() => resolve())),
    ]);
  }
});
