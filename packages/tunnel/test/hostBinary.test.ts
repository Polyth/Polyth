import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  hostExecutableName,
  resolveHostBinary,
} from "../src/hostBinary.ts";

test("POLYTH_LINK_HOST wins when the override file exists", () => {
  const override = "/opt/polyth/polyth-link-host";
  const resolved = resolveHostBinary({
    platform: "linux",
    env: { POLYTH_LINK_HOST: override },
    exists: (path) => path === override,
    resourcesDir: "/resources",
    repoRoot: "/repo",
  });
  assert.deepEqual(resolved, { ok: true, path: override, source: "env" });
});

test("packaged desktop builds resolve the host from resources", () => {
  const packaged = join("/app/resources", "polyth-link", "polyth-link-host");
  const resolved = resolveHostBinary({
    platform: "linux",
    env: {},
    resourcesDir: "/app/resources",
    repoRoot: "/repo",
    exists: (path) => path === packaged,
  });
  assert.deepEqual(resolved, { ok: true, path: packaged, source: "packaged" });
});

test("dev builds prefer release then debug binaries", () => {
  const release = join("/repo", "target", "release", "polyth-link-host");
  const debug = join("/repo", "target", "debug", "polyth-link-host");
  assert.deepEqual(resolveHostBinary({
    platform: "darwin",
    env: {},
    repoRoot: "/repo",
    exists: (path) => path === release || path === debug,
  }), { ok: true, path: release, source: "dev-release" });
  assert.deepEqual(resolveHostBinary({
    platform: "linux",
    env: {},
    repoRoot: "/repo",
    exists: (path) => path === debug,
  }), { ok: true, path: debug, source: "dev-debug" });
});

test("Windows resolves the .exe host and never a Unix binary", () => {
  const unix = join("/repo", "target", "release", "polyth-link-host");
  const exe = join("/repo", "target", "release", "polyth-link-host.exe");
  const resolved = resolveHostBinary({
    platform: "win32",
    env: {},
    repoRoot: "/repo",
    exists: (path) => path === unix || path === exe,
  });
  assert.deepEqual(resolved, { ok: true, path: exe, source: "dev-release" });
  assert.equal(hostExecutableName("win32"), "polyth-link-host.exe");
});

test("Windows packaged builds use the bundled .exe", () => {
  const packaged = join("/resources", "polyth-link", "polyth-link-host.exe");
  assert.deepEqual(resolveHostBinary({
    platform: "win32",
    env: {},
    repoRoot: "/repo",
    resourcesDir: "/resources",
    exists: (path) => path === packaged,
  }), { ok: true, path: packaged, source: "packaged" });
});

test("Windows honours POLYTH_LINK_HOST", () => {
  const override = "C:\\polyth\\polyth-link-host.exe";
  const resolved = resolveHostBinary({
    platform: "win32",
    env: { POLYTH_LINK_HOST: override },
    exists: (path) => path === override,
    repoRoot: "/repo",
  });
  assert.deepEqual(resolved, { ok: true, path: override, source: "env" });
});

test("missing host binary is reported as missing, not ready", () => {
  const resolved = resolveHostBinary({
    platform: "linux",
    env: {},
    repoRoot: "/repo",
    resourcesDir: "/resources",
    exists: () => false,
  });
  assert.deepEqual(resolved, { ok: false, reason: "missing" });
});
