import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import {
  discoverHarnessExecutable,
  harnessExecutableChildEnv,
  mergeHarnessSearchPaths,
} from "../src/executableDiscovery.ts";

const fixture = async (root: string, directory: string, name: string) => {
  const folder = join(root, directory);
  await mkdir(folder, { recursive: true });
  const executable = join(folder, process.platform === "win32" ? `${name}.CMD` : name);
  await writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  return executable;
};

test("discovers a harness inherited from the desktop process PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, "bin", "polyth-test-agent");
  const binDir = join(root, "bin");

  const report = await discoverHarnessExecutable("polyth-test-agent", {
    env: {
      PATH: binDir,
      ...(process.platform === "win32" ? { PATHEXT: ".EXE;.CMD" } : {}),
    },
    home: root,
    loginShellProbe: false,
  });

  assert.equal(report.hit?.stage, "path");
  assert.equal(report.hit?.executablePath, executable);
});

test("desktop discovery checks documented user install locations beyond inherited PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, join(".local", "bin"), "polyth-test-agent");

  const report = await discoverHarnessExecutable("polyth-test-agent", {
    env: {
      PATH: "",
      HOME: root,
      USERPROFILE: root,
      ...(process.platform === "win32" ? { PATHEXT: ".EXE;.CMD" } : {}),
    },
    home: root,
    loginShellProbe: false,
  });

  assert.equal(report.hit?.stage, "well-known");
  assert.equal(report.hit?.executablePath, executable);
});

test("Windows discovery honors PATHEXT command shims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-win-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, "npm");
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "polyth-test-agent.CMD");
  await writeFile(shim, "@echo off\r\n", "utf8");

  const report = await discoverHarnessExecutable("polyth-test-agent", {
    platform: "win32",
    env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
    home: root,
    loginShellProbe: false,
  });

  assert.equal(report.hit?.stage, "path");
  assert.equal(report.hit?.executablePath, shim);
});

test("child environment pins the exact discovered CLI directory first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, "resolved", "polyth-test-agent");
  const inherited = join(root, "inherited");
  await mkdir(inherited, { recursive: true });

  const env = await harnessExecutableChildEnv(executable, {
    env: { PATH: inherited },
    loginShellProbe: false,
  });

  assert.equal(env.PATH?.split(delimiter)[0], dirname(executable));
  assert.equal(env.PATH?.split(delimiter)[1], inherited);
});

test("search path merge is stable and removes duplicates", () => {
  assert.deepEqual(
    mergeHarnessSearchPaths(["/one", "/two", "/one"], `/two${delimiter}/three`),
    ["/one", "/two", "/three"],
  );
});
