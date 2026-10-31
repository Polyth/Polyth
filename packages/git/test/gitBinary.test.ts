import test from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { resolveGitBinary } from "../src/gitBinary.ts";

const only = (...paths: string[]) => (candidate: string) => paths.includes(candidate);
// Windows cases build their paths the way the resolver does for a win32
// target, whatever the host running the test.
const join = win32.join;

test("an explicit binary wins over the environment and discovery", () => {
  assert.equal(
    resolveGitBinary({
      explicit: "  /opt/custom/git  ",
      env: { POLYTH_GIT_BIN: "/env/git", PATH: "/usr/bin" },
      isFile: () => true,
    }),
    "/opt/custom/git",
  );
});

test("POLYTH_GIT_BIN overrides PATH and install discovery", () => {
  assert.equal(
    resolveGitBinary({ env: { POLYTH_GIT_BIN: "/env/git", PATH: "/usr/bin" }, isFile: () => true }),
    "/env/git",
  );
});

test("a git on PATH resolves to its absolute path", () => {
  const dir = posix.join("/custom", "bin");
  const found = resolveGitBinary({
    platform: "linux",
    env: { PATH: `${posix.join("/nope")}${posix.delimiter}${dir}` },
    isFile: only(posix.join(dir, "git")),
  });
  assert.equal(found, posix.join(dir, "git"));
});

test("quoted PATH entries are still searched", () => {
  const dir = join("C:", "Program Files", "Git", "cmd");
  const found = resolveGitBinary({
    platform: "win32",
    env: { PATH: `"${dir}"` },
    isFile: only(join(dir, "git.exe")),
  });
  assert.equal(found, join(dir, "git.exe"));
});

test("Windows discovery falls back to a standard Git install", () => {
  const root = join("C:", "Program Files");
  const git = join(root, "Git", "cmd", "git.exe");
  const found = resolveGitBinary({
    platform: "win32",
    env: { PATH: join("C:", "Windows"), ProgramFiles: root },
    isFile: only(git),
  });
  assert.equal(found, git);
});

test("Windows discovery checks the PATH before any install location", () => {
  const onPath = join("C:", "tools");
  const installed = join("C:", "Program Files", "Git", "cmd", "git.exe");
  const found = resolveGitBinary({
    platform: "win32",
    env: { PATH: onPath, ProgramFiles: join("C:", "Program Files") },
    isFile: only(join(onPath, "git.exe"), installed),
  });
  assert.equal(found, join(onPath, "git.exe"));
});

test("Windows discovery finds the newest GitHub Desktop Git bundle", () => {
  const local = join("C:", "Users", "dev", "AppData", "Local");
  const parent = join(local, "GitHubDesktop");
  const older = join(parent, "app-3.6.7", "resources", "app", "git", "cmd", "git.exe");
  const newer = join(parent, "app-3.10.0", "resources", "app", "git", "cmd", "git.exe");
  const found = resolveGitBinary({
    platform: "win32",
    env: { PATH: join("C:", "Windows"), LOCALAPPDATA: local },
    isFile: only(older, newer),
    listDir: (path) => path === parent ? ["app-3.6.7", "app-3.10.0", "packages"] : [],
  });
  assert.equal(found, newer);
});

test("a standard Git install outranks the GitHub Desktop bundle", () => {
  const local = join("C:", "Users", "dev", "AppData", "Local");
  const standard = join("C:", "Program Files", "Git", "cmd", "git.exe");
  const bundled = join(local, "GitHubDesktop", "app-9.9.9", "resources", "app", "git", "cmd", "git.exe");
  const found = resolveGitBinary({
    platform: "win32",
    env: { PATH: join("C:", "Windows"), ProgramFiles: join("C:", "Program Files"), LOCALAPPDATA: local },
    isFile: only(standard, bundled),
    listDir: (path) => path === join(local, "GitHubDesktop") ? ["app-9.9.9"] : [],
  });
  assert.equal(found, standard);
});

test("an unreadable GitHub Desktop folder is not an error", () => {
  assert.equal(
    resolveGitBinary({
      platform: "win32",
      env: { PATH: join("C:", "Windows"), LOCALAPPDATA: join("C:", "Users", "dev", "AppData", "Local") },
      isFile: () => false,
      listDir: () => { throw new Error("EPERM"); },
    }),
    "git",
  );
});

test("POSIX discovery falls back to a standard location", () => {
  assert.equal(
    resolveGitBinary({ platform: "darwin", env: { PATH: "/nothing" }, isFile: only("/opt/homebrew/bin/git") }),
    "/opt/homebrew/bin/git",
  );
});

test("with nothing discovered the bare name git is kept", () => {
  assert.equal(resolveGitBinary({ platform: "linux", env: { PATH: "/nothing" }, isFile: () => false }), "git");
});
