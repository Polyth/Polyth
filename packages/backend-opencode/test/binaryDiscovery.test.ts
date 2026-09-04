// Regression cover for the failure this module exists to remove: a Polyth
// server started outside a login shell (desktop launcher, AppImage, systemd,
// launchd) inherits a PATH that does not list `~/.opencode/bin`, so a PATH-only
// lookup reported "OpenCode binary not found" and the UI showed an empty model
// catalog with "check that the backend is running" on a machine where
// `opencode` works fine in a terminal.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import {
  discoverOpenCodeBinary,
  mergeSearchPaths,
  openCodeChildSearchPath,
  probeLoginShellPath,
  resetLoginShellPathProbe,
  wellKnownOpenCodeDirectories,
} from "../src/binaryDiscovery.ts";
import {
  POLYTH_OPENCODE_BIN_ENV,
  resolveOpenCodeBinary,
} from "../src/runtimeStorage.ts";

const HERMETIC = { loginShellProbe: false } as const;

const workspace = async (t: { after(fn: () => unknown): void }): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const installBinary = async (directory: string, name = "opencode"): Promise<string> => {
  await mkdir(directory, { recursive: true });
  const binary = join(directory, name);
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o700);
  return binary;
};

test("an OpenCode installed off PATH is still found in its documented home", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const installed = await installBinary(join(home, ".opencode", "bin"));

  const report = await discoverOpenCodeBinary("opencode", {
    ...HERMETIC,
    env: { PATH: join(root, "empty-bin") },
    home,
  });

  assert.equal(report.hit?.executablePath, resolve(installed));
  assert.equal(report.hit?.stage, "well-known");
  assert.ok(
    report.searched.includes(join(root, "empty-bin", "opencode")),
    "the inherited PATH must still be searched first",
  );
});

test("the inherited PATH wins over a documented install location", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const onPath = await installBinary(join(root, "path-bin"));
  await installBinary(join(home, ".opencode", "bin"));

  const report = await discoverOpenCodeBinary("opencode", {
    ...HERMETIC,
    env: { PATH: join(root, "path-bin") },
    home,
  });

  assert.equal(report.hit?.executablePath, resolve(onPath));
  assert.equal(report.hit?.stage, "path");
});

test("a login shell's PATH is the last resort and is reported as such", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const shellDirectory = join(root, "shell-only-bin");
  const installed = await installBinary(shellDirectory);
  // A shell whose profile exports a PATH the server never inherited.
  const shell = join(root, "fake-login-shell");
  await writeFile(
    shell,
    `#!/bin/sh\nPATH=${shellDirectory}\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`,
  );
  await chmod(shell, 0o700);
  resetLoginShellPathProbe();
  t.after(() => resetLoginShellPathProbe());

  const report = await discoverOpenCodeBinary("opencode", {
    env: { PATH: join(root, "empty-bin"), SHELL: shell },
    home,
  });

  assert.equal(report.hit?.executablePath, resolve(installed));
  assert.equal(report.hit?.stage, "login-shell");
  assert.equal(report.loginShell, shell);
  assert.deepEqual(report.loginShellPath, [shellDirectory]);
});

test("a login shell that prints a banner does not corrupt the probed PATH", async (t) => {
  const root = await workspace(t);
  const shellDirectory = join(root, "shell-only-bin");
  await installBinary(shellDirectory);
  const shell = join(root, "chatty-login-shell");
  await writeFile(
    shell,
    "#!/bin/sh\n"
    + "echo 'Welcome to your shell!'\n"
    + `PATH=${shellDirectory}\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`,
  );
  await chmod(shell, 0o700);
  resetLoginShellPathProbe();
  t.after(() => resetLoginShellPathProbe());

  const probed = await probeLoginShellPath({ env: { SHELL: shell } });
  assert.deepEqual(probed?.entries, [shellDirectory]);
});

test("a total miss names every location it checked and how to fix it", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  await assert.rejects(
    () => resolveOpenCodeBinary({
      ...HERMETIC,
      env: { PATH: join(root, "empty-bin"), HOME: home },
    }),
    (error: Error & { code?: string; searched?: string[] }) => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /was not found/);
      assert.match(error.message, new RegExp(POLYTH_OPENCODE_BIN_ENV));
      assert.ok(
        error.searched?.includes(join(home, ".opencode", "bin", "opencode")),
        "the failure must carry the locations it checked",
      );
      return true;
    },
  );
});

test("a documented install location resolves through the public entry point", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const installed = await installBinary(join(home, ".bun", "bin"));

  assert.deepEqual(
    await resolveOpenCodeBinary({
      ...HERMETIC,
      env: { PATH: join(root, "empty-bin"), HOME: home },
    }),
    { executablePath: resolve(installed), binarySource: "well-known" },
  );
});

test("an explicit override never falls back to a discovered binary", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  await installBinary(join(home, ".opencode", "bin"));

  // Running a *different* OpenCode than the one that was configured is worse
  // than not starting: the override failure stays fatal.
  await assert.rejects(
    () => resolveOpenCodeBinary({
      ...HERMETIC,
      env: {
        PATH: "",
        HOME: home,
        [POLYTH_OPENCODE_BIN_ENV]: join(root, "missing-opencode"),
      },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, new RegExp(POLYTH_OPENCODE_BIN_ENV));
      return true;
    },
  );
});

test("a missing bundle degrades to an installed OpenCode instead of killing the app", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const installed = await installBinary(join(home, ".opencode", "bin"));

  const resolved = await resolveOpenCodeBinary({
    ...HERMETIC,
    bin: join(root, "resources", "opencode"), // never downloaded
    binarySource: "bundled",
    env: { PATH: join(root, "empty-bin"), HOME: home },
  });

  assert.equal(resolved.executablePath, resolve(installed));
  assert.equal(resolved.binarySource, "well-known");
  assert.match(resolved.diagnostic ?? "", /bundled OpenCode is missing/);
});

test("an intact bundle is still preferred over anything installed", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  const bundled = await installBinary(join(root, "resources"));
  await installBinary(join(home, ".opencode", "bin"));

  assert.deepEqual(
    await resolveOpenCodeBinary({
      ...HERMETIC,
      bin: bundled,
      binarySource: "bundled",
      env: { PATH: join(root, "empty-bin"), HOME: home },
    }),
    { executablePath: resolve(bundled), binarySource: "bundled" },
  );
});

test("a missing bundle with nothing installed reports both facts", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  await assert.rejects(
    () => resolveOpenCodeBinary({
      ...HERMETIC,
      bin: join(root, "resources", "opencode"),
      binarySource: "bundled",
      env: { PATH: join(root, "empty-bin"), HOME: home },
    }),
    (error: Error & { code?: string; searched?: string[] }) => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /bundled OpenCode is missing/);
      assert.match(error.message, /was not found/);
      assert.ok(error.searched?.length, "the search list survives the wrapper");
      return true;
    },
  );
});

test("an operator-configured path never degrades to a different binary", async (t) => {
  const root = await workspace(t);
  const home = join(root, "home");
  await installBinary(join(home, ".opencode", "bin"));

  await assert.rejects(
    () => resolveOpenCodeBinary({
      ...HERMETIC,
      bin: join(root, "chosen", "opencode"),
      binarySource: "configured",
      env: { PATH: join(root, "empty-bin"), HOME: home },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "unavailable");
      assert.doesNotMatch(error.message, /bundled/);
      return true;
    },
  );
});

test("well-known locations are ordered by how a user would expect them to win", () => {
  const directories = wellKnownOpenCodeDirectories({
    platform: "linux",
    home: "/home/tester",
    env: {},
  });
  assert.equal(directories[0], "/home/tester/.opencode/bin");
  assert.ok(directories.indexOf("/home/tester/.local/bin") < directories.indexOf("/usr/bin"));

  const windows = wellKnownOpenCodeDirectories({
    platform: "win32",
    home: "C:\\Users\\tester",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  });
  assert.ok(windows.some((entry) => entry.includes(".opencode")));
});

test("merging search paths keeps first occurrence and drops duplicates", () => {
  assert.deepEqual(
    mergeSearchPaths(`/a${delimiter}/b`, `/b${delimiter}/c`, ["/a", "", "/d"]),
    ["/a", "/b", "/c", "/d"],
  );
});

test("the child PATH is widened only when the CLI was found off PATH", async (t) => {
  const root = await workspace(t);
  const onPath = await installBinary(join(root, "path-bin"));
  const offPath = await installBinary(join(root, "elsewhere-bin"));
  const shell = join(root, "fake-login-shell");
  await writeFile(
    shell,
    `#!/bin/sh\nPATH=/shell/only\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`,
  );
  await chmod(shell, 0o700);
  resetLoginShellPathProbe();
  t.after(() => resetLoginShellPathProbe());

  const env = { PATH: join(root, "path-bin"), SHELL: shell };
  assert.equal(
    await openCodeChildSearchPath(onPath, { env }),
    join(root, "path-bin"),
    "a CLI already on PATH proves the process inherited the user's PATH",
  );
  assert.equal(
    await openCodeChildSearchPath(offPath, { env }),
    ["/shell/only", join(root, "path-bin"), join(root, "elsewhere-bin")].join(delimiter),
    "a CLI found off PATH proves it did not, so the child gets the shell's PATH",
  );
});
