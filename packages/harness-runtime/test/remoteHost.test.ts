import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteFileBytes, type RemoteProcessHost } from "../src/remoteHost.ts";

// The fake host runs the remote argv locally in the requested directory, the
// way the SSH transport's raw-pipe process command does on the far side.
const host: RemoteProcessHost = {
  label: "dev@remote",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  start: async () => { throw new Error("unused"); },
  forward: async () => { throw new Error("unused"); },
  processCommand: (argv, opts) => ({ command: "sh", args: ["-c", 'cd "$0" || exit 78; exec "$@"', opts?.cwd ?? "/", ...argv] }),
};

test("readRemoteFileBytes returns a host file's exact bytes and enforces its cap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-remote-bytes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a, 0x80, 0x1a]);
  writeFileSync(join(dir, "image.png"), bytes);

  assert.deepEqual(Buffer.from(await readRemoteFileBytes(host, "image.png", { cwd: dir, maxBytes: 64 })), bytes);
  assert.deepEqual(Buffer.from(await readRemoteFileBytes(host, join(dir, "image.png"), { maxBytes: 64 })), bytes);
  await assert.rejects(readRemoteFileBytes(host, "gone.png", { cwd: dir, maxBytes: 64 }), { code: "not-found" });
  await assert.rejects(readRemoteFileBytes(host, ".", { cwd: dir, maxBytes: 64 }), { code: "not-found" });
  await assert.rejects(readRemoteFileBytes(host, "image.png", { cwd: dir, maxBytes: 4 }), { code: "too-large" });
  await assert.rejects(readRemoteFileBytes(host, "image.png", { cwd: join(dir, "missing"), maxBytes: 64 }), { code: "runtime-unavailable" });
});

test("a harness runs on the host unless its connection places it on this machine", async () => {
  const { remoteHarnessPlacement } = await import("../src/remoteHost.ts");
  const projects = new Map<string, unknown>([
    ["remote", { id: "remote", remote: { kind: "ssh", connectionId: "c1" } }],
    ["other", { id: "other", remote: { kind: "ssh", connectionId: "c2" } }],
    ["local", { id: "local" }],
  ]);
  const ssh = { host: () => host, get: (id: string) => id === "c1" ? { harnessPlacement: { claude: "local" } } : {} };
  const server = {
    projects: { get: async (id: string) => projects.get(id) },
    forSpace: () => server,
    services: { get: () => ssh },
  } as never;
  assert.equal(await remoteHarnessPlacement(server, { projectId: "remote" }, "claude"), "local");
  assert.equal(await remoteHarnessPlacement(server, { projectId: "remote" }, "codex"), "host");
  assert.equal(await remoteHarnessPlacement(server, { projectId: "other" }, "claude"), "host");
  assert.equal(await remoteHarnessPlacement(server, { projectId: "local" }, "claude"), "host");
  assert.equal(await remoteHarnessPlacement(server, { projectId: "missing" }, "claude"), "host");
  // Without the SSH package nothing can be placed anywhere but the default.
  const bare = { projects: { get: async (id: string) => projects.get(id) }, forSpace: () => bare, services: { get: () => undefined } } as never;
  assert.equal(await remoteHarnessPlacement(bare, { projectId: "remote" }, "claude"), "host");
});
