// Package routes look projects up with the server's own rights, so naming a
// project or chat the person can't open has to stop before any of them runs:
// `/api/files/read?projectId=<someone's room>` once served that room's files.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RouteHandler } from "@polyth/contracts";
import { createHttpServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

test("a route never runs for a project the person can't open, wherever the id is", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-named-ids-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reached: string[] = [];
  const route: RouteHandler = async (rc) => {
    if (!rc.path.startsWith("/api/pkg")) return false;
    if (rc.method === "POST") await rc.body();
    reached.push(rc.path);
    rc.json(200, { ok: true });
    return true;
  };
  const closed = "project-of-someone-else";
  const gateway = {
    ...tenancy.gateway,
    services(ctx: never) {
      const services = tenancy.gateway.services(ctx);
      return {
        ...services,
        projects: {
          ...services.projects,
          get: async (id: string) => {
            if (id === closed) throw Object.assign(new Error("project not found"), { code: "not-found" });
            if (id === "broken") throw Object.assign(new Error("needs recovery"), { code: "recovery-required" });
            return services.projects.get(id);
          },
        },
      };
    },
  };
  const server = createHttpServer({
    sessions: {} as never, spaces: gateway as never, runtimes: {} as never,
    capabilities: () => [], webDist: dir, version: "test", routes: [route],
  });
  server.listen(0);
  await once(server, "listening");
  t.after(() => { server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const refused = [
    await fetch(`${base}/api/pkg/read?projectId=${closed}`),
    await fetch(`${base}/api/pkg/projects/${closed}/settings`),
    await fetch(`${base}/api/pkg/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: closed }) }),
  ];
  assert.deepEqual(refused.map((response) => response.status), [404, 404, 404]);
  assert.deepEqual(reached, [], "the package never saw any of them");

  const allowed = [
    await fetch(`${base}/api/pkg/read?projectId=unknown-project`),
    await fetch(`${base}/api/pkg/read?projectId=broken`),
    await fetch(`${base}/api/pkg/read`),
    await fetch(`${base}/api/pkg/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "unknown-project" }) }),
  ];
  assert.deepEqual(allowed.map((response) => response.status), [200, 200, 200, 200], "an unknown id is the handler's to report");
  assert.equal(reached.length, 4);
});
