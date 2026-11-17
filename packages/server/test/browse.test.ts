import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "../src/http.ts";
import { browseRoutes } from "../src/routes/browse.ts";
import { fakeSpaceContext } from "./support/spaces.ts";

test("host browsing lists the server host for non-local clients", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-server-browse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "project"));
  let status = 0;
  let payload: unknown;
  const request = {
    req: { socket: { remoteAddress: "192.0.2.10" } },
    res: {},
    url: new URL(`/api/browse?path=${encodeURIComponent(root)}`, "http://polyth"),
    path: "/api/browse",
    method: "GET",
    space: fakeSpaceContext(),
    body: async () => ({}),
    json: (code: number, body: unknown) => { status = code; payload = body; },
  } as unknown as RouteRequest;

  assert.equal(await browseRoutes(join(root, "polyth-data"))(request), true);
  assert.equal(status, 200);
  assert.deepEqual((payload as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name), ["project"]);
});

test("host browsing does not exist in a hosted multi-tenant deployment", async () => {
  const request = {
    req: { socket: { remoteAddress: "192.0.2.10" } },
    res: {},
    url: new URL("/api/browse?path=/", "http://polyth"),
    path: "/api/browse",
    method: "GET",
    space: fakeSpaceContext({ deployment: "multi-tenant-sandboxed" }),
    body: async () => ({}),
    json: () => {},
  } as unknown as RouteRequest;
  await assert.rejects(
    () => browseRoutes("/nowhere")(request),
    (error: { code?: string }) => error.code === "unsupported",
  );
});

test("the picker reads as if the server's data folder weren't there", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-browse-sealed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "polyth-data");
  mkdirSync(join(data, "spaces"), { recursive: true });
  mkdirSync(join(root, "project"));
  const browse = async (target: string) => {
    let payload: unknown;
    await browseRoutes(data)({
      url: new URL(`/api/browse?path=${encodeURIComponent(target)}`, "http://polyth"),
      path: "/api/browse",
      method: "GET",
      space: fakeSpaceContext(),
      body: async () => ({}),
      json: (_code: number, body: unknown) => { payload = body; },
    } as unknown as RouteRequest);
    return payload as { entries: Array<{ name: string }> };
  };
  assert.deepEqual((await browse(root)).entries.map((entry) => entry.name), ["project"]);
  await assert.rejects(browse(data), { code: "not-found" });
  await assert.rejects(browse(join(data, "spaces")), { code: "not-found" });
});

test("a pasted path is looked up as a file or folder; refused paths read as absent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-browse-stat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "polyth-data");
  mkdirSync(join(data, "spaces"), { recursive: true });
  writeFileSync(join(data, "spaces", "secret.txt"), "private");
  mkdirSync(join(root, "Downloads"));
  writeFileSync(join(root, "Downloads", "bundle.zip"), "12345");
  symlinkSync(join(data, "spaces"), join(root, "into-data"));
  const lookup = async (target: string, deployment?: "multi-tenant-sandboxed") => {
    let status = 0;
    let payload: unknown;
    await browseRoutes(data)({
      url: new URL(`/api/browse/stat?path=${encodeURIComponent(target)}`, "http://polyth"),
      path: "/api/browse/stat",
      method: "GET",
      space: fakeSpaceContext(deployment ? { deployment } : {}),
      body: async () => ({}),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as unknown as RouteRequest);
    assert.equal(status, 200);
    return payload;
  };
  assert.deepEqual(await lookup(join(root, "Downloads", "bundle.zip")), {
    path: join(root, "Downloads", "bundle.zip"), name: "bundle.zip", kind: "file", size: 5,
  });
  assert.deepEqual(await lookup(join(root, "Downloads")), {
    path: join(root, "Downloads"), name: "Downloads", kind: "dir", size: 0,
  });
  assert.equal(await lookup(join(root, "Downloads", "missing.zip")), null);
  assert.equal(await lookup("relative/bundle.zip"), null);
  assert.equal(await lookup(""), null);
  assert.equal(await lookup("/proc/self/environ"), null);
  // The server's own data, directly or through a link, reads like a missing path.
  assert.equal(await lookup(join(data, "spaces", "secret.txt")), null);
  assert.equal(await lookup(join(root, "into-data", "secret.txt")), null);
  await assert.rejects(lookup(join(root, "Downloads", "bundle.zip"), "multi-tenant-sandboxed"), { code: "unsupported" });
});
