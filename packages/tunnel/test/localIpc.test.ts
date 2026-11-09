import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { isWindowsPipePath, linkIpcPaths } from "../src/localIpc.ts";

test("Unix keeps both sockets inside the tunnel data directory", () => {
  assert.deepEqual(linkIpcPaths("/data/tunnel", "linux"), {
    control: join("/data/tunnel", "host.sock"),
    ingress: join("/data/tunnel", "ingress.sock"),
  });
});

test("Windows uses distinct per-start named pipes", () => {
  const paths = linkIpcPaths("C:\\data\\tunnel", "win32", "ab12");
  assert.equal(paths.control, "\\\\.\\pipe\\polyth-link-ab12-host");
  assert.equal(paths.ingress, "\\\\.\\pipe\\polyth-link-ab12-ingress");
  assert.ok(isWindowsPipePath(paths.control) && isWindowsPipePath(paths.ingress));
  const a = linkIpcPaths("x", "win32");
  const b = linkIpcPaths("x", "win32");
  assert.notEqual(a.control, b.control, "an unguessable name per start");
  assert.match(a.control, /^\\\\\.\\pipe\\polyth-link-[0-9a-f]{32}-host$/);
});

test("only pipe namespace paths count as pipes", () => {
  assert.equal(isWindowsPipePath("\\\\?\\pipe\\x"), true);
  assert.equal(isWindowsPipePath("C:\\pipe\\x"), false);
  assert.equal(isWindowsPipePath("/tmp/pipe/x"), false);
});
