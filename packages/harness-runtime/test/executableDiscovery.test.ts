import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import {
  discoverHarnessExecutable,
  harnessExecutableChildEnv,
  mergeHarnessSearchPaths,
  wellKnownHarnessExecutableDirectories,
  windowsCmdShimTarget,
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

test("child environment can reach a Node.js installed only into ~/.local/bin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, "lib/node_modules/agent/dist", "cli.js");
  const inherited = join(root, "inherited");

  const env = await harnessExecutableChildEnv(executable, {
    env: { PATH: inherited, HOME: root },
    home: root,
    platform: "linux",
    loginShellProbe: false,
  });

  const entries = env.PATH?.split(delimiter) ?? [];
  assert.deepEqual(entries.slice(0, 2), [dirname(executable), inherited]);
  assert.ok(entries.indexOf(join(root, ".local", "bin")) > 1);
});

test("child environment removes parent-agent nesting markers without mutating the server env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-nesting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, "resolved", "polyth-test-agent");
  const inherited = {
    PATH: dirname(executable),
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_AGENT_SDK_VERSION: "test",
    KEEP_ME: "yes",
  };

  const env = await harnessExecutableChildEnv(executable, {
    env: inherited,
    loginShellProbe: false,
  });

  assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("CLAUDE"))), {});
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(inherited.CLAUDECODE, "1");
});

test("child environment can reach a tool Polyth resolved off the inherited PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await fixture(root, "resolved", "polyth-test-agent");
  await fixture(root, join(".local", "bin"), "git");
  const inherited = join(root, "inherited");
  await mkdir(inherited, { recursive: true });

  const env = await harnessExecutableChildEnv(executable, {
    env: { PATH: inherited, HOME: root, USERPROFILE: root },
    home: root,
    loginShellProbe: false,
  });

  // Git is absent from the inherited PATH; the child still gets its directory,
  // so a harness's own `git`/`ssh` calls reach the same binary the server found.
  assert.ok(env.PATH?.split(delimiter).includes(join(root, ".local", "bin")));
});

test("well-known harness directories include per-harness vendor installs", () => {
  const home = join("/home", "dev");
  const directories = wellKnownHarnessExecutableDirectories({ home });
  assert.ok(directories.includes(join(home, ".opencode", "bin")));
  assert.ok(directories.includes(join(home, ".claude", "local")));
});

test("Windows well-known directories cover the per-user installers, before system ones", () => {
  const home = join("C:", "Users", "dev");
  const local = join(home, "AppData", "Local");
  const directories = wellKnownHarnessExecutableDirectories({
    platform: "win32",
    home,
    env: { USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(home, "AppData", "Roaming"), ProgramFiles: join("C:", "Program Files") },
  });
  const at = (directory: string) => {
    const index = directories.indexOf(directory);
    assert.ok(index >= 0, `missing ${directory}`);
    return index;
  };
  const polythNpm = at(join(local, "Polyth", "npm"));
  const polythNode = at(join(local, "Polyth", "node"));
  const cursor = at(join(local, "cursor-agent"));
  at(join(local, "agy", "bin"));
  at(join(local, "omp"));
  const grok = at(join(home, ".grok", "bin"));
  const systemNode = at(join("C:", "Program Files", "nodejs"));
  assert.ok(polythNpm < polythNode && polythNode < systemNode, "Polyth's own Node.js before a system install");
  assert.ok(cursor < grok, "Cursor's `agent` before the `agent.exe` Grok ships");
  assert.ok(directories.indexOf(join(home, "scoop", "shims")) < systemNode);
});

test("Windows discovery finds agy and Cursor's agent where their installers put them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-winvendor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "AppData", "Local");
  for (const [directory, name] of [
    [join(local, "agy", "bin"), "agy.exe"],
    [join(local, "cursor-agent"), "agent.cmd"],
    [join(root, ".grok", "bin"), "agent.exe"],
    [join(local, "Polyth", "npm"), "codex.cmd"],
  ] as const) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), "", "utf8");
  }
  const options = {
    platform: "win32" as const,
    // Lower-case, as the files are named: this filesystem may be case-sensitive.
    env: { PATH: "", PATHEXT: ".exe;.cmd", USERPROFILE: root, LOCALAPPDATA: local },
    home: root,
    loginShellProbe: false,
  };
  assert.equal((await discoverHarnessExecutable("agy", options)).hit?.executablePath, join(local, "agy", "bin", "agy.exe"));
  assert.equal((await discoverHarnessExecutable("agent", options)).hit?.executablePath, join(local, "cursor-agent", "agent.cmd"));
  assert.equal((await discoverHarnessExecutable("codex", options)).hit?.executablePath, join(local, "Polyth", "npm", "codex.cmd"));
});

test("search path merge is stable and removes duplicates", () => {
  assert.deepEqual(
    mergeHarnessSearchPaths(["/one", "/two", "/one"], `/two${delimiter}/three`),
    ["/one", "/two", "/three"],
  );
});

test("a copied Windows env keeps its `Path` and hands the child one PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-pathcase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = join(root, "npm");
  await mkdir(npm, { recursive: true });
  const executable = join(npm, "polyth-test-agent.CMD");
  await writeFile(executable, "@echo off\r\n", "utf8");
  const system = join(root, "System32");

  const report = await discoverHarnessExecutable("polyth-test-agent", {
    platform: "win32",
    env: { Path: `"${npm}"`, PATHEXT: ".EXE;.CMD" },
    home: root,
    loginShellProbe: false,
  });
  assert.equal(report.hit?.executablePath, executable);

  const env = await harnessExecutableChildEnv(executable, {
    platform: "win32",
    env: { Path: [npm, system].join(delimiter), USERPROFILE: root },
    home: root,
    loginShellProbe: false,
  });
  assert.equal(env.Path, undefined);
  assert.deepEqual(env.PATH?.split(delimiter).slice(0, 2), [npm, system]);
});

test("an npm Windows shim resolves to the native program it launches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-harness-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  await mkdir(dirname(program), { recursive: true });
  await writeFile(program, "", "utf8");
  const shim = join(root, "claude.cmd");
  await writeFile(shim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*",
  ].join("\r\n"), "utf8");
  assert.equal(await windowsCmdShimTarget(shim), program);

  const script = join(root, "codex.cmd");
  await writeFile(script, [
    "IF EXIST \"%dp0%\\node.exe\" (",
    "  SET \"_prog=%dp0%\\node.exe\"",
    ")",
    "\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
  ].join("\r\n"), "utf8");
  assert.equal(await windowsCmdShimTarget(script), undefined, "a script target keeps its shim");
  const cli = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, "", "utf8");
  assert.equal(await windowsCmdShimTarget(script, { scripts: true }), cli, "asked for, the script itself (node.exe skipped)");

  const dangling = join(root, "gone.cmd");
  await writeFile(dangling, "\"%~dp0\\missing\\gone.exe\" %*", "utf8");
  assert.equal(await windowsCmdShimTarget(dangling), undefined);
});
