import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectService, SessionService, SpaceStorage } from "@polyth/contracts";
import { localShellCommand, type TerminalService } from "../src/index.ts";
import { terminalRoutes, TERMINAL_REMOTE_ACCESS } from "../src/serverEntry.ts";
import { listAvailableShells, type ShellDiscoveryDeps } from "../src/shellSettings.ts";

const installed = new Set(["/bin/bash", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/fish", "/bin/sh"]);
const discovery: ShellDiscoveryDeps = {
  platform: "linux",
  env: { PATH: "/usr/bin:/bin" },
  autoShell: "/usr/bin/zsh",
  readShellsFile: async () => "# /etc/shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/sbin/nologin\n/usr/bin/fish\n/opt/gone/elvish\n",
  isExecutable: async (path) => installed.has(path),
  realpath: async (path) => path === "/usr/bin/bash" ? "/bin/bash" : path,
};

test("available shells come from /etc/shells and PATH, deduplicated, auto first, placeholders dropped", async () => {
  const shells = await listAvailableShells(discovery);
  assert.deepEqual(shells, [
    { path: "/usr/bin/zsh", name: "zsh" },
    { path: "/bin/sh", name: "sh" },
    { path: "/bin/bash", name: "bash" },
    { path: "/usr/bin/fish", name: "fish" },
  ]);
});

test("an explicit shell overrides the login shell and keeps the right interactive flags", () => {
  assert.deepEqual(localShellCommand(undefined, "linux", { SHELL: "/bin/bash" }, null, "/usr/bin/fish"), { file: "/usr/bin/fish", args: ["-i"] });
  assert.deepEqual(localShellCommand("ls", "linux", { SHELL: "/bin/bash" }, null, "/usr/bin/fish"), { file: "/usr/bin/fish", args: ["-c", "ls"] });
  assert.deepEqual(localShellCommand(undefined, "linux", {}, null, "/usr/bin/elvish"), { file: "/usr/bin/elvish", args: [] });
  assert.deepEqual(localShellCommand(undefined, "win32", {}, null, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"] });
  assert.deepEqual(localShellCommand("dir", "win32", {}, null, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").args, ["-NoLogo", "-Command", "dir"]);
});

function harness(remote = false) {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-shell-"));
  const storage: SpaceStorage = { root, packageDir: (id: string) => join(root, id), path: (relative: string) => join(root, relative) } as SpaceStorage;
  const creates: Array<Record<string, unknown>> = [];
  const terminals = {
    onExit: () => ({ dispose() {} }),
    create: async (input: Record<string, unknown>) => { creates.push(input); return { id: "term-1" }; },
  } as unknown as TerminalService;
  const routes = terminalRoutes({
    projects: { get: async (id: string) => ({ id, name: "P", path: root, ...(remote ? { remote: { kind: "ssh", connectionId: "c1" } } : {}) }) } as unknown as ProjectService,
    sessions: {} as SessionService,
    terminals,
    spaceStorage: () => storage,
    shellDiscovery: discovery,
  });
  const call = async (method: string, path: string, input: Record<string, unknown> = {}) => {
    let payload: unknown;
    await routes({ req: {}, res: {}, space: { userId: "u1" }, url: new URL(`http://x${path}`), path, method, body: async () => input, json: (_status: number, data: unknown) => { payload = data; } } as never);
    return payload as Record<string, unknown>;
  };
  return { root, creates, call, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the shell setting defaults to auto, persists a valid choice and applies it to new local terminals", async () => {
  const h = harness();
  try {
    const initial = await h.call("GET", "/api/terminals/shell");
    assert.equal(initial.shell, "auto");
    assert.equal(initial.effectiveShell, "/usr/bin/zsh");
    await h.call("POST", "/api/terminals", { projectId: "p1" });
    assert.equal(h.creates[0]?.shell, undefined);

    const saved = await h.call("PUT", "/api/terminals/shell", { shell: "/usr/bin/fish" });
    assert.equal(saved.shell, "/usr/bin/fish");
    assert.equal(saved.effectiveShell, "/usr/bin/fish");
    assert.deepEqual(JSON.parse(readFileSync(join(h.root, "terminal", "shell.json"), "utf8")), { shell: "/usr/bin/fish" });
    await h.call("POST", "/api/terminals", { projectId: "p1" });
    assert.equal(h.creates[1]?.shell, "/usr/bin/fish");

    await h.call("PUT", "/api/terminals/shell", { shell: "auto" });
    await h.call("POST", "/api/terminals", { projectId: "p1" });
    assert.equal(h.creates[2]?.shell, undefined);
  } finally { h.cleanup(); }
});

test("an unknown shell is rejected and a stale stored one falls back to auto", async () => {
  const h = harness();
  try {
    await assert.rejects(() => h.call("PUT", "/api/terminals/shell", { shell: "/usr/bin/python3" }), { code: "invalid-input" });
    await assert.rejects(() => h.call("PUT", "/api/terminals/shell", { shell: "" }), { code: "invalid-input" });
    mkdirSync(join(h.root, "terminal"), { recursive: true });
    writeFileSync(join(h.root, "terminal", "shell.json"), JSON.stringify({ shell: "/opt/gone/elvish" }));
    const snapshot = await h.call("GET", "/api/terminals/shell");
    assert.equal(snapshot.shell, "/opt/gone/elvish");
    assert.equal(snapshot.effectiveShell, "/usr/bin/zsh");
    await h.call("POST", "/api/terminals", { projectId: "p1" });
    assert.equal(h.creates[0]?.shell, undefined);
  } finally { h.cleanup(); }
});

test("remote projects ignore the local shell choice", async () => {
  const h = harness(true);
  try {
    await h.call("PUT", "/api/terminals/shell", { shell: "/usr/bin/fish" });
    await h.call("POST", "/api/terminals", { projectId: "p1" });
    assert.equal(h.creates[0]?.shell, undefined);
  } finally { h.cleanup(); }
});

test("paired-device policy covers the shell setting routes", () => {
  const rules = TERMINAL_REMOTE_ACCESS.http.filter((rule) => rule.path === "/api/terminals/shell");
  assert.deepEqual(rules.map((rule) => [rule.methods, rule.mutation]), [[["GET"], false], [["PUT"], true]]);
});
