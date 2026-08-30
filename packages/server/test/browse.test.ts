import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "../src/http.ts";
import { browseRoutes } from "../src/routes/browse.ts";

test("host browsing lists the server host for non-local clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-server-browse-"));
  mkdirSync(join(root, "project"));
  let status = 0;
  let payload: unknown;
  const request = {
    req: { socket: { remoteAddress: "192.0.2.10" } },
    res: {},
    url: new URL(`/api/browse?path=${encodeURIComponent(root)}`, "http://polyth"),
    path: "/api/browse",
    method: "GET",
    body: async () => ({}),
    json: (code: number, body: unknown) => { status = code; payload = body; },
  } as unknown as RouteRequest;

  assert.equal(await browseRoutes()(request), true);
  assert.equal(status, 200);
  assert.deepEqual((payload as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name), ["project"]);
});
