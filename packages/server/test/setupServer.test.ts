import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PasswordService } from "@polyth/identity";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { createSetupServer } from "../src/setupServer.ts";

const passwords = (): PasswordService => ({
  async hash(value) { return `test-only:${value}`; },
  async verify(value, encoded) { return { valid: encoded === `test-only:${value}`, needsRehash: false }; },
  close() {},
});

async function reservePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("setup-only server exposes health/auth/static and no application runtime", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-setup-server-"));
  const dataDir = join(root, "data"), webDist = join(root, "web");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(webDist, { mode: 0o700 });
  writeFileSync(join(webDist, "index.html"), "<html>setup shell</html>");
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const security = createCanonicalSecurity({ dataDir, origin, localOnly: true, passwords: passwords() });
  const setup = createSetupServer({ security, webDist, version: "test" });
  t.after(async () => {
    await setup.shutdown();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  setup.server.listen(port, "127.0.0.1");
  await once(setup.server, "listening");

  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true, version: "test", setup: true, state: "uninitialized", capabilities: [],
  });

  const auth = await fetch(`${origin}/api/auth/status`);
  assert.equal(auth.status, 200);
  assert.equal(auth.headers.get("x-polyth-bootstrap"), "setup");
  const status = await auth.json() as { state: string; authorized: boolean };
  assert.equal(status.state, "uninitialized");
  assert.equal(status.authorized, false);

  const privateApi = await fetch(`${origin}/api/projects`);
  assert.equal(privateApi.status, 503);
  assert.deepEqual(await privateApi.json(), { error: "setup-required" });

  const shell = await fetch(`${origin}/anything`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /setup shell/);

  for (const file of ["auth.json", "tenancy.json", "projects.json", "sessions.db", "packages.json"]) {
    assert.equal(existsSync(join(dataDir, file)), false, `${file} must not exist before canonical setup completes`);
  }
  assert.equal(existsSync(join(dataDir, "control-plane", "control.sqlite")), true);
});
