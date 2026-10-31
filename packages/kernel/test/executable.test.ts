import test from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { resolveExecutable, resolvedExecutableDirectory, wellKnownExecutableDirectories } from "../src/executable.ts";

// Expectations are built with the *target* platform's helpers: the resolver is
// asked to simulate darwin/linux/win32 lookups, which must not depend on the
// host that happens to be running this test.
const only = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

test("an explicit binary wins over the environment and discovery", () => {
  assert.equal(
    resolveExecutable("git", {
      explicit: "  /opt/custom/git  ",
      overrideEnv: "POLYTH_GIT_BIN",
      env: { POLYTH_GIT_BIN: "/env/git", PATH: "/usr/bin" },
      isFile: () => true,
    }),
    "/opt/custom/git",
  );
});

test("the documented override environment variable wins over PATH", () => {
  assert.equal(
    resolveExecutable("git", { overrideEnv: "POLYTH_GIT_BIN", env: { POLYTH_GIT_BIN: "/env/git", PATH: "/usr/bin" }, isFile: () => true }),
    "/env/git",
  );
});

test("an absolute name is taken exactly", () => {
  assert.equal(resolveExecutable("/opt/bin/gh", { env: { PATH: "/nothing" }, isFile: () => false }), "/opt/bin/gh");
});

test("a tool on PATH resolves to its absolute path", () => {
  const dir = posix.join("/custom", "bin");
  const found = resolveExecutable("gh", {
    platform: "linux",
    env: { PATH: `${posix.join("/nope")}${posix.delimiter}${dir}` },
    isFile: only(posix.join(dir, "gh")),
  });
  assert.equal(found, posix.join(dir, "gh"));
});

test("Windows resolves a tool through PATHEXT", () => {
  const dir = "C:\\tools";
  const found = resolveExecutable("gh", {
    platform: "win32",
    env: { PATH: dir, PATHEXT: ".EXE;.CMD" },
    isFile: only(win32.join(dir, "gh.cmd")),
  });
  assert.equal(found, win32.join(dir, "gh.cmd"));
});

test("a shared install directory is searched after PATH", () => {
  const home = posix.join("/home", "dev");
  const found = resolveExecutable("ssh", {
    platform: "linux",
    home,
    env: { HOME: home, PATH: "/nothing" },
    isFile: only(posix.join(home, ".local", "bin", "ssh")),
  });
  assert.equal(found, posix.join(home, ".local", "bin", "ssh"));
});

test("the GitHub CLI is found in its Windows vendor directory", () => {
  const programFiles = win32.join("C:", "Program Files");
  const gh = win32.join(programFiles, "GitHub CLI", "gh.exe");
  const found = resolveExecutable("gh", {
    platform: "win32",
    env: { PATH: "C:\\Windows", ProgramFiles: programFiles },
    isFile: only(gh),
  });
  assert.equal(found, gh);
});

test("the GitLab CLI is found in its Windows vendor directory", () => {
  const programFiles = win32.join("C:", "Program Files");
  const glab = win32.join(programFiles, "glab", "glab.exe");
  const found = resolveExecutable("glab", {
    platform: "win32",
    env: { PATH: "C:\\Windows", ProgramFiles: programFiles },
    isFile: only(glab),
  });
  assert.equal(found, glab);
});

test("Windows OpenSSH is found outside PATH", () => {
  const systemRoot = "C:\\Windows";
  const ssh = win32.join(systemRoot, "System32", "OpenSSH", "ssh.exe");
  const found = resolveExecutable("ssh", {
    platform: "win32",
    env: { PATH: "C:\\Windows", SystemRoot: systemRoot },
    isFile: only(ssh),
  });
  assert.equal(found, ssh);
});

test("Windows git prefers a standard install over the GitHub Desktop bundle", () => {
  const local = win32.join("C:", "Users", "dev", "AppData", "Local");
  const programFiles = win32.join("C:", "Program Files");
  const standard = win32.join(programFiles, "Git", "cmd", "git.exe");
  const bundled = win32.join(local, "GitHubDesktop", "app-9.9.9", "resources", "app", "git", "cmd", "git.exe");
  const found = resolveExecutable("git", {
    platform: "win32",
    env: { PATH: "C:\\Windows", ProgramFiles: programFiles, LOCALAPPDATA: local },
    isFile: only(standard, bundled),
    listDir: (path) => path === win32.join(local, "GitHubDesktop") ? ["app-9.9.9"] : [],
  });
  assert.equal(found, standard);
});

test("extra directories are searched before the well-known locations", () => {
  const vendor = posix.join("/opt", "tool", "bin");
  const found = resolveExecutable("tool", {
    platform: "linux",
    extraDirectories: [vendor],
    env: { PATH: "/nothing" },
    isFile: only(posix.join(vendor, "tool")),
  });
  assert.equal(found, posix.join(vendor, "tool"));
});

test("an unreadable vendor folder is not an error", () => {
  assert.equal(
    resolveExecutable("git", {
      platform: "win32",
      env: { PATH: "C:\\Windows", LOCALAPPDATA: win32.join("C:", "Users", "dev", "AppData", "Local") },
      isFile: () => false,
      listDir: () => { throw new Error("EPERM"); },
    }),
    "git",
  );
});

test("with nothing discovered the bare name is kept", () => {
  assert.equal(resolveExecutable("gh", { platform: "linux", env: { PATH: "/nothing" }, isFile: () => false }), "gh");
});

test("resolvedExecutableDirectory reports the directory of a discovered tool", () => {
  const dir = posix.join("/custom", "bin");
  assert.equal(
    resolvedExecutableDirectory("git", {
      platform: "linux",
      env: { PATH: dir },
      isFile: only(posix.join(dir, "git")),
    }),
    dir,
  );
  assert.equal(
    resolvedExecutableDirectory("git", { platform: "linux", env: { PATH: "/nothing" }, isFile: () => false }),
    undefined,
  );
});

test("well-known directories include the tool's vendor locations", () => {
  const programFiles = win32.join("C:", "Program Files");
  const directories = wellKnownExecutableDirectories("gh", {
    platform: "win32",
    env: { ProgramFiles: programFiles, PATH: "C:\\Windows" },
  });
  assert.ok(directories.includes(win32.join(programFiles, "GitHub CLI")));
});
